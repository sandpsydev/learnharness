/**
 * LibraryStore — the fs adapter for the PDF library (medical fork, Phase 6):
 * one directory per book under data/library/<bookId>/:
 *
 *   book.json     the LibraryBook record (read-modify-write, like a chat file)
 *   source.pdf    the library's OWN copy of the PDF — moving or renaming the
 *                 original never breaks a citation
 *   note.md       the SlideScribe note, when the book came from one
 *   chunks.jsonl  one LibraryChunk per line
 *   vectors.f32   row-major unit vectors, one row per chunk (optional)
 *
 * Implements core/ports.ts LibraryStore. Idioms match the other adapters:
 * sync fs, id-guarded paths, tab-indented JSON, corrupt files skipped rather
 * than thrown at the caller. `createLibraryStore(root)` exists so tests can
 * point it at a temp directory; `libraryStore` is the production instance.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { LibraryBook, LibraryChunk } from "../core/contracts.ts";
import type { LibraryStore, NewLibraryBook } from "../core/ports.ts";

const ID_RE = /^bk_[a-z0-9]+$/;

function atomicWrite(file: string, data: string | Uint8Array): void {
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, data);
	fs.renameSync(tmp, file);
}

export function createLibraryStore(root: string): LibraryStore {
	const dirOf = (id: string): string => {
		if (!ID_RE.test(id)) throw new Error(`Invalid book id: ${id}`);
		return path.join(root, id);
	};
	const file = (id: string, name: string) => path.join(dirOf(id), name);

	function getBook(id: string): LibraryBook | null {
		try {
			const book = JSON.parse(fs.readFileSync(file(id, "book.json"), "utf-8")) as LibraryBook;
			return book && typeof book === "object" && book.id === id ? book : null;
		} catch {
			return null;
		}
	}

	function listBooks(): LibraryBook[] {
		let names: string[];
		try {
			names = fs.readdirSync(root);
		} catch {
			return [];
		}
		const books: LibraryBook[] = [];
		for (const name of names) {
			if (!ID_RE.test(name)) continue;
			const book = getBook(name);
			if (book) books.push(book);
		}
		return books.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
	}

	/** "Title", "Title (2)", … so a citation names exactly one book. */
	function uniqueTitle(title: string): string {
		const taken = new Set(listBooks().map((b) => b.title.toLowerCase()));
		if (!taken.has(title.toLowerCase())) return title;
		for (let n = 2; ; n++) {
			const candidate = `${title} (${n})`;
			if (!taken.has(candidate.toLowerCase())) return candidate;
		}
	}

	return {
		listBooks,
		getBook,

		createBook(init: NewLibraryBook, files: { pdf: Uint8Array; note?: string }): LibraryBook {
			const id = `bk_${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
			const book: LibraryBook = {
				id,
				kind: init.kind,
				title: uniqueTitle(init.title),
				fileName: init.fileName,
				...(init.course ? { course: init.course } : {}),
				pageCount: init.pageCount,
				importedAt: new Date().toISOString(),
				mode: init.mode,
				status: "indexing",
				progress: { phase: "queued", done: 0, total: init.pageCount },
				chunkCount: 0,
				embeddings: null,
				toc: init.toc,
				visionPages: init.visionPages,
				...(init.note ? { note: init.note } : {}),
			};
			fs.mkdirSync(dirOf(id), { recursive: true });
			atomicWrite(file(id, "source.pdf"), files.pdf);
			if (files.note !== undefined) atomicWrite(file(id, "note.md"), files.note);
			atomicWrite(file(id, "book.json"), JSON.stringify(book, null, "\t"));
			return book;
		},

		updateBook(id, patch) {
			const current = getBook(id);
			if (!current) return null;
			const next: LibraryBook = { ...current, ...patch, id: current.id, kind: current.kind, importedAt: current.importedAt };
			// An explicit undefined removes the key (progress, error, notice).
			for (const key of Object.keys(next) as Array<keyof LibraryBook>) {
				if (next[key] === undefined) delete next[key];
			}
			atomicWrite(file(id, "book.json"), JSON.stringify(next, null, "\t"));
			return next;
		},

		pdfPath: (id) => file(id, "source.pdf"),

		readNote(id) {
			try {
				return fs.readFileSync(file(id, "note.md"), "utf-8");
			} catch {
				return null;
			}
		},

		readChunks(id) {
			let raw: string;
			try {
				raw = fs.readFileSync(file(id, "chunks.jsonl"), "utf-8");
			} catch {
				return [];
			}
			const chunks: LibraryChunk[] = [];
			for (const line of raw.split("\n")) {
				if (!line) continue;
				try {
					const c = JSON.parse(line) as LibraryChunk;
					if (typeof c.page === "number" && typeof c.text === "string") chunks.push(c);
				} catch {
					/* corrupt line: skip, never guess */
				}
			}
			// Row order = chunk index: the vector rows line up by position.
			return chunks.map((c, index) => ({ ...c, index }));
		},

		writeChunks(id, chunks) {
			if (!fs.existsSync(dirOf(id))) throw new Error(`Unknown book: ${id}`);
			atomicWrite(file(id, "chunks.jsonl"), chunks.map((c) => JSON.stringify(c)).join("\n") + (chunks.length ? "\n" : ""));
		},

		writeVectors(id, vectors) {
			if (!fs.existsSync(dirOf(id))) throw new Error(`Unknown book: ${id}`);
			const target = file(id, "vectors.f32");
			if (!vectors) {
				fs.rmSync(target, { force: true });
				return;
			}
			atomicWrite(target, new Uint8Array(vectors.buffer, vectors.byteOffset, vectors.byteLength));
		},

		readVectors(id, dim) {
			try {
				const buf = fs.readFileSync(file(id, "vectors.f32"));
				if (dim <= 0 || buf.byteLength === 0 || buf.byteLength % (4 * dim) !== 0) return null;
				// Copy: a Buffer's backing store is not 4-byte aligned.
				const copy = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
				return { vectors: new Float32Array(copy), dim };
			} catch {
				return null;
			}
		},

		fingerprint(id) {
			const stamp = (name: string): number => {
				try {
					return fs.statSync(file(id, name)).mtimeMs;
				} catch {
					return 0;
				}
			};
			return `${stamp("chunks.jsonl")}:${stamp("vectors.f32")}`;
		},

		deleteBook(id) {
			const dir = dirOf(id);
			if (!fs.existsSync(dir)) return false;
			fs.rmSync(dir, { recursive: true, force: true });
			return true;
		},
	};
}

/** The production instance (data/library under the LH_DATA_DIR seam). */
export const libraryStore: LibraryStore = createLibraryStore(PATHS.library);
