/**
 * THE LIBRARY SERVICE (medical fork, Phase 6): the server-side seam behind
 * Settings → Library and the agents' library tools. It owns the import
 * runs — validate, copy into the data dir, then index in the background one
 * book at a time — and wires the pieces that live in other layers: the fs
 * store, the local embedder, the ChatGPT vision engine, and the searcher the
 * tools read through.
 *
 * One writer: only this module's runs write a book's index files. Runs are
 * tracked on globalThis (Next dev compiles each route as its own module
 * instance; the registry must be one per process).
 */

import * as path from "node:path";
import { createLocalEmbedder, EMBEDDING_MODEL, modelFilesPresent } from "../agent/library/local-embedder.ts";
import { embedBook, indexNoteBook, indexPdfBook, type IndexerDeps } from "../agent/library/indexer.ts";
import { createLibrarySearcher, type LibraryReader } from "../agent/library/searcher.ts";
import { piEngineForSpec } from "../agent/models.ts";
import { getHeadless } from "../agent/subagents/headless.ts";
import { pdfPageCountOf } from "../agent/subagents/pdf-ops.ts";
import type { LibraryToolContext } from "../agent/tools/library.ts";
import type { LibraryBook, LibraryListing } from "../core/contracts.ts";
import { parseSlideScribeNote, type LibraryEmbedder } from "../core/library.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { providerKeyPresent } from "./keys.ts";
import { stores } from "./stores.ts";

interface LibraryRuns {
	/** One controller per queued or running index job, keyed by book id. */
	runs: Map<string, AbortController>;
	/** The queue: books index one at a time (it is CPU-heavy and, in vision mode, quota-heavy). */
	tail: Promise<void>;
	embedder?: LibraryEmbedder;
}

function state(): LibraryRuns {
	const g = globalThis as typeof globalThis & { __lhLibraryRuns?: LibraryRuns };
	return (g.__lhLibraryRuns ??= { runs: new Map(), tail: Promise.resolve() });
}

/** The one embedder of the process (loads its model lazily, once). */
function embedder(): LibraryEmbedder {
	const s = state();
	return (s.embedder ??= createLocalEmbedder());
}

/** The searcher uses the embedder for queries only while the model's files
 *  are on disk — a search must never start a download. */
const searcher: LibraryReader = createLibrarySearcher({
	store: stores.libraryStore,
	embedder: () => (modelFilesPresent() ? embedder() : null),
});

/** Is the vision pass runnable right now? (The vision slot's model + its sign-in.) */
function visionStatus(): { available: boolean; reason?: string } {
	const spec = resolveRoleSpec("pdfReader", stores.settingsStore.readSettings());
	if (!spec) return { available: false, reason: "No vision model is set — choose one in Settings → Agent." };
	if (!providerKeyPresent(spec.provider)) {
		return { available: false, reason: "The vision model's provider isn't signed in — connect it in Settings → Providers." };
	}
	return { available: true };
}

function visionDeps(): IndexerDeps["vision"] {
	if (!visionStatus().available) return null;
	const spec = resolveRoleSpec("pdfReader", stores.settingsStore.readSettings());
	if (!spec) return null;
	try {
		return { engine: piEngineForSpec(spec, true), headless: getHeadless() };
	} catch {
		return null;
	}
}

function isAbort(err: unknown): boolean {
	return err instanceof Error && err.name === "AbortError";
}

/** Queue one index job for a book. */
function enqueue(bookId: string, job: (deps: IndexerDeps) => Promise<void>): void {
	const s = state();
	const controller = new AbortController();
	s.runs.set(bookId, controller);
	s.tail = s.tail.then(async () => {
		try {
			if (controller.signal.aborted) return;
			await job({ store: stores.libraryStore, embedder: embedder(), vision: visionDeps(), signal: controller.signal });
		} catch (err) {
			if (!isAbort(err)) {
				stores.libraryStore.updateBook(bookId, {
					status: "error",
					progress: undefined,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		} finally {
			s.runs.delete(bookId);
		}
	});
}

/** A book left "indexing" by a process that no longer runs it is an interrupted run. */
function sweepInterrupted(): void {
	const live = state().runs;
	for (const book of stores.libraryStore.listBooks()) {
		if (book.status === "indexing" && !live.has(book.id)) {
			stores.libraryStore.updateBook(book.id, {
				status: "error",
				progress: undefined,
				error: "Indexing was interrupted (the app closed). Use Retry to index it again.",
			});
		}
	}
}

export type LibraryImportResult =
	| { ok: true; book: LibraryBook }
	| { ok: false; status: number; error: string; needsPdf?: { expectedName: string; noteTitle: string } };

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF

function looksLikePdf(bytes: Uint8Array): boolean {
	// The spec allows a little junk before the header; pdfjs tolerates 1 KB.
	const head = bytes.subarray(0, 1024);
	for (let i = 0; i + 4 <= head.length; i++) {
		if (PDF_MAGIC.every((b, k) => head[i + k] === b)) return true;
	}
	return false;
}

function titleFromFileName(fileName: string): string {
	return path.basename(fileName).replace(/\.pdf$/i, "").replace(/\s+/g, " ").trim() || "Untitled PDF";
}

async function validatePdf(bytes: Uint8Array, label: string): Promise<{ pages: number } | { error: string }> {
	if (bytes.byteLength === 0) return { error: `${label} is empty.` };
	if (!looksLikePdf(bytes)) return { error: `${label} isn't a PDF file.` };
	try {
		return { pages: await pdfPageCountOf(bytes) };
	} catch (err) {
		return { error: `${label} couldn't be opened as a PDF (${err instanceof Error ? err.message : String(err)}).` };
	}
}

export const library = {
	/** For the agents: the tool context when at least one book is searchable. */
	toolContext(): LibraryToolContext | undefined {
		return searcher.hasBooks() ? { reader: searcher } : undefined;
	},

	reader: searcher,

	listing(): LibraryListing {
		sweepInterrupted();
		return {
			books: stores.libraryStore.listBooks(),
			vision: visionStatus(),
			embeddingModel: {
				name: EMBEDDING_MODEL.name,
				sizeMb: EMBEDDING_MODEL.sizeMb,
				license: EMBEDDING_MODEL.license,
				downloaded: modelFilesPresent(),
			},
		};
	},

	/** Import one PDF: validate, copy into the data dir, index in the background. */
	async importPdf(input: { fileName: string; bytes: Uint8Array; mode: "text" | "vision" }): Promise<LibraryImportResult> {
		const checked = await validatePdf(input.bytes, input.fileName || "This file");
		if ("error" in checked) return { ok: false, status: 400, error: checked.error };
		if (input.mode === "vision") {
			const vision = visionStatus();
			if (!vision.available) return { ok: false, status: 409, error: `Image descriptions can't run: ${vision.reason}` };
		}
		const book = stores.libraryStore.createBook(
			{ kind: "pdf", title: titleFromFileName(input.fileName), fileName: input.fileName, pageCount: checked.pages, mode: input.mode, toc: [], visionPages: [] },
			{ pdf: input.bytes },
		);
		enqueue(book.id, (deps) => indexPdfBook(deps, book.id));
		return { ok: true, book };
	},

	/** Import a SlideScribe note and its PDF. Without the PDF the result says
	 *  which file the note expects, so the UI can ask for it. */
	async importSlideScribe(input: {
		noteName: string;
		noteText: string;
		pdf?: { fileName: string; bytes: Uint8Array };
	}): Promise<LibraryImportResult> {
		const note = parseSlideScribeNote(input.noteText, titleFromFileName(input.noteName.replace(/\.md$/i, "")));
		if ("error" in note) return { ok: false, status: 400, error: note.error };
		if (!input.pdf) {
			return {
				ok: false,
				status: 422,
				error: note.sourcePdf ? `Pick the lecture's PDF: ${note.sourcePdf}` : "This note doesn't name its PDF — pick the lecture's PDF.",
				needsPdf: { expectedName: note.sourcePdf ?? "", noteTitle: note.title },
			};
		}
		const checked = await validatePdf(input.pdf.bytes, input.pdf.fileName || "The PDF");
		if ("error" in checked) return { ok: false, status: 400, error: checked.error };
		const lastSlide = Math.max(...note.sections.map((s) => s.slide));
		const mismatch =
			checked.pages !== (note.slideCount ?? checked.pages) || lastSlide > checked.pages
				? `The note covers ${note.slideCount ?? lastSlide} slides but the PDF has ${checked.pages} pages — check that this is the right PDF.`
				: undefined;
		const book = stores.libraryStore.createBook(
			{
				kind: "slidescribe",
				title: note.title,
				fileName: input.pdf.fileName,
				...(note.course ? { course: note.course } : {}),
				pageCount: checked.pages,
				mode: "note",
				toc: [],
				visionPages: [],
				note: {
					sourcePdf: note.sourcePdf ?? input.pdf.fileName,
					slideCount: note.slideCount ?? lastSlide,
					...(note.lecturer ? { lecturer: note.lecturer } : {}),
					...(note.generatedAt ? { generatedAt: note.generatedAt } : {}),
					...(mismatch ? { pdfMismatch: mismatch } : {}),
				},
			},
			{ pdf: input.pdf.bytes, note: input.noteText },
		);
		enqueue(book.id, (deps) => indexNoteBook(deps, book.id));
		return { ok: true, book };
	},

	/** Remove a book (stops its indexing first). */
	remove(id: string): boolean {
		const run = state().runs.get(id);
		run?.abort();
		return stores.libraryStore.deleteBook(id);
	},

	/** Index a failed/interrupted book again from the library's own copy. */
	reindex(id: string): LibraryBook | null {
		const book = stores.libraryStore.getBook(id);
		if (!book || state().runs.has(id)) return book;
		const reset = stores.libraryStore.updateBook(id, {
			status: "indexing",
			error: undefined,
			notice: undefined,
			progress: { phase: "queued", done: 0, total: book.pageCount },
		});
		enqueue(id, (deps) => (book.kind === "slidescribe" ? indexNoteBook(deps, id) : indexPdfBook(deps, id)));
		return reset;
	},

	/** Build only the meaning index again (the model was unavailable before). */
	embed(id: string): LibraryBook | null {
		const book = stores.libraryStore.getBook(id);
		if (!book || state().runs.has(id) || book.status !== "ready") return book;
		enqueue(id, (deps) => embedBook(deps, id));
		return stores.libraryStore.getBook(id);
	},

};
