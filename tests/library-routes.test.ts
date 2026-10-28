/**
 * The library service + its API routes end to end, in an isolated data dir.
 * LH_DATA_DIR is set BEFORE the app modules load (config.ts reads it at
 * import), and the process-wide run registry is pre-seeded with a fake
 * embedder — so nothing here touches the network or the model weights.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { fakeEmbedder, makePdf, makeSlideScribeNote } from "./library-fixtures.ts";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-library-routes-"));
process.env.LH_DATA_DIR = dataDir;
delete process.env.OPENROUTER_API_KEY;
(globalThis as Record<string, unknown>).__lhLibraryRuns = { runs: new Map(), tail: Promise.resolve(), embedder: fakeEmbedder() };

const { library, stores } = await import("../src/server/index.ts");
const listRoute = await import("../app/api/library/route.ts");
const importRoute = await import("../app/api/library/import/route.ts");
const noteRoute = await import("../app/api/library/slidescribe/route.ts");
const idRoute = await import("../app/api/library/[id]/route.ts");

const pdfFile = (name: string, pages = 2) =>
	new File([new Uint8Array(makePdf(Array.from({ length: pages }, (_, i) => ({ lines: [`Page ${i + 1} about furosemide and the loop of Henle.`] }))))], name, { type: "application/pdf" });

function post(url: string, form: FormData): Request {
	return new Request(`http://localhost${url}`, { method: "POST", body: form });
}

async function settled(id: string): Promise<ReturnType<typeof stores.libraryStore.getBook>> {
	for (let i = 0; i < 200; i++) {
		const book = stores.libraryStore.getBook(id);
		if (book && book.status !== "indexing") return book;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("book never settled");
}

describe("library routes", () => {
	after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
	before(() => assert.equal(stores.libraryStore.listBooks().length, 0));

	it("GET /api/library: empty library, the vision reason, and the embedding model's facts", async () => {
		const body = await (await listRoute.GET()).json();
		assert.deepEqual(body.books, []);
		assert.equal(body.vision.available, false);
		assert.match(body.vision.reason, /No vision model is set/);
		assert.equal(body.embeddingModel.license, "MIT");
		assert.equal(body.embeddingModel.downloaded, false);
		assert.equal(library.toolContext(), undefined, "no searchable book → no library tools for the agents");
	});

	it("imports a PDF (text mode): copies it into the data dir and indexes in the background", async () => {
		const form = new FormData();
		form.append("files", pdfFile("My Textbook.pdf", 3));
		form.append("mode", "text");
		const res = await importRoute.POST(post("/api/library/import", form));
		assert.equal(res.status, 200);
		const { results } = await res.json();
		assert.equal(results[0].ok, true);
		const book = results[0].book;
		assert.equal(book.title, "My Textbook");
		assert.equal(book.pageCount, 3);
		assert.equal(book.status, "indexing");
		assert.ok(fs.existsSync(path.join(dataDir, "library", book.id, "source.pdf")), "copied into the app's data dir");
		const done = (await settled(book.id))!;
		assert.equal(done.status, "ready");
		assert.equal(done.chunkCount, 3);
		assert.equal(done.embeddings?.model, "fake-embedder-v1");
		assert.ok(library.toolContext(), "a searchable book → the agents get the pair");
		const hit = await library.reader.search("furosemide loop Henle");
		assert.equal(hit.hits[0]!.book.id, book.id);
	});

	it("per-file modes line up with the files; a second import with the same name gets its own citation name", async () => {
		const form = new FormData();
		form.append("files", pdfFile("My Textbook.pdf", 1));
		form.append("mode", "text");
		const { results } = await (await importRoute.POST(post("/api/library/import", form))).json();
		assert.equal(results[0].book.title, "My Textbook (2)");
		await settled(results[0].book.id);
	});

	it("rejects a file that isn't a PDF, and a PDF pdfjs can't open, with a reason", async () => {
		const form = new FormData();
		form.append("files", new File(["hello"], "notes.pdf"));
		form.append("mode", "text");
		form.append("files", new File(["%PDF-1.4 but then garbage"], "broken.pdf"));
		form.append("mode", "text");
		const { results } = await (await importRoute.POST(post("/api/library/import", form))).json();
		assert.equal(results[0].ok, false);
		assert.match(results[0].error, /isn't a PDF/);
		assert.equal(results[1].ok, false);
		assert.match(results[1].error, /couldn't be opened as a PDF/);
	});

	it("refuses vision mode while the vision model isn't usable, and says why", async () => {
		const form = new FormData();
		form.append("files", pdfFile("Slides.pdf"));
		form.append("mode", "vision");
		const { results } = await (await importRoute.POST(post("/api/library/import", form))).json();
		assert.equal(results[0].ok, false);
		assert.equal(results[0].status, 409);
		assert.match(results[0].error, /Image descriptions can't run: No vision model is set/);

		stores.settingsStore.writeSettings({ version: 1, models: { vision: { model: { provider: "openrouter", id: "some/model" } } } });
		const body = await (await listRoute.GET()).json();
		assert.equal(body.vision.available, false);
		assert.match(body.vision.reason, /isn't signed in/);
	});

	it("no files at all is a 400", async () => {
		const res = await importRoute.POST(post("/api/library/import", new FormData()));
		assert.equal(res.status, 400);
	});

	it("SlideScribe: the note alone asks for the PDF it names (422 + needsPdf)", async () => {
		const note = makeSlideScribeNote({ title: "Lecture One", sourcePdf: "lecture-one.pdf", slides: [{ n: 1, title: "A", takeaway: "t", onSlide: "o", explained: "e" }, { n: 2, title: "B", takeaway: "t", onSlide: "o", explained: "e" }] });
		const form = new FormData();
		form.append("note", new File([note], "Lecture One.md"));
		const res = await noteRoute.POST(post("/api/library/slidescribe", form));
		assert.equal(res.status, 422);
		const body = await res.json();
		assert.equal(body.needsPdf.expectedName, "lecture-one.pdf");
		assert.equal(body.needsPdf.noteTitle, "Lecture One");
		assert.equal(stores.libraryStore.listBooks().some((b) => b.title === "Lecture One"), false, "nothing was created yet");
	});

	it("SlideScribe: note + PDF import as one lecture, cited by slide, never touching the graph", async () => {
		const note = makeSlideScribeNote({
			title: "Lecture Two",
			sourcePdf: "lecture-two.pdf",
			slides: [
				{ n: 1, title: "Loop diuretics", takeaway: "Furosemide blocks NKCC2.", onSlide: "Nephron.", explained: "Thick ascending limb." },
				{ n: 2, title: "Film", takeaway: "Free air.", onSlide: "Erect film (AI read — verify).", explained: "⚠ Check this." },
			],
		});
		const form = new FormData();
		form.append("note", new File([note], "Lecture Two.md"));
		form.append("pdf", pdfFile("lecture-two.pdf", 2));
		const graphBefore = stores.graphStore.readNodes().length;
		const res = await noteRoute.POST(post("/api/library/slidescribe", form));
		assert.equal(res.status, 200);
		const { book } = await res.json();
		assert.equal(book.kind, "slidescribe");
		assert.equal(book.title, "Lecture Two");
		assert.equal(book.course, "Fixture Course");
		assert.equal(book.mode, "note");
		assert.ok(fs.existsSync(path.join(dataDir, "library", book.id, "note.md")), "both files copied");
		assert.ok(fs.existsSync(path.join(dataDir, "library", book.id, "source.pdf")));
		const done = (await settled(book.id))!;
		assert.equal(done.status, "ready");
		assert.equal(done.chunkCount, 2);
		assert.equal(done.notice, undefined);
		const { hits } = await library.reader.search("free air film", { book: "Lecture Two" });
		assert.equal(hits[0]!.chunk.page, 2);
		assert.deepEqual(hits[0]!.chunk.marks, { warning: true, aiRead: true });
		assert.equal(stores.graphStore.readNodes().length, graphBefore, "SlideScribe notes never feed the knowledge graph");
	});

	it("SlideScribe: a PDF with the wrong page count imports with a visible warning", async () => {
		const note = makeSlideScribeNote({ title: "Lecture Three", slides: [{ n: 1, title: "A", takeaway: "t", onSlide: "o", explained: "e" }, { n: 2, title: "B", takeaway: "t", onSlide: "o", explained: "e" }, { n: 3, title: "C", takeaway: "t", onSlide: "o", explained: "e" }] });
		const form = new FormData();
		form.append("note", new File([note], "Lecture Three.md"));
		form.append("pdf", pdfFile("fixture-lecture.pdf", 1));
		const { book } = await (await noteRoute.POST(post("/api/library/slidescribe", form))).json();
		const done = (await settled(book.id))!;
		assert.match(done.notice!, /covers 3 slides but the PDF has 1 pages/);
	});

	it("SlideScribe: a non-note is a 400 with the reason; a missing note is a 400 too", async () => {
		const form = new FormData();
		form.append("note", new File(["# not a note"], "x.md"));
		form.append("pdf", pdfFile("x.pdf"));
		const res = await noteRoute.POST(post("/api/library/slidescribe", form));
		assert.equal(res.status, 400);
		assert.match((await res.json()).error, /frontmatter/);
		assert.equal((await noteRoute.POST(post("/api/library/slidescribe", new FormData()))).status, 400);
	});

	it("an interrupted run (no live job, still 'indexing') is surfaced as an error with Retry, and reindex repairs it", async () => {
		const orphan = stores.libraryStore.createBook(
			{ kind: "pdf", title: "Orphan", fileName: "o.pdf", pageCount: 1, mode: "text", toc: [], visionPages: [] },
			{ pdf: makePdf([{ lines: ["An orphaned book about glomerular filtration."] }]) },
		);
		const body = await (await listRoute.GET()).json();
		const listed = body.books.find((b: { id: string }) => b.id === orphan.id);
		assert.equal(listed.status, "error");
		assert.match(listed.error, /interrupted/);

		const res = await idRoute.POST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ action: "reindex" }) }), { params: Promise.resolve({ id: orphan.id }) });
		assert.equal(res.status, 200);
		assert.equal((await settled(orphan.id))!.status, "ready");
	});

	it("'embed' rebuilds only the vectors; bad actions and unknown ids are rejected", async () => {
		const target = stores.libraryStore.listBooks().find((b) => b.title === "Orphan")!;
		stores.libraryStore.writeVectors(target.id, null);
		stores.libraryStore.updateBook(target.id, { embeddings: null });
		const ok = await idRoute.POST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ action: "embed" }) }), { params: Promise.resolve({ id: target.id }) });
		assert.equal(ok.status, 200);
		for (let i = 0; i < 100 && !stores.libraryStore.getBook(target.id)!.embeddings; i++) await new Promise((r) => setTimeout(r, 25));
		assert.equal(stores.libraryStore.getBook(target.id)!.embeddings?.dim, 64);

		const bad = await idRoute.POST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ action: "nuke" }) }), { params: Promise.resolve({ id: target.id }) });
		assert.equal(bad.status, 400);
		const missing = await idRoute.POST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ action: "embed" }) }), { params: Promise.resolve({ id: "bk_missing" }) });
		assert.equal(missing.status, 404);
	});

	it("DELETE removes the book and its files; unknown or malformed ids are 404", async () => {
		const target = stores.libraryStore.listBooks()[0]!;
		const res = await idRoute.DELETE(new Request("http://localhost/x", { method: "DELETE" }), { params: Promise.resolve({ id: target.id }) });
		assert.equal(res.status, 200);
		assert.equal(fs.existsSync(path.join(dataDir, "library", target.id)), false);
		assert.equal((await idRoute.DELETE(new Request("http://localhost/x", { method: "DELETE" }), { params: Promise.resolve({ id: target.id }) })).status, 404);
		assert.equal((await idRoute.DELETE(new Request("http://localhost/x", { method: "DELETE" }), { params: Promise.resolve({ id: "../etc" }) })).status, 404);
	});
});
