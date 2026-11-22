/**
 * When the learner's library has no picture that shows the main thing asked, the
 * finder goes on to the web sources and prefers a web picture that does show it
 * (owner request 2026-11-22). Scripted model, fake library, fake network, fake page
 * renderer: no live AI, no live web.
 *
 * The fixtures are modelled on the owner's "intro to hnb sx" chat: a second request
 * for the labelled lactiferous sinus whose library candidate (Sabiston p.847 Fig. 35.1)
 * does not label it. A picture that is already in the chat may be shown again when it
 * does show what was asked: there is no no-repeat rule.
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
import { runFigureFinder, type FigureFinderEnv } from "../src/agent/subagents/figure-finder.ts";
import type { FigureResult, FigureToolInput, LibraryBook, LibraryChunk } from "../src/core/contracts.ts";
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
const TITLE_847 = "Sabiston Textbook of Surgery (2021) p.847";

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

function headless(renders: number[][] = []): () => HeadlessApi {
	return () =>
		({
			available: () => true,
			renderPdfPages: async (_p: string, pages: number[]) => {
				renders.push(pages);
				return pages.map((page) => ({ page, png: Buffer.from(PNG) }));
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

async function run(turns: Array<[string, unknown]>[], e: FigureFinderEnv, maxTurns?: number): Promise<FigureResult> {
	return runFigureFinder(request, { engine: engine(turns), env: e, ...(maxTurns ? { maxTurns } : {}) });
}

const commonsShow = {
	id: "c1",
	shows: "Sagittal breast diagram with the lactiferous sinus and nipple ampulla labelled.",
	key_feature: "the dilated lactiferous sinus under the nipple",
	confident: true,
};

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

	it("a library picture that already appeared in the chat is shown again when it does show what was asked", async () => {
		const turns: Array<[string, unknown]>[] = [
			[["slides_search", { query: "breast anatomy" }]],
			[["look", { id: "c1" }]],
			[["show_image", { id: "c1", shows: "Sabiston Fig. 35.1.", key_feature: "the duct tree", confident: true }]],
		];
		const cacheRoot = newRoot();
		const first = await run(turns, env({ cacheRoot, library: library(P847) }));
		const again = await run(turns, env({ cacheRoot, library: library(P847) }));
		assert.equal(again.outcome, "image");
		assert.equal(again.image?.file, first.image?.file);
	});
});
