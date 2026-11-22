/**
 * The figure finder must (a) never send a picture that is already shown in the
 * same chat, and (b) go on to the web when the learner's library has no picture
 * that shows the main thing asked for. Scripted model, fake library, fake
 * network, fake page renderer: no live AI, no live web.
 *
 * The fixtures are modelled on the owner's "intro to hnb sx" chat (2026-11-22):
 * Sabiston 2021 p.847 Fig. 35.1 was already shown, then a request that names the
 * lactiferous sinus came back with the same card; the ductogram (p.849 Fig. 35.4)
 * and the terminal duct lobular unit (p.849 Fig. 35.5) are two different figures
 * on one page.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import type { LibraryReader } from "../src/agent/library/searcher.ts";
import type { HeadlessApi } from "../src/agent/subagents/headless.ts";
import { imageResult, runFigureFinder, type FigureFinderEnv } from "../src/agent/subagents/figure-finder.ts";
import { cardRefOf, type FigureCardRef } from "../src/core/figure-refs.ts";
import type { FigureImage, FigureResult, FigureToolInput, LibraryBook, LibraryChunk } from "../src/core/contracts.ts";
import { PNG } from "./figure-fixtures.ts";

const fixture = (name: string): string => fs.readFileSync(path.join(import.meta.dirname, "fixtures", "figures", name), "utf-8");
const CHAT = "chat_norepeat_0001";
const roots: string[] = [];
const newRoot = (): string => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-figure-norepeat-"));
	roots.push(root);
	return root;
};
after(() => {
	for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

function engine(turns: Array<[string, unknown]>[]): PiEngine {
	const steps: FauxResponseStep[] = turns.map((calls, i) =>
		fauxAssistantMessage(
			calls.map(([name, input], j) => fauxToolCall(name, input as ToolCall["arguments"], { id: `call_${i}_${j}` })),
			{ stopReason: "toolUse" },
		),
	);
	steps.push(fauxAssistantMessage("done"));
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

const ok = (body: BodyInit, type: string): Response => new Response(body, { status: 200, headers: { "content-type": type } });
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const BREAST_IMG = "https://upload.wikimedia.org/wikipedia/commons/thumb/5/5a/Breast_lactiferous_sinus.png/1000px-Breast_lactiferous_sinus.png";
const EMPTY_COMMONS = JSON.stringify({ batchcomplete: "", query: { pages: {} } });

/** A fake network that logs every URL it is asked for; anything not routed throws. */
function network(routes: Record<string, () => Response>, log: string[]): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		const url = typeof input === "string" ? input : input.toString();
		log.push(url);
		for (const [prefix, make] of Object.entries(routes)) if (url === prefix || url.startsWith(`${prefix}?`)) return make();
		throw new Error(`unrouted fetch: ${url}`);
	}) as typeof fetch;
}
const breastWeb = (log: string[]) =>
	network({ [COMMONS_API]: () => ok(fixture("commons-search-breast.json"), "application/json"), [BREAST_IMG]: () => ok(PNG, "image/png") }, log);
const emptyWeb = (log: string[]) => network({ [COMMONS_API]: () => ok(EMPTY_COMMONS, "application/json") }, log);

const sabiston = { id: "book_sab", kind: "pdf", title: "Sabiston Textbook of Surgery (2021)", fileName: "sab.pdf", pageCount: 2200 } as unknown as LibraryBook;
const chunk = (page: number, text: string): LibraryChunk => ({ index: 0, page, section: "Breast", text }) as LibraryChunk;
const P847 = chunk(847, "Figure 35.1 Cut-away anatomy of the breast: milk ducts, nipple-areolar complex, Cooper ligaments.");
const P849 = chunk(849, "Figure 35.4 Ductogram. Figure 35.5 Terminal duct lobular unit.");
const TITLE_847 = "Sabiston Textbook of Surgery (2021) p.847";
const TITLE_849 = "Sabiston Textbook of Surgery (2021) p.849";

function library(...chunks: LibraryChunk[]): FigureFinderEnv["library"] {
	const reader = {
		hasBooks: () => true,
		async search() {
			return { hits: chunks.map((c) => ({ book: sabiston, chunk: c, score: 1, via: ["keyword" as const] })), notes: [] };
		},
		read: () => ({ ok: false, error: "unused" }),
	} as unknown as LibraryReader;
	return { reader, pdfPath: (id) => `/library/${id}/source.pdf` };
}

/** A 100×400 PNG page (Photon builds it from raw RGBA), so a library page can really be cropped to a band. */
async function tallPage(): Promise<Buffer> {
	const photon = await import("@silvia-odwyer/photon-node");
	const img = new photon.PhotonImage(new Uint8Array(100 * 400 * 4).fill(200), 100, 400);
	try {
		return Buffer.from(img.get_bytes());
	} finally {
		img.free();
	}
}
const PAGE = await tallPage();

function headless(renders: number[][] = []): () => HeadlessApi {
	return () =>
		({
			available: () => true,
			renderPdfPages: async (_p: string, pages: number[]) => {
				renders.push(pages);
				return pages.map((page) => ({ page, png: PAGE }));
			},
		}) as unknown as HeadlessApi;
}

function env(over: Partial<FigureFinderEnv>): FigureFinderEnv {
	return { chatId: CHAT, cacheRoot: newRoot(), headless: headless(), ...over };
}

const request: FigureToolInput = {
	concept: "Labelled anatomy of the breast showing the lactiferous ducts, lactiferous sinus and the ampulla of the nipple",
	modality: "gross anatomy diagram",
};

/** A card the chat already shows (what a finished figure job leaves behind). */
function shownCard(id: string, over: { title: string; caption: string; keyFeature?: string; file?: string; crop?: { top: number; bottom: number }; tier?: FigureImage["tier"] }): FigureCardRef {
	const image: FigureImage = {
		file: over.file ?? "aaaaaaaaaaaaaaaaaaaaaaaa.png",
		mime: "image/png",
		tier: over.tier ?? "slides",
		source: "Your library",
		title: over.title,
		credit: "From your library: Sabiston",
		licence: "Your library copy (personal study)",
		...(over.crop ? { crop: over.crop } : {}),
	};
	const result: FigureResult = imageResult(request, image, over.caption, over.keyFeature ?? "the duct tree");
	return cardRefOf(result, id)!;
}
const FIG_35_1 = (): FigureCardRef => shownCard("m1", { title: TITLE_847, caption: "Sabiston Fig. 35.1: labelled cut-away diagram of the breast.", crop: { top: 0.05, bottom: 0.45 } });

async function run(turns: Array<[string, unknown]>[], e: FigureFinderEnv, shown: FigureCardRef[] = [], maxTurns?: number): Promise<FigureResult> {
	return runFigureFinder(request, { engine: engine(turns), env: e, shown: () => shown, ...(maxTurns ? { maxTurns } : {}) });
}

const sabistonFig351 = {
	id: "c1",
	shows: "Sabiston Fig. 35.1: labelled cut-away diagram of the breast with branching milk ducts.",
	key_feature: "the duct tree converging under the nipple",
	crop: { top: 0.05, bottom: 0.45 },
	confident: true,
};
const commonsShow = {
	id: "c1",
	shows: "Sagittal breast diagram with the lactiferous sinus and nipple ampulla labelled.",
	key_feature: "the dilated lactiferous sinus under the nipple",
	confident: true,
};

describe("a picture already shown in this chat is not sent again", () => {
	it("the same library figure (Sabiston p.847 Fig. 35.1) is not returned; the finder goes on to the web and returns that picture", async () => {
		const web: string[] = [];
		const result = await run(
			[
				[["slides_search", { query: "breast anatomy lactiferous sinus" }]],
				[["look", { id: "c1" }]],
				[["show_image", sabistonFig351]],
				[["commons_search", { query: "breast lactiferous sinus nipple ampulla" }]],
				[["look", { id: "c2" }]],
				[["show_image", { ...commonsShow, id: "c2" }]],
			],
			env({ library: library(P847), fetchImpl: breastWeb(web) }),
			[FIG_35_1()],
		);
		assert.equal(result.outcome, "image");
		assert.equal(result.image?.tier, "commons", "the web picture, not the library card again");
		assert.notEqual(result.image?.title, TITLE_847);
		assert.ok(web.includes(BREAST_IMG));
	});

	it("when the already-shown picture is the only match, nothing is sent: the result says it is the closest, and the lesson is told", async () => {
		const result = await run(
			[
				[["slides_search", { query: "breast anatomy" }]],
				[["look", { id: "c1" }]],
				[["show_image", sabistonFig351]],
				[["commons_search", { query: "breast lactiferous sinus" }]],
				[["nothing_found", { reason: "no web picture labels the sinus" }]],
			],
			env({ library: library(P847), fetchImpl: emptyWeb([]) }),
			[FIG_35_1()],
		);
		assert.notEqual(result.outcome, "image", "no card is sent a second time");
		assert.equal(result.image, undefined);
		assert.match(result.brief, /already shown/i);
		assert.match(result.brief, /Sabiston Textbook of Surgery \(2021\) p\.847/);
	});

	it("insisting on the already-shown picture ends the search with the same honest result", async () => {
		const result = await run(
			[
				[["slides_search", { query: "breast anatomy" }]],
				[["look", { id: "c1" }]],
				[["show_image", sabistonFig351]],
				[["show_image", sabistonFig351]],
			],
			env({ library: library(P847) }),
			[FIG_35_1()],
		);
		assert.notEqual(result.outcome, "image");
		assert.match(result.brief, /already shown/i);
	});

	it("a finder that runs out of steps with only the duplicate in hand still sends nothing", async () => {
		const result = await run(
			[
				[["slides_search", { query: "breast anatomy" }]],
				[["look", { id: "c1" }]],
				[["show_image", sabistonFig351]],
			],
			env({ library: library(P847) }),
			[FIG_35_1()],
			3,
		);
		assert.notEqual(result.outcome, "image");
		assert.match(result.brief, /already shown/i);
	});

	it("a link the finder gives instead still says the picture already shown is the closest", async () => {
		const web: string[] = [];
		const result = await run(
			[
				[["slides_search", { query: "breast anatomy" }]],
				[["look", { id: "c1" }]],
				[["show_image", sabistonFig351]],
				[["site_search", { source: "radiopaedia", query: "breast ducts" }]],
				[["give_links", { links: [{ id: "c2", note: "Search for breast ductography cases." }], reason: "no picture of the sinus could be shown" }]],
			],
			env({ library: library(P847), fetchImpl: emptyWeb(web) }),
			[FIG_35_1()],
		);
		assert.equal(result.outcome, "link");
		assert.match(result.brief, /already shown/i);
	});

	it("a different figure on the same page is not a duplicate (Fig. 35.5 after the ductogram Fig. 35.4, both on p.849)", async () => {
		const ductogram = shownCard("m2", { title: TITLE_849, caption: "Sabiston Fig. 35.4: ductogram.", crop: { top: 0.05, bottom: 0.4 } });
		const result = await run(
			[
				[["slides_search", { query: "terminal duct lobular unit" }]],
				[["look", { id: "c1" }]],
				[["show_image", { id: "c1", shows: "Sabiston Fig. 35.5: the terminal duct lobular unit.", key_feature: "the lobule on its terminal duct", crop: { top: 0.5, bottom: 0.9 }, confident: true }]],
			],
			env({ library: library(P849) }),
			[ductogram],
		);
		assert.equal(result.outcome, "image");
		assert.equal(result.image?.title, TITLE_849);
	});

	it("two crops of one page that do not overlap are different figures, even when no figure number is stated", async () => {
		const first = shownCard("m3", { title: TITLE_849, caption: "A ductogram.", crop: { top: 0.05, bottom: 0.4 } });
		const result = await run(
			[
				[["slides_search", { query: "tdlu" }]],
				[["look", { id: "c1" }]],
				[["show_image", { id: "c1", shows: "The lobule on its terminal duct.", key_feature: "the acini", crop: { top: 0.55, bottom: 0.9 }, confident: true }]],
			],
			env({ library: library(P849) }),
			[first],
		);
		assert.equal(result.outcome, "image");
	});

	it("an outside picture already shown (same cached file) is a duplicate too", async () => {
		// The first run shows the Commons picture; its card is then "already in the chat" for the second.
		const cacheRoot = newRoot();
		const first = await run(
			[
				[["commons_search", { query: "breast lactiferous sinus" }]],
				[["look", { id: "c1" }]],
				[["show_image", commonsShow]],
			],
			env({ cacheRoot, fetchImpl: breastWeb([]) }),
		);
		assert.equal(first.outcome, "image");
		const card = cardRefOf(first, "m9")!;
		const second = await run(
			[
				[["commons_search", { query: "breast lactiferous sinus" }]],
				[["look", { id: "c1" }]],
				[["show_image", commonsShow]],
			],
			env({ cacheRoot, fetchImpl: breastWeb([]) }),
			[card],
		);
		assert.notEqual(second.outcome, "image");
		assert.match(second.brief, /already shown/i);
	});

	it("with nothing shown yet, nothing changes: the library picture is returned", async () => {
		const result = await run(
			[
				[["slides_search", { query: "breast anatomy" }]],
				[["look", { id: "c1" }]],
				[["show_image", sabistonFig351]],
			],
			env({ library: library(P847) }),
			[],
		);
		assert.equal(result.outcome, "image");
		assert.equal(result.image?.title, TITLE_847);
		assert.ok(result.image?.crop && result.image.crop.top < 0.05 && result.image.crop.bottom > 0.45, "the band the card shows is recorded so a later request can tell crops apart");
	});
});

describe("a library picture that misses the main thing asked goes on to the web", () => {
	const sinusMissing = {
		id: "c1",
		shows: "Sabiston Fig. 35.1: labelled cut-away of the breast with branching milk ducts.",
		key_feature: "the duct tree converging under the nipple",
		not_shown: "The lactiferous sinus and nipple ampulla are not labelled.",
		confident: true,
	};

	it("shows the web picture that does show the lactiferous sinus, not the library page that lacks it", async () => {
		const web: string[] = [];
		const result = await run(
			[
				[["slides_search", { query: "breast lactiferous sinus" }]],
				[["look", { id: "c1" }]],
				[["show_image", sinusMissing]],
				[["commons_search", { query: "lactiferous sinus nipple ampulla" }]],
				[["look", { id: "c2" }]],
				[["show_image", { ...commonsShow, id: "c2" }]],
			],
			env({ library: library(P847), fetchImpl: breastWeb(web) }),
		);
		assert.equal(result.outcome, "image");
		assert.equal(result.image?.tier, "commons");
		assert.ok(web.includes(BREAST_IMG), "the web picture was fetched");
	});

	it("when the web has nothing better, the partial library picture is shown with what it lacks said plainly", async () => {
		const result = await run(
			[
				[["slides_search", { query: "breast lactiferous sinus" }]],
				[["look", { id: "c1" }]],
				[["show_image", sinusMissing]],
				[["commons_search", { query: "lactiferous sinus" }]],
				[["nothing_found", { reason: "no web picture labels the sinus" }]],
			],
			env({ library: library(P847), fetchImpl: emptyWeb([]) }),
		);
		assert.equal(result.outcome, "image");
		assert.equal(result.image?.title, TITLE_847);
		assert.match(result.notShown ?? "", /sinus/);
	});

	it("the partial library picture is also the fallback when the finder never decides after the web search", async () => {
		const result = await run(
			[
				[["slides_search", { query: "breast lactiferous sinus" }]],
				[["look", { id: "c1" }]],
				[["show_image", sinusMissing]],
				[["commons_search", { query: "lactiferous sinus" }]],
			],
			env({ library: library(P847), fetchImpl: emptyWeb([]) }),
			[],
			4,
		);
		assert.equal(result.outcome, "image");
		assert.equal(result.image?.title, TITLE_847);
	});

	it("when it is only a minor detail the finder says so by confirming, and the library picture is shown without a web search", async () => {
		const web: string[] = [];
		const result = await run(
			[
				[["slides_search", { query: "breast lactiferous sinus" }]],
				[["look", { id: "c1" }]],
				[["show_image", sinusMissing]],
				[["show_image", sinusMissing]],
			],
			env({ library: library(P847), fetchImpl: breastWeb(web) }),
		);
		assert.equal(result.outcome, "image");
		assert.equal(result.image?.title, TITLE_847);
		assert.deepEqual(web, [], "no web request was made");
	});

	it("a library picture that shows what was asked (nothing lacking) is returned straight away, library first", async () => {
		const web: string[] = [];
		const result = await run(
			[
				[["slides_search", { query: "breast anatomy" }]],
				[["look", { id: "c1" }]],
				[["show_image", { id: "c1", shows: "Sabiston Fig. 35.1.", key_feature: "the duct tree", confident: true }]],
			],
			env({ library: library(P847), fetchImpl: breastWeb(web) }),
		);
		assert.equal(result.outcome, "image");
		assert.equal(result.image?.tier, "slides");
		assert.deepEqual(web, [], "the web was never touched");
	});

	it("once the web has been tried, a partial library picture is shown without being held back again", async () => {
		const result = await run(
			[
				[["commons_search", { query: "lactiferous sinus" }], ["slides_search", { query: "lactiferous sinus" }]],
				[["look", { id: "c1" }]],
				[["show_image", sinusMissing]],
			],
			env({ library: library(P847), fetchImpl: emptyWeb([]) }),
		);
		assert.equal(result.outcome, "image");
		assert.equal(result.image?.tier, "slides");
	});

	it("a library picture the finder is not confident of also goes on to the web first", async () => {
		const result = await run(
			[
				[["slides_search", { query: "breast lactiferous sinus" }]],
				[["look", { id: "c1" }]],
				[["show_image", { id: "c1", shows: "Maybe the breast.", key_feature: "the ducts", confident: false }]],
				[["commons_search", { query: "lactiferous sinus" }]],
				[["look", { id: "c2" }]],
				[["show_image", { ...commonsShow, id: "c2" }]],
			],
			env({ library: library(P847), fetchImpl: breastWeb([]) }),
		);
		assert.equal(result.outcome, "image");
		assert.equal(result.image?.tier, "commons");
	});

	it("a partial outside picture is shown straight away, as before (only library picks are held back)", async () => {
		const result = await run(
			[
				[["commons_search", { query: "lactiferous sinus" }]],
				[["look", { id: "c1" }]],
				[["show_image", { ...commonsShow, not_shown: "the nipple ampulla is not labelled" }]],
			],
			env({ fetchImpl: breastWeb([]) }),
		);
		assert.equal(result.outcome, "image");
		assert.equal(result.notShown, "the nipple ampulla is not labelled");
	});
});
