/**
 * THE LIBRARY INDEXER (medical fork, Phase 6): turns an imported book into a
 * searchable index — page text through pdf-ops, an optional vision pass over
 * the image-heavy pages, chunks by page/section, the outline (TOC), then
 * embeddings from the local model. Progress is written to the book record as
 * it goes (the Settings progress bar reads it); the keyword index needs no
 * build step of its own — it is derived from the stored chunks on first use.
 *
 * Failure policy: the keyword index is the floor. A vision pass that can't
 * run, or an embedding model that can't load, leaves the book READY with a
 * notice saying what's missing — only a PDF that can't be read at all (or has
 * no text and nothing to describe) ends in an error.
 */

import type { LibraryBook, LibraryChunk, LibraryProgress } from "../../core/contracts.ts";
import {
	chunkPdfPages,
	chunkSlideScribeNote,
	parseSlideScribeNote,
	pickVisionPages,
	type LibraryEmbedder,
	type PdfPageText,
} from "../../core/library.ts";
import type { LibraryStore } from "../../core/ports.ts";
import type { PiEngine } from "../models.ts";
import { readPdfBook } from "../subagents/pdf-ops.ts";
import type { HeadlessApi } from "../subagents/headless.ts";
import { describePages } from "./vision.ts";

export interface IndexerDeps {
	store: LibraryStore;
	/** Null = no meaning index (keyword only). */
	embedder: LibraryEmbedder | null;
	/** Present only when the vision pass can run (engine resolved, key ok). */
	vision?: { engine: PiEngine; headless: HeadlessApi } | null;
	signal?: AbortSignal;
}

const EMBED_BATCH = 16;

/** Progress writes hit disk; coalesce them (phase changes always land). */
function progressWriter(store: LibraryStore, id: string) {
	let lastWrite = 0;
	let lastPhase = "";
	return (progress: LibraryProgress, force = false) => {
		const now = Date.now();
		if (!force && progress.phase === lastPhase && now - lastWrite < 300 && progress.done < progress.total) return;
		lastWrite = now;
		lastPhase = progress.phase;
		store.updateBook(id, { progress });
	};
}

function isAbort(err: unknown): boolean {
	return err instanceof Error && err.name === "AbortError";
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Embed the chunks and store the vectors. Never throws for a model problem —
 *  returns what the book record should say instead. */
async function embedChunks(
	deps: IndexerDeps,
	book: LibraryBook,
	chunks: readonly LibraryChunk[],
	report: ReturnType<typeof progressWriter>,
): Promise<Pick<LibraryBook, "embeddings"> & { notice?: string }> {
	const { store, embedder } = deps;
	if (!embedder) return { embeddings: null, notice: "Meaning search is off (no embedding model configured); keyword search works." };
	if (chunks.length === 0) return { embeddings: null };
	try {
		report({ phase: "embedding", done: 0, total: chunks.length, message: "Loading the search model…" }, true);
		await embedder.ready((message) => report({ phase: "embedding", done: 0, total: chunks.length, message }, true));
		const matrix = new Float32Array(chunks.length * embedder.dim);
		const texts = chunks.map((c) => `${book.title}${c.section ? ` — ${c.section}` : ""}\n${c.text}`);
		for (let i = 0; i < texts.length; i += EMBED_BATCH) {
			if (deps.signal?.aborted) {
				const err = new Error("aborted");
				err.name = "AbortError";
				throw err;
			}
			const vectors = await embedder.embedPassages(texts.slice(i, i + EMBED_BATCH));
			vectors.forEach((v, r) => matrix.set(v, (i + r) * embedder.dim));
			report({ phase: "embedding", done: Math.min(i + EMBED_BATCH, texts.length), total: texts.length });
		}
		store.writeVectors(book.id, matrix);
		return { embeddings: { model: embedder.model, dim: embedder.dim } };
	} catch (err) {
		if (isAbort(err)) throw err;
		store.writeVectors(book.id, null);
		return {
			embeddings: null,
			notice: `Meaning search is off for this book: ${messageOf(err)}. Keyword search works; use "Retry search model" in Settings → Library when you're online.`,
		};
	}
}

/** Join two optional notices into one line. */
function joinNotices(...parts: Array<string | undefined>): string | undefined {
	const kept = parts.filter((p): p is string => !!p);
	return kept.length > 0 ? kept.join(" ") : undefined;
}

export async function indexPdfBook(deps: IndexerDeps, bookId: string): Promise<void> {
	const { store } = deps;
	const book = store.getBook(bookId);
	if (!book) return;
	const report = progressWriter(store, bookId);
	try {
		report({ phase: "reading", done: 0, total: book.pageCount }, true);
		const read = await readPdfBook(store.pdfPath(bookId), {
			images: book.mode === "vision",
			signal: deps.signal,
			onPage: (done, total) => report({ phase: "reading", done, total }),
		});
		const toc = read.outline;
		const pages: PdfPageText[] = read.pages.map((p) => ({ page: p.page, text: p.text }));

		let visionNotice: string | undefined;
		const visionPages: number[] = [];
		if (book.mode === "vision") {
			const picks = pickVisionPages(read.pages);
			if (!deps.vision) {
				visionNotice = "ChatGPT vision wasn't available, so image-heavy pages were indexed as text only.";
			} else if (picks.length > 0) {
				report({ phase: "describing", done: 0, total: picks.length }, true);
				const result = await describePages({
					engine: deps.vision.engine,
					headless: deps.vision.headless,
					pdfPath: store.pdfPath(bookId),
					pages: picks,
					textOf: (page) => read.pages[page - 1]?.text ?? "",
					signal: deps.signal,
					onProgress: (done, total) => report({ phase: "describing", done, total }),
				});
				for (const [page, vision] of result.descriptions) {
					pages[page - 1] = { ...pages[page - 1]!, vision };
					visionPages.push(page);
				}
				visionNotice = result.notice;
			}
		}

		const chunks = chunkPdfPages(pages, toc);
		if (chunks.length === 0) {
			store.updateBook(bookId, {
				status: "error",
				progress: undefined,
				pageCount: read.pageCount,
				error:
					book.mode === "vision"
						? "No readable text was found in this PDF, and no page could be described."
						: "No text was found in this PDF — it may be scanned images. Remove it and import again with “ChatGPT vision describes image-heavy pages”.",
			});
			return;
		}
		store.writeChunks(bookId, chunks);
		store.updateBook(bookId, { toc, pageCount: read.pageCount, chunkCount: chunks.length, visionPages: visionPages.sort((a, b) => a - b) });

		const embedded = await embedChunks(deps, book, chunks, report);
		report({ phase: "finishing", done: 1, total: 1 }, true);
		store.updateBook(bookId, {
			status: "ready",
			progress: undefined,
			error: undefined,
			embeddings: embedded.embeddings,
			notice: joinNotices(visionNotice, embedded.notice),
		});
	} catch (err) {
		if (isAbort(err)) throw err;
		store.updateBook(bookId, { status: "error", progress: undefined, error: `Couldn't read this PDF: ${messageOf(err)}` });
	}
}

export async function indexNoteBook(deps: IndexerDeps, bookId: string): Promise<void> {
	const { store } = deps;
	const book = store.getBook(bookId);
	if (!book) return;
	const report = progressWriter(store, bookId);
	try {
		const markdown = store.readNote(bookId);
		if (markdown === null) throw new Error("the note file is missing");
		const note = parseSlideScribeNote(markdown, book.title);
		if ("error" in note) throw new Error(note.error);
		const chunks = chunkSlideScribeNote(note);
		store.writeChunks(bookId, chunks);
		const toc = note.sections
			.filter((s) => s.slide > 0)
			.map((s) => ({ title: `Slide ${s.slide}${s.title ? `: ${s.title}` : ""}`, page: s.slide, depth: 0 }));
		store.updateBook(bookId, { toc, chunkCount: chunks.length });

		const embedded = await embedChunks(deps, book, chunks, report);
		report({ phase: "finishing", done: 1, total: 1 }, true);
		store.updateBook(bookId, {
			status: "ready",
			progress: undefined,
			error: undefined,
			embeddings: embedded.embeddings,
			notice: joinNotices(book.note?.pdfMismatch, embedded.notice),
		});
	} catch (err) {
		if (isAbort(err)) throw err;
		store.updateBook(bookId, { status: "error", progress: undefined, error: `Couldn't index this note: ${messageOf(err)}` });
	}
}

/** Rebuild only the vectors from the stored chunks (the "Retry search model" action). */
export async function embedBook(deps: IndexerDeps, bookId: string): Promise<void> {
	const { store } = deps;
	const book = store.getBook(bookId);
	if (!book || book.status === "indexing") return;
	const chunks = store.readChunks(bookId);
	if (chunks.length === 0) return;
	const report = progressWriter(store, bookId);
	store.updateBook(bookId, { status: "indexing", progress: { phase: "embedding", done: 0, total: chunks.length } });
	try {
		const embedded = await embedChunks(deps, book, chunks, report);
		store.updateBook(bookId, {
			status: "ready",
			progress: undefined,
			embeddings: embedded.embeddings,
			// Keep a vision/mismatch notice that predates this retry; replace the embedding one.
			notice: embedded.notice ?? stripEmbeddingNotice(book.notice),
		});
	} catch (err) {
		if (isAbort(err)) throw err;
		store.updateBook(bookId, { status: "ready", progress: undefined, notice: `Couldn't build the meaning index: ${messageOf(err)}` });
	}
}

function stripEmbeddingNotice(notice: string | undefined): string | undefined {
	if (!notice) return undefined;
	const kept = notice.split(/(?<=\.) /).filter((s) => !s.startsWith("Meaning search is off"));
	return kept.length > 0 ? kept.join(" ") : undefined;
}
