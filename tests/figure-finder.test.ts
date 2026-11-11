/**
 * The figure finder (agent/subagents/figure-finder.ts) end to end with a scripted
 * model, a fake network, a fake library and a fake page renderer. No live fetching.
 *
 * What is pinned: the order the sources are tried, that a picture is shown only
 * after it was looked at AND carries a reusable licence AND the model is
 * confident; that anything else becomes a link; that a URL can only be one a tool
 * returned; that journals are never fetched; that a picture is fetched once per
 * session; and that a blocked site degrades to a link.
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
import { SLIDE_DPI, runFigureFinder, type FigureFinderEnv } from "../src/agent/subagents/figure-finder.ts";
import { readCachedFigure } from "../src/agent/figures/cache.ts";
import type { FigureResult } from "../src/core/contracts.ts";
import type { LibraryBook, LibraryChunk } from "../src/core/contracts.ts";
import type { SearchProvider } from "../src/core/search.ts";
import { PNG } from "./figure-fixtures.ts";

const fixture = (name: string): string => fs.readFileSync(path.join(import.meta.dirname, "fixtures", "figures", name), "utf-8");
const CHAT = "chat_figtest_0001";
const roots: string[] = [];
const newRoot = (): string => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-figure-finder-"));
	roots.push(root);
	return root;
};
after(() => {
	for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

/** One scripted model turn: tool calls (ids are assigned c1.. by the finder, in order). */
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

function network(routes: Record<string, () => Response>, log: string[]): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		const url = typeof input === "string" ? input : input.toString();
		log.push(url);
		for (const [prefix, make] of Object.entries(routes)) if (url === prefix || url.startsWith(`${prefix}?`)) return make();
		throw new Error(`unrouted fetch: ${url}`);
	}) as typeof fetch;
}

const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const COMMONS_IMG = "https://upload.wikimedia.org/wikipedia/commons/thumb/8/81/Apical_pneumothorax.png/1000px-Apical_pneumothorax.png";

const slideBook = { id: "book_1", kind: "slidescribe", title: "Acute chest pain", fileName: "acp.pdf", pageCount: 20 } as unknown as LibraryBook;
const slideChunk = { index: 0, page: 7, section: "Pneumothorax", text: "Slide 7: Pneumothorax. On the slide: an erect chest X-ray with a left apical visceral pleural line." } as LibraryChunk;

function fakeLibrary(): LibraryReader {
	return {
		hasBooks: () => true,
		async search() {
			return { hits: [{ book: slideBook, chunk: slideChunk, score: 1, via: ["keyword" as const] }], notes: [] };
		},
		read: () => ({ ok: false, error: "unused" }),
	} as unknown as LibraryReader;
}

function fakeHeadless(renders: Array<{ path: string; pages: number[]; dpi?: number }>): () => HeadlessApi {
	return () =>
		({
			available: () => true,
			unavailableReason: () => null,
			runDemo: async () => ({ consoleErrors: [], pageErrors: [], failedRequests: [], ok: true }),
			renderSvg: async () => Buffer.from(PNG),
			renderPdfPages: async (pdfPath: string, pages: number[], opts?: { dpi?: number }) => {
				renders.push({ path: pdfPath, pages, dpi: opts?.dpi });
				return pages.map((page) => ({ page, png: Buffer.from(PNG) }));
			},
		}) as HeadlessApi;
}

function env(over: Partial<FigureFinderEnv> & { cacheRoot: string }): FigureFinderEnv {
	return { chatId: CHAT, headless: fakeHeadless([]), ...over };
}

const input = { concept: "left apical pneumothorax on an erect chest X-ray", modality: "chest X-ray" };
const COMMONS = () => ok(fixture("commons-search.json"), "application/json");
const COMMONS_IMAGE = () => ok(PNG, "image/png");

async function run(turns: Array<[string, unknown]>[], e: FigureFinderEnv): Promise<FigureResult> {
	return runFigureFinder(input, { engine: engine(turns), env: e });
}

describe("the learner's own slides come first", () => {
	it("renders the slide, shows it with the lecture name, and caches it", async () => {
		const cacheRoot = newRoot();
		const renders: Array<{ path: string; pages: number[]; dpi?: number }> = [];
		const e = env({
			cacheRoot,
			library: { reader: fakeLibrary(), pdfPath: (id) => `/library/${id}/source.pdf` },
			headless: fakeHeadless(renders),
		});
		const turns: Array<[string, unknown]>[] = [
			[["slides_search", { query: "pneumothorax chest x-ray" }]],
			[["look", { id: "c1" }]],
			[["show_image", { id: "c1", shows: "An erect chest X-ray with a left apical pneumothorax.", key_feature: "the visceral pleural line with no lung markings beyond it", confident: true }]],
		];
		const result = await run(turns, e);
		assert.equal(result.outcome, "image");
		assert.equal(result.image?.tier, "slides");
		assert.equal(result.image?.source, "Your lecture slides");
		assert.equal(result.image?.title, "Acute chest pain, slide 7");
		assert.equal(result.image?.licence, "Your own lecture material");
		assert.equal(result.image?.credit, "From your library: Acute chest pain");
		assert.equal(result.caption, "An erect chest X-ray with a left apical pneumothorax.");
		assert.match(result.brief, /shown in the lesson \(it is not drawn\)/);
		assert.match(result.brief, /Key feature to point at: the visceral pleural line/);
		assert.deepEqual(renders, [{ path: "/library/book_1/source.pdf", pages: [7], dpi: SLIDE_DPI }]);
		assert.ok(readCachedFigure(cacheRoot, CHAT, result.image!.file), "the slide image is on disk for the card");

		// The same slide again in the same session: served from the cache, not re-rendered.
		const again = await run(turns, e);
		assert.equal(again.image?.file, result.image?.file);
		assert.equal(renders.length, 1, "rendered once per session");
	});
});

describe("a textbook page from the library", () => {
	it("is credited as the learner's library copy, never as their own lecture material", async () => {
		// Live case (2026-11-12): a Schwartz textbook page was labelled "Your own lecture material".
		const book = { id: "book_2", kind: "pdf", title: "Schwartz's Principles of Surgery", fileName: "s.pdf", pageCount: 2000 } as unknown as LibraryBook;
		const reader = {
			hasBooks: () => true,
			async search() {
				return { hits: [{ book, chunk: { index: 0, page: 1288, section: "Colon", text: "Figure 29-1. Arterial blood supply to the colon." }, score: 1, via: ["keyword" as const] }], notes: [] };
			},
			read: () => ({ ok: false, error: "unused" }),
		} as unknown as LibraryReader;
		const e = env({ cacheRoot: newRoot(), library: { reader, pdfPath: (id) => `/library/${id}/source.pdf` }, headless: fakeHeadless([]) });
		const result = await run(
			[
				[["slides_search", { query: "colon arterial supply" }]],
				[["look", { id: "c1" }]],
				[["show_image", { id: "c1", shows: "Schwartz Figure 29-1.", key_feature: "the marginal artery", confident: true }]],
			],
			e,
		);
		assert.equal(result.image?.source, "Your library");
		assert.equal(result.image?.licence, "Your library copy (personal study)");
		assert.doesNotMatch(result.brief, /lecture material/);
	});
});

describe("cropping a library page to its figure", () => {
	/** A 100×400 PNG page (Photon builds it from raw RGBA). */
	async function tallPage(): Promise<Buffer> {
		const photon = await import("@silvia-odwyer/photon-node");
		const img = new photon.PhotonImage(new Uint8Array(100 * 400 * 4).fill(200), 100, 400);
		try {
			return Buffer.from(img.get_bytes());
		} finally {
			img.free();
		}
	}
	async function dims(bytes: Uint8Array): Promise<[number, number]> {
		const photon = await import("@silvia-odwyer/photon-node");
		const img = photon.PhotonImage.new_from_byteslice(bytes);
		try {
			return [img.get_width(), img.get_height()];
		} finally {
			img.free();
		}
	}
	function pageEnv(cacheRoot: string, page: Buffer, fetchImpl?: typeof fetch): FigureFinderEnv {
		const headless = () =>
			({ available: () => true, renderPdfPages: async (_p: string, pages: number[]) => pages.map((n) => ({ page: n, png: page })) }) as unknown as HeadlessApi;
		return env({ cacheRoot, library: { reader: fakeLibrary(), pdfPath: (id) => `/library/${id}/source.pdf` }, headless, fetchImpl });
	}
	const show = (crop: unknown): Array<[string, unknown]>[] => [
		[["slides_search", { query: "pneumothorax" }]],
		[["look", { id: "c1" }]],
		[["show_image", { id: "c1", shows: "Figure 3-2.", key_feature: "the pleural line", confident: true, crop }]],
	];

	it("shows only the band holding the figure, with a safety margin, cached beside the page", async () => {
		const cacheRoot = newRoot();
		const result = await run(show({ top: 0.1, bottom: 0.4 }), pageEnv(cacheRoot, await tallPage()));
		assert.equal(result.outcome, "image");
		const shown = readCachedFigure(cacheRoot, CHAT, result.image!.file)!;
		const [w, h] = await dims(shown.bytes);
		assert.equal(w, 100, "full width");
		// 0.07..0.43 of 400 px (the 0.03 margin on each side).
		assert.ok(h >= 140 && h <= 148, `band height ${h}`);
	});

	it("shows the whole page when the band is too thin or covers everything", async () => {
		for (const crop of [{ top: 0.5, bottom: 0.52 }, { top: 0, bottom: 1 }]) {
			const cacheRoot = newRoot();
			const result = await run(show(crop), pageEnv(cacheRoot, await tallPage()));
			const [, h] = await dims(readCachedFigure(cacheRoot, CHAT, result.image!.file)!.bytes);
			assert.equal(h, 400, JSON.stringify(crop));
		}
	});

	it("never crops an outside picture (its licence may forbid changes)", async () => {
		const cacheRoot = newRoot();
		const result = await run(
			[
				[["commons_search", { query: "pneumothorax" }]],
				[["look", { id: "c1" }]],
				[["show_image", { id: "c1", shows: "Apical pneumothorax.", key_feature: "the apex", confident: true, crop: { top: 0.1, bottom: 0.4 } }]],
			],
			env({ cacheRoot, fetchImpl: network({ [COMMONS_API]: COMMONS, [COMMONS_IMG]: COMMONS_IMAGE }, []) }),
		);
		assert.deepEqual(readCachedFigure(cacheRoot, CHAT, result.image!.file)!.bytes, Uint8Array.from(PNG));
	});
});

describe("open sources", () => {
	it("shows a Commons picture with its credit, licence and source link, and fetches it once per session", async () => {
		const cacheRoot = newRoot();
		const log: string[] = [];
		const e = env({ cacheRoot, fetchImpl: network({ [COMMONS_API]: COMMONS, [COMMONS_IMG]: COMMONS_IMAGE }, log) });
		const turns: Array<[string, unknown]>[] = [
			[["commons_search", { query: "pneumothorax chest x-ray" }]],
			[["look", { id: "c1" }]],
			[["show_image", { id: "c1", shows: "Apical pneumothorax on CT and chest X-ray.", key_feature: "the pleural line at the apex", confident: true }]],
		];
		const result = await run(turns, e);
		assert.equal(result.outcome, "image");
		assert.equal(result.image?.tier, "commons");
		assert.equal(result.image?.licence, "CC BY-SA 4.0");
		assert.equal(result.image?.licenceUrl, "https://creativecommons.org/licenses/by-sa/4.0");
		assert.equal(result.image?.credit, "Jane Roe, via Wikimedia Commons");
		assert.equal(result.image?.sourceUrl, "https://commons.wikimedia.org/wiki/File:Apical_pneumothorax_shown_on_CT_and_chest_X-ray.png");
		assert.equal(result.image?.mime, "image/png");
		assert.equal(log.filter((u) => u === COMMONS_IMG).length, 1);

		await run(turns, e);
		assert.equal(log.filter((u) => u === COMMONS_IMG).length, 1, "the picture was not fetched again in the same session");
	});

	it("a doubtful match becomes a link, never a picture", async () => {
		const log: string[] = [];
		const e = env({ cacheRoot: newRoot(), fetchImpl: network({ [COMMONS_API]: COMMONS, [COMMONS_IMG]: COMMONS_IMAGE }, log) });
		const result = await run(
			[
				[["commons_search", { query: "pneumothorax" }]],
				[["look", { id: "c1" }]],
				[["show_image", { id: "c1", shows: "Possibly a pneumothorax.", key_feature: "the apex", confident: false }]],
			],
			e,
		);
		assert.equal(result.outcome, "link");
		assert.equal(result.image, undefined);
		assert.equal(result.links[0]?.url, "https://commons.wikimedia.org/wiki/File:Apical_pneumothorax_shown_on_CT_and_chest_X-ray.png");
		assert.match(result.links[0]!.note, /Look for: the apex/);
		assert.match(result.brief, /not confident/);
		assert.match(result.brief, /Do not draw it/);
	});

	it("a picture with no reusable licence is linked even when the model is sure of it", async () => {
		const log: string[] = [];
		const e = env({
			cacheRoot: newRoot(),
			fetchImpl: network(
				{
					[COMMONS_API]: COMMONS,
					"https://upload.wikimedia.org/wikipedia/commons/thumb/b/b2/Pneumothorax_unfree.jpg/1000px-Pneumothorax_unfree.jpg": COMMONS_IMAGE,
				},
				log,
			),
		});
		const result = await run(
			[
				[["commons_search", { query: "pneumothorax" }]],
				[["look", { id: "c2" }]],
				[["show_image", { id: "c2", shows: "Pneumothorax.", key_feature: "the line", confident: true }]],
			],
			e,
		);
		assert.equal(result.outcome, "link");
		assert.match(result.brief, /no reusable licence/);
	});

	it("will not show a picture it has not looked at", async () => {
		const log: string[] = [];
		const e = env({ cacheRoot: newRoot(), fetchImpl: network({ [COMMONS_API]: COMMONS }, log) });
		const result = await run(
			[
				[["commons_search", { query: "pneumothorax" }]],
				[["show_image", { id: "c1", shows: "x", key_feature: "y", confident: true }]],
				[["nothing_found", { reason: "ran out of turns" }]],
			],
			e,
		);
		assert.equal(result.outcome, "none", "the premature show_image was refused; the later nothing_found decided");
		assert.match(result.brief, /ran out of turns/);
	});

	it("reads an open-access article's figures from Europe PMC and shows one under the article's licence", async () => {
		const log: string[] = [];
		const IMG = "https://europepmc.org/articles/PMC13676449/bin/cureus-0018-f1.jpg";
		const e = env({
			cacheRoot: newRoot(),
			fetchImpl: network(
				{
					"https://www.ebi.ac.uk/europepmc/webservices/rest/search": () => ok(fixture("europepmc-search.json"), "application/json"),
					"https://www.ebi.ac.uk/europepmc/webservices/rest/PMC13676449/fullTextXML": () => ok(fixture("europepmc-fulltext.xml"), "application/xml"),
					[IMG]: COMMONS_IMAGE,
				},
				log,
			),
		});
		const result = await run(
			[
				[["europepmc_search", { query: "pneumothorax" }]],
				[["europepmc_figures", { id: "c1" }]],
				[["look", { id: "c4" }]],
				[["show_image", { id: "c4", shows: "Radiograph with a left apical pneumothorax.", key_feature: "the arrow at the apex", confident: true }]],
			],
			e,
		);
		assert.equal(result.outcome, "image");
		assert.equal(result.image?.tier, "open-journal");
		assert.equal(result.image?.licence, "CC BY");
		assert.equal(result.image?.sourceUrl, "https://europepmc.org/article/PMC/13676449");
		assert.match(result.image!.title, /Figure 1$/);
	});
});

describe("fewer steps, honest partial matches", () => {
	it("one look compares several candidates (a slide and a Commons picture) and either can then be shown", async () => {
		const log: string[] = [];
		const renders: Array<{ path: string; pages: number[]; dpi?: number }> = [];
		const e = env({
			cacheRoot: newRoot(),
			library: { reader: fakeLibrary(), pdfPath: (id) => `/library/${id}/source.pdf` },
			headless: fakeHeadless(renders),
			fetchImpl: network({ [COMMONS_API]: COMMONS, [COMMONS_IMG]: COMMONS_IMAGE }, log),
		});
		const result = await run(
			[
				[["slides_search", { query: "pneumothorax" }]],
				[["commons_search", { query: "pneumothorax" }]],
				[["look", { ids: ["c1", "c2"] }]],
				[["show_image", { id: "c2", shows: "Apical pneumothorax on CT and chest X-ray.", key_feature: "the pleural line at the apex", confident: true }]],
			],
			e,
		);
		assert.equal(result.outcome, "image", "both were seen in the one look, so the second may be shown");
		assert.equal(result.image?.tier, "commons");
		assert.equal(renders.length, 1, "the slide was rendered in the same look");
		assert.equal(log.filter((u) => u === COMMONS_IMG).length, 1);
	});

	it("a look over a page and a picture still shows the picture and says why the page cannot be seen", async () => {
		const e = env({ cacheRoot: newRoot(), fetchImpl: network({ [COMMONS_API]: COMMONS, [COMMONS_IMG]: COMMONS_IMAGE }, []) });
		const result = await run(
			[
				[["commons_search", { query: "pneumothorax" }]],
				[["look", { ids: ["c1", "c99"] }]],
				[["show_image", { id: "c1", shows: "Apical pneumothorax.", key_feature: "the apex", confident: true }]],
			],
			e,
		);
		assert.equal(result.outcome, "image");
	});

	it("shows the best picture with what it lacks, instead of a link, when it covers the core of the concept", async () => {
		// Live case (2026-11-12): the finder looked at a CC-licensed OpenStax peritoneum drawing and the
		// learner's own First Aid page, judged each a partial match, and gave only a link.
		const e = env({ cacheRoot: newRoot(), fetchImpl: network({ [COMMONS_API]: COMMONS, [COMMONS_IMG]: COMMONS_IMAGE }, []) });
		const result = await run(
			[
				[["commons_search", { query: "pneumothorax" }]],
				[["look", { id: "c1" }]],
				[["show_image", { id: "c1", shows: "Apical pneumothorax on CT and chest X-ray.", key_feature: "the pleural line at the apex", not_shown: "the mediastinal shift asked for", confident: true }]],
			],
			e,
		);
		assert.equal(result.outcome, "image");
		assert.equal(result.notShown, "the mediastinal shift asked for");
		assert.match(result.brief, /It does not show: the mediastinal shift asked for/);
		assert.match(result.brief, /never claim the picture shows it/);
	});

	it("a blank not_shown is dropped", async () => {
		const e = env({ cacheRoot: newRoot(), fetchImpl: network({ [COMMONS_API]: COMMONS, [COMMONS_IMG]: COMMONS_IMAGE }, []) });
		const result = await run(
			[
				[["commons_search", { query: "pneumothorax" }]],
				[["look", { id: "c1" }]],
				[["show_image", { id: "c1", shows: "Apical pneumothorax.", key_feature: "the apex", not_shown: "  ", confident: true }]],
			],
			e,
		);
		assert.equal(result.notShown, undefined);
		assert.doesNotMatch(result.brief, /does not show/);
	});
});

describe("links: journals, blocked sites, and ids", () => {
	const provider = (hits: Array<{ title: string; url: string; snippet: string }>, seen: string[] = []): (() => SearchProvider) => () => ({
		id: "tavily",
		async search(query) {
			seen.push(query);
			return hits;
		},
	});

	it("a journal is linked with a one-line note, and never fetched", async () => {
		const log: string[] = [];
		const seen: string[] = [];
		const e = env({
			cacheRoot: newRoot(),
			fetchImpl: network({}, log),
			search: provider(
				[
					{ title: "Spontaneous Pneumothorax", url: "https://www.nejm.org/doi/full/10.1056/NEJMicm1", snippet: "Images in Clinical Medicine" },
					{ title: "Not a journal", url: "https://example.com/pneumothorax", snippet: "" },
				],
				seen,
			),
		});
		const result = await run(
			[
				[["site_search", { source: "journal", query: "pneumothorax" }]],
				[["page_images", { id: "c1" }]],
				[["give_links", { links: [{ id: "c1", note: "The chest film in the first panel shows the pleural line." }], reason: "journal figures are copyrighted" }]],
			],
			e,
		);
		assert.equal(result.outcome, "link");
		assert.deepEqual(result.links, [
			{ title: "Spontaneous Pneumothorax", url: "https://www.nejm.org/doi/full/10.1056/NEJMicm1", source: "High-tier journal", note: "The chest film in the first panel shows the pleural line." },
		]);
		assert.deepEqual(log, [], "no network call at all for a journal");
		assert.match(seen[0]!, /site:nejm\.org/);
		assert.match(result.brief, /Do not draw it/);
	});

	it("Radiopaedia: a blocked case page falls back to the link, with the search link always on offer", async () => {
		const log: string[] = [];
		const CASE = "https://radiopaedia.org/cases/tension-pneumothorax";
		const e = env({
			cacheRoot: newRoot(),
			fetchImpl: network({ [CASE]: () => new Response("", { status: 406 }) }, log),
			search: provider([{ title: "Tension pneumothorax | Radiopaedia", url: CASE, snippet: "" }]),
		});
		const result = await run(
			[
				[["site_search", { source: "radiopaedia", query: "tension pneumothorax" }]],
				[["page_images", { id: "c2" }]],
				[["give_links", { links: [{ id: "c2", note: "Mediastinal shift away from the pneumothorax on the first image." }], reason: "Radiopaedia blocks automated downloads" }]],
			],
			e,
		);
		assert.deepEqual(log, [CASE], "one polite attempt, then the link");
		assert.equal(result.outcome, "link");
		assert.equal(result.links[0]?.url, CASE);
		assert.equal(result.links[0]?.source, "Radiopaedia");
	});

	it("without a search engine Radiopaedia still offers its own search page as a link", async () => {
		const e = env({ cacheRoot: newRoot(), fetchImpl: network({}, []) });
		const result = await run(
			[
				[["site_search", { source: "radiopaedia", query: "tension pneumothorax" }]],
				[["give_links", { links: [{ id: "c1", note: "Look at the first case with a mediastinal shift." }], reason: "web search is off" }]],
			],
			e,
		);
		assert.equal(result.outcome, "link");
		assert.equal(result.links[0]?.url, "https://radiopaedia.org/search?q=tension+pneumothorax&scope=all");
	});

	it("a URL the model writes itself is never accepted: only ids from tools", async () => {
		const e = env({ cacheRoot: newRoot(), fetchImpl: network({}, []) });
		const result = await run(
			[
				[["give_links", { links: [{ id: "https://evil.example/x", note: "free picture" }], reason: "made up" }]],
				[["give_links", { links: [{ id: "c99", note: "nothing" }], reason: "made up" }]],
				[["nothing_found", { reason: "no valid candidates" }]],
			],
			e,
		);
		assert.equal(result.outcome, "none");
		assert.deepEqual(result.links, []);
	});

	it("a lecture slide the model is unsure of is not shown, and no link is invented for it", async () => {
		const e = env({
			cacheRoot: newRoot(),
			library: { reader: fakeLibrary(), pdfPath: () => "/x.pdf" },
		});
		const result = await run(
			[
				[["slides_search", { query: "pneumothorax" }]],
				[["look", { id: "c1" }]],
				[["show_image", { id: "c1", shows: "Maybe a pneumothorax.", key_feature: "the apex", confident: false }]],
			],
			e,
		);
		assert.equal(result.outcome, "none");
		assert.match(result.brief, /Acute chest pain, slide 7/);
	});

	it("ends honestly when the model never decides", async () => {
		const e = env({ cacheRoot: newRoot() });
		const result = await runFigureFinder(input, { engine: engine([[["slides_search", { query: "x" }]]]), env: e, maxTurns: 1 });
		assert.equal(result.outcome, "none");
		assert.match(result.brief, /ended without a decision/);
	});
});
