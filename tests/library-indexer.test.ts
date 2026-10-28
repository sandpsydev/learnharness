/**
 * The indexer (agent/library/indexer.ts) end to end on tiny generated PDFs:
 * text mode, the vision pass (faux engine + fake renderer), the embedding
 * fallbacks, the SlideScribe path, abort, and the "scanned PDF" error.
 * No network, no model weights: embeddings come from a deterministic fake.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { embedBook, indexNoteBook, indexPdfBook, type IndexerDeps } from "../src/agent/library/indexer.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { HeadlessApi } from "../src/agent/subagents/headless.ts";
import type { LibraryEmbedder } from "../src/core/library.ts";
import type { LibraryStore } from "../src/core/ports.ts";
import { createLibraryStore } from "../src/store/library.ts";
import { fakeEmbedder, makePdf, makeSlideScribeNote, type FixturePage } from "./library-fixtures.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001", "hex");

function fauxVision(answers: string[]): PiEngine & { calls: () => number } {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	let calls = 0;
	faux.setResponses(answers.map((a) => () => { calls++; return fauxAssistantMessage(a); }));
	return { model: faux.getModel(), streamFn: faux.streamSimple, calls: () => calls };
}

function fakeHeadless(failRender = false): HeadlessApi & { rendered: number[][] } {
	const rendered: number[][] = [];
	return {
		rendered,
		available: () => true,
		unavailableReason: () => null,
		runDemo: async () => { throw new Error("unused"); },
		renderSvg: async () => { throw new Error("unused"); },
		renderPdfPages: async (_p, pages) => {
			rendered.push([...pages]);
			if (failRender) throw new Error("render exploded");
			return pages.map((page) => ({ page, png: PNG }));
		},
	};
}

describe("indexer", () => {
	let root: string;
	let store: LibraryStore;
	before(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-indexer-"));
		store = createLibraryStore(path.join(root, "library"));
	});
	after(() => fs.rmSync(root, { recursive: true, force: true }));

	function newPdfBook(pages: FixturePage[], mode: "text" | "vision", outline = [] as Parameters<typeof makePdf>[1]) {
		return store.createBook(
			{ kind: "pdf", title: `Book ${Math.random().toString(36).slice(2, 6)}`, fileName: "b.pdf", pageCount: pages.length, mode, toc: [], visionPages: [] },
			{ pdf: makePdf(pages, outline) },
		);
	}
	const deps = (over: Partial<IndexerDeps> = {}): IndexerDeps => ({ store, embedder: fakeEmbedder(), vision: null, ...over });

	it("text mode: page chunks, the outline, vectors, and a clean 'ready' record", async () => {
		const book = newPdfBook(
			[{ lines: ["Loop diuretics", "Furosemide blocks NKCC2 in the thick ascending limb."] }, { lines: ["Insulin lowers glucose."] }, { lines: ["Aortic stenosis causes a systolic murmur."] }],
			"text",
			[{ title: "Renal", page: 1, children: [{ title: "Diuretics", page: 1 }] }, { title: "Endocrine", page: 2 }],
		);
		const embedder = fakeEmbedder();
		await indexPdfBook(deps({ embedder }), book.id);
		const done = store.getBook(book.id)!;
		assert.equal(done.status, "ready");
		assert.equal(done.progress, undefined);
		assert.equal(done.error, undefined);
		assert.equal(done.pageCount, 3);
		assert.equal(done.chunkCount, 3);
		assert.deepEqual(done.toc.map((t) => [t.title, t.page, t.depth]), [["Renal", 1, 0], ["Diuretics", 1, 1], ["Endocrine", 2, 0]]);
		assert.deepEqual(done.embeddings, { model: "fake-embedder-v1", dim: 64 });
		const chunks = store.readChunks(book.id);
		assert.deepEqual(chunks.map((c) => c.page), [1, 2, 3]);
		assert.equal(chunks[0]!.section, "Renal > Diuretics");
		assert.match(chunks[0]!.text, /Furosemide blocks NKCC2/);
		assert.ok(chunks[0]!.text.includes("\n"), "line structure survives");
		assert.equal(store.readVectors(book.id, 64)!.vectors.length, 3 * 64);
		assert.ok(embedder.calls >= 1);
	});

	it("progress is written while reading and embedding", async () => {
		const book = newPdfBook([{ lines: ["page one text here"] }, { lines: ["page two text here"] }], "text");
		const phases = new Set<string>();
		const spy: LibraryStore = new Proxy(store, {
			get(target, prop, receiver) {
				if (prop === "updateBook") return (id: string, patch: { progress?: { phase: string } }) => { if (patch.progress) phases.add(patch.progress.phase); return target.updateBook(id, patch as never); };
				return Reflect.get(target, prop, receiver);
			},
		});
		await indexPdfBook({ store: spy, embedder: fakeEmbedder(), vision: null }, book.id);
		assert.ok(phases.has("reading") && phases.has("embedding") && phases.has("finishing"), [...phases].join(","));
	});

	it("keyword-only when there is no embedder, with a notice and 'Retry search model' later working", async () => {
		const book = newPdfBook([{ lines: ["Some searchable text about nephrons."] }], "text");
		await indexPdfBook(deps({ embedder: null }), book.id);
		let done = store.getBook(book.id)!;
		assert.equal(done.status, "ready");
		assert.equal(done.embeddings, null);
		assert.match(done.notice!, /Meaning search is off/);
		await embedBook(deps(), book.id);
		done = store.getBook(book.id)!;
		assert.equal(done.status, "ready");
		assert.equal(done.embeddings?.dim, 64);
		assert.equal(done.notice, undefined, "the embedding notice is cleared once vectors exist");
	});

	it("a model that fails to load leaves the book READY and keyword-searchable, with the reason", async () => {
		const book = newPdfBook([{ lines: ["Text on a page about glomeruli."] }], "text");
		const broken: LibraryEmbedder = { ...fakeEmbedder(), ready: async () => { throw new Error("couldn't download the search model — are you offline? (fetch failed)"); } };
		await indexPdfBook(deps({ embedder: broken }), book.id);
		const done = store.getBook(book.id)!;
		assert.equal(done.status, "ready");
		assert.equal(done.chunkCount, 1);
		assert.equal(done.embeddings, null);
		assert.match(done.notice!, /are you offline/);
		assert.match(done.notice!, /Retry search model/);
		assert.equal(store.readVectors(book.id, 64), null);
	});

	it("vision mode: describes the image-heavy page, marks it AI-written, leaves text pages alone", async () => {
		const book = newPdfBook(
			[{ lines: Array.from({ length: 20 }, (_, i) => `Line ${i} of ordinary running text that is long enough to be prose.`) }, { lines: ["Figure 2: a labelled diagram"], image: true }],
			"vision",
		);
		const vision = fauxVision(["A chest radiograph showing a right pleural effusion with blunted costophrenic angle."]);
		const headless = fakeHeadless();
		await indexPdfBook(deps({ vision: { engine: vision, headless } }), book.id);
		assert.equal(vision.calls(), 1, "one call, for the one image-heavy page");
		assert.deepEqual(headless.rendered.flat(), [2]);
		const done = store.getBook(book.id)!;
		assert.deepEqual(done.visionPages, [2]);
		const chunks = store.readChunks(book.id);
		const p2 = chunks.find((c) => c.page === 2)!;
		assert.match(p2.text, /pleural effusion/);
		assert.match(p2.text, /AI read, verify/);
		assert.equal(p2.visionText, true);
		assert.equal(chunks.find((c) => c.page === 1)!.visionText, undefined);
	});

	it("vision mode with no engine available: indexes text only and says so", async () => {
		const book = newPdfBook([{ lines: ["Figure 3: a labelled diagram"], image: true }, { lines: ["Plain text on page two."] }], "vision");
		await indexPdfBook(deps({ vision: null }), book.id);
		const done = store.getBook(book.id)!;
		assert.equal(done.status, "ready");
		assert.deepEqual(done.visionPages, []);
		assert.match(done.notice!, /vision wasn't available/);
	});

	it("vision pass that keeps failing stops early and reports it; the book still indexes", async () => {
		const pages: FixturePage[] = Array.from({ length: 8 }, (_, i) => ({ lines: [`Figure ${i}: a labelled diagram`], image: true }));
		const book = newPdfBook(pages, "vision");
		await indexPdfBook(deps({ vision: { engine: fauxVision([]), headless: fakeHeadless(true) } }), book.id);
		const done = store.getBook(book.id)!;
		assert.equal(done.status, "ready");
		assert.match(done.notice!, /stopped after 5 failures in a row/);
		assert.equal(done.chunkCount, 8, "the extracted captions are still indexed");
	});

	it("'NONE' from the vision model means nothing to add", async () => {
		const book = newPdfBook([{ lines: ["Decorative logo page"], image: true }], "vision");
		await indexPdfBook(deps({ vision: { engine: fauxVision(["NONE"]), headless: fakeHeadless() } }), book.id);
		const done = store.getBook(book.id)!;
		assert.deepEqual(done.visionPages, []);
		assert.equal(store.readChunks(book.id)[0]!.visionText, undefined);
	});

	it("a PDF with no text and nothing describable ends in an honest error", async () => {
		const book = newPdfBook([{ lines: [] }, { lines: [] }], "text");
		await indexPdfBook(deps(), book.id);
		const done = store.getBook(book.id)!;
		assert.equal(done.status, "error");
		assert.match(done.error!, /No text was found.*scanned/s);
	});

	it("an unreadable file becomes an error record, not a throw", async () => {
		const book = store.createBook({ kind: "pdf", title: "Broken", fileName: "x.pdf", pageCount: 1, mode: "text", toc: [], visionPages: [] }, { pdf: new Uint8Array([1, 2, 3]) });
		await indexPdfBook(deps(), book.id);
		const done = store.getBook(book.id)!;
		assert.equal(done.status, "error");
		assert.match(done.error!, /Couldn't read this PDF/);
	});

	it("an aborted run rethrows AbortError so the caller can clean up", async () => {
		const book = newPdfBook([{ lines: ["a page"] }, { lines: ["b page"] }], "text");
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(() => indexPdfBook(deps({ signal: controller.signal }), book.id), (e: Error) => e.name === "AbortError");
	});

	it("SlideScribe: one chunk per slide section, marks kept, slide toc, no vision call", async () => {
		const markdown = makeSlideScribeNote({
			slides: [
				{ n: 1, title: "Overview", takeaway: "Loop diuretics block NKCC2.", onSlide: "Nephron diagram.", explained: "Acts in the thick ascending limb." },
				{ n: 2, title: "[Film]", takeaway: "Free air means perforation.", onSlide: "Erect film (AI read — verify).", explained: "⚠ Check the dose." },
			],
			extra: "Exam is multiple choice.",
		});
		const book = store.createBook(
			{ kind: "slidescribe", title: "Lecture A", fileName: "l.pdf", pageCount: 2, mode: "note", toc: [], visionPages: [], note: { sourcePdf: "l.pdf", slideCount: 2 } },
			{ pdf: makePdf([{ lines: ["s1"] }, { lines: ["s2"] }]), note: markdown },
		);
		const vision = fauxVision([]);
		await indexNoteBook(deps({ vision: { engine: vision, headless: fakeHeadless() } }), book.id);
		const done = store.getBook(book.id)!;
		assert.equal(done.status, "ready");
		assert.equal(vision.calls(), 0);
		const chunks = store.readChunks(book.id);
		assert.deepEqual(chunks.map((c) => c.page), [1, 2, 0]);
		assert.deepEqual(chunks[1]!.marks, { warning: true, aiRead: true });
		assert.deepEqual(done.toc.map((t) => t.title), ["Slide 1: Overview", "Slide 2: [Film]"]);
		assert.ok(done.embeddings);
	});

	it("SlideScribe: a PDF/slide-count mismatch warning survives as the book's notice", async () => {
		const markdown = makeSlideScribeNote({ slides: [{ n: 1, title: "Only", takeaway: "t", onSlide: "o", explained: "e" }] });
		const book = store.createBook(
			{ kind: "slidescribe", title: "Lecture B", fileName: "l.pdf", pageCount: 5, mode: "note", toc: [], visionPages: [], note: { sourcePdf: "l.pdf", slideCount: 1, pdfMismatch: "The note covers 1 slides but the PDF has 5 pages — check that this is the right PDF." } },
			{ pdf: makePdf([{ lines: ["x"] }]), note: markdown },
		);
		await indexNoteBook(deps(), book.id);
		assert.match(store.getBook(book.id)!.notice!, /check that this is the right PDF/);
	});

	it("SlideScribe: a file that isn't a note ends in an error record", async () => {
		const book = store.createBook(
			{ kind: "slidescribe", title: "Not a note", fileName: "l.pdf", pageCount: 1, mode: "note", toc: [], visionPages: [] },
			{ pdf: makePdf([{ lines: ["x"] }]), note: "just some prose" },
		);
		await indexNoteBook(deps(), book.id);
		const done = store.getBook(book.id)!;
		assert.equal(done.status, "error");
		assert.match(done.error!, /frontmatter/);
	});
});
