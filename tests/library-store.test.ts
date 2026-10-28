/**
 * The fs adapter (store/library.ts): the PDF is copied in, books round-trip,
 * chunks and vectors persist, titles stay unique, deletion removes the lot.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { createLibraryStore } from "../src/store/library.ts";
import type { LibraryStore } from "../src/core/ports.ts";

const INIT = { kind: "pdf" as const, title: "Robbins", fileName: "robbins.pdf", pageCount: 3, mode: "text" as const, toc: [], visionPages: [] };

describe("LibraryStore (fs adapter)", () => {
	let root: string;
	let store: LibraryStore;
	before(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-library-store-"));
		store = createLibraryStore(path.join(root, "library"));
	});
	after(() => fs.rmSync(root, { recursive: true, force: true }));

	it("starts empty, and an unknown or malformed id reads as null", () => {
		assert.deepEqual(store.listBooks(), []);
		assert.equal(store.getBook("bk_nope"), null);
		assert.throws(() => store.pdfPath("../escape"), /Invalid book id/);
	});

	it("createBook copies the PDF into the library and writes an 'indexing' record", () => {
		const bytes = new Uint8Array([37, 80, 68, 70, 1, 2, 3]);
		const book = store.createBook(INIT, { pdf: bytes });
		assert.match(book.id, /^bk_[a-z0-9]+$/);
		assert.equal(book.status, "indexing");
		assert.equal(book.progress?.phase, "queued");
		assert.equal(book.embeddings, null);
		assert.deepEqual([...fs.readFileSync(store.pdfPath(book.id))], [...bytes], "the library keeps its OWN copy");
		assert.deepEqual(store.getBook(book.id), book);
	});

	it("keeps citation names unique ('Robbins' → 'Robbins (2)')", () => {
		const second = store.createBook(INIT, { pdf: new Uint8Array([1]) });
		assert.equal(second.title, "Robbins (2)");
		const third = store.createBook({ ...INIT, title: "ROBBINS" }, { pdf: new Uint8Array([1]) });
		assert.equal(third.title, "ROBBINS (3)");
	});

	it("updateBook merges a patch, keeps identity fields, and an explicit undefined removes a key", () => {
		const [book] = store.listBooks();
		const updated = store.updateBook(book!.id, { status: "error", error: "boom", kind: "slidescribe" } as never)!;
		assert.equal(updated.status, "error");
		assert.equal(updated.kind, "pdf", "kind is immutable");
		const cleared = store.updateBook(book!.id, { error: undefined, status: "ready" })!;
		assert.equal("error" in cleared, false);
		assert.equal(store.updateBook("bk_missing", { status: "ready" }), null);
	});

	it("chunks round-trip with positional indexes; a corrupt line is skipped, not fatal", () => {
		const book = store.listBooks()[0]!;
		store.writeChunks(book.id, [
			{ index: 0, page: 1, text: "alpha" },
			{ index: 1, page: 2, text: "beta", section: "S", marks: { warning: true } },
		]);
		assert.deepEqual(store.readChunks(book.id).map((c) => [c.index, c.page, c.text]), [[0, 1, "alpha"], [1, 2, "beta"]]);
		fs.appendFileSync(path.join(root, "library", book.id, "chunks.jsonl"), "{not json\n");
		assert.equal(store.readChunks(book.id).length, 2);
	});

	it("vectors round-trip as aligned Float32 rows; a wrong dimension reads as null; null removes them", () => {
		const book = store.listBooks()[0]!;
		const m = new Float32Array([0.5, 0.25, -1, 2, 3, 4]);
		store.writeVectors(book.id, m);
		const back = store.readVectors(book.id, 3)!;
		assert.equal(back.dim, 3);
		assert.deepEqual([...back.vectors], [...m]);
		assert.equal(store.readVectors(book.id, 4), null, "6 floats are not whole 4-dim rows");
		store.writeVectors(book.id, null);
		assert.equal(store.readVectors(book.id, 3), null);
	});

	it("fingerprint changes when chunks or vectors change", async () => {
		const book = store.listBooks()[0]!;
		const before = store.fingerprint(book.id);
		await new Promise((r) => setTimeout(r, 15));
		store.writeVectors(book.id, new Float32Array([1, 2]));
		assert.notEqual(store.fingerprint(book.id), before);
	});

	it("keeps the SlideScribe note next to its PDF and lists newest first", () => {
		const note = store.createBook({ ...INIT, kind: "slidescribe", title: "Lecture", mode: "note" }, { pdf: new Uint8Array([1]), note: "# the note" });
		assert.equal(store.readNote(note.id), "# the note");
		assert.equal(store.listBooks()[0]!.id, note.id);
	});

	it("deleteBook removes the whole directory", () => {
		const book = store.listBooks()[0]!;
		assert.equal(store.deleteBook(book.id), true);
		assert.equal(fs.existsSync(path.join(root, "library", book.id)), false);
		assert.equal(store.deleteBook(book.id), false);
	});
});
