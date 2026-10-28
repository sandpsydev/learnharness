/**
 * The PDF library's shared shapes (medical fork, Phase 6): what Settings →
 * Library shows and what the stores/tools pass around. Browser-safe — types
 * only. The behavior lives in core/library.ts (pure, node-free) and the
 * fs adapter in src/store/library.ts.
 */

/** A plain PDF (slides, textbook) or a SlideScribe lecture note + its PDF. */
export type LibraryBookKind = "pdf" | "slidescribe";

/** Chosen per PDF at import: plain text only, or ChatGPT vision describes
 *  the image-heavy pages. SlideScribe notes are "note" — SlideScribe already
 *  did its own vision pass. */
export type LibraryImportMode = "text" | "vision" | "note";

export type LibraryBookStatus = "indexing" | "ready" | "error";

/** What the indexer is doing right now (the progress bar's label). */
export type LibraryPhase = "queued" | "reading" | "describing" | "embedding" | "finishing";

export interface LibraryProgress {
	phase: LibraryPhase;
	done: number;
	total: number;
	/** A line to show instead of "done / total" (e.g. the model download). */
	message?: string;
}

/** One entry of the PDF's outline (bookmarks), flattened in reading order. */
export interface LibraryTocEntry {
	title: string;
	/** 1-based PDF page the entry points at. */
	page: number;
	/** Nesting depth, 0 = top level. */
	depth: number;
}

export interface LibraryEmbeddingInfo {
	/** Stable id of the embedding model that produced the vectors. */
	model: string;
	dim: number;
}

/** SlideScribe-only facts kept with the book. */
export interface LibraryNoteInfo {
	/** The `source_pdf` frontmatter value (a file name). */
	sourcePdf: string;
	slideCount: number;
	lecturer?: string;
	generatedAt?: string;
	/** Set when the PDF's page count differs from the note's slide_count. */
	pdfMismatch?: string;
}

export interface LibraryBook {
	id: string;
	kind: LibraryBookKind;
	/** The citation name: the PDF's file name (minus .pdf) or the lecture title. */
	title: string;
	/** Original PDF file name. */
	fileName: string;
	course?: string;
	pageCount: number;
	importedAt: string;
	mode: LibraryImportMode;
	status: LibraryBookStatus;
	progress?: LibraryProgress;
	error?: string;
	chunkCount: number;
	/** null = keyword search only (no vectors yet). */
	embeddings: LibraryEmbeddingInfo | null;
	/** Why there are no vectors / what went wrong softly — shown in Settings. */
	notice?: string;
	toc: LibraryTocEntry[];
	/** Pages ChatGPT vision described (vision mode only). */
	visionPages: number[];
	note?: LibraryNoteInfo;
}

/** The marks a SlideScribe passage carries that must stay visible when cited. */
export interface LibraryChunkMarks {
	/** A ⚠ check mark (SlideScribe flagged something to verify). */
	warning?: boolean;
	/** "(AI read — verify)": the note's own reading of an image. */
	aiRead?: boolean;
}

export interface LibraryChunk {
	/** Position in the book's chunk list (also the vector row). */
	index: number;
	/** 1-based PDF page; the slide number for a SlideScribe note; 0 = the
	 *  note's "Extra from the lecture" section. */
	page: number;
	/** Heading context: outline path (PDF) or the slide's title (note). */
	section?: string;
	text: string;
	/** Includes a vision-described image (AI-written, unverified). */
	visionText?: boolean;
	marks?: LibraryChunkMarks;
}

/** Everything Settings → Library needs in one read. */
export interface LibraryListing {
	books: LibraryBook[];
	/** Whether "ChatGPT vision" can run now, and why not when it can't. */
	vision: { available: boolean; reason?: string };
	/** The local embedding model (name, size, license) and whether its files are on disk. */
	embeddingModel: { name: string; sizeMb: number; license: string; downloaded: boolean };
}

/** A search hit as the tools and tests see it. */
export interface LibraryHit {
	book: LibraryBook;
	chunk: LibraryChunk;
	score: number;
	/** Which rankers found it. */
	via: Array<"keyword" | "meaning">;
}
