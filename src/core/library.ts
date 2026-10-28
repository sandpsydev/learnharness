/**
 * THE PDF LIBRARY's pure brain (medical fork, Phase 6): text → chunks, the
 * SlideScribe note parser, the keyword (BM25) ranker, the vector ranker, the
 * rank fusion, citations, and the page-spec parser. No IO, no node builtins,
 * no model calls — the store, the indexer and the embedder plug in around it.
 *
 * Why hybrid search: a keyword index finds the exact drug / eponym / lab
 * name a learner types; the local embedding model finds the passage that
 * means the same thing in other words. Reciprocal-rank fusion merges the two
 * without needing their scores to be comparable.
 */

import type {
	LibraryBook,
	LibraryChunk,
	LibraryChunkMarks,
	LibraryTocEntry,
} from "./contracts/library.ts";

// ─── Embedder seam ───────────────────────────────────────────────────────────

/** The embedding model as the indexer and the search see it. The real one
 *  runs locally (agent/library/local-embedder.ts); tests inject a fake. */
export interface LibraryEmbedder {
	/** Stable id stored with every vector set — a different id means the
	 *  vectors are stale and must not be mixed with new query vectors. */
	readonly model: string;
	readonly dim: number;
	/** Make the model usable (may download it once). Throws when it can't. */
	ready(onStatus?: (message: string) => void): Promise<void>;
	/** Unit-length vectors, one per text, in order. */
	embedPassages(texts: string[]): Promise<Float32Array[]>;
	embedQuery(text: string): Promise<Float32Array>;
}

// ─── Chunking ────────────────────────────────────────────────────────────────

/** Soft ceiling for one chunk of PDF text, in characters (~300 tokens: well
 *  inside the embedding model's 512-token window). */
export const PDF_CHUNK_CHARS = 1400;
/** SlideScribe sections are written to be read whole; they get more room. */
export const NOTE_CHUNK_CHARS = 2600;
/** A page with less text than this and no vision text has nothing to index. */
const MIN_PAGE_CHARS = 12;

/** Collapse runs of spaces, keep paragraph/line structure. */
export function tidyText(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/[ \t ]+/g, " ")
		.replace(/ ?\n ?/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Split text into pieces of at most `max` characters on line boundaries,
 *  breaking an over-long line at a sentence end, else at a space. */
export function splitText(text: string, max: number): string[] {
	const clean = tidyText(text);
	if (clean.length <= max) return clean ? [clean] : [];
	const lines: string[] = [];
	for (const line of clean.split("\n")) {
		let rest = line;
		while (rest.length > max) {
			let cut = rest.lastIndexOf(". ", max);
			if (cut < max * 0.4) cut = rest.lastIndexOf(" ", max);
			if (cut < max * 0.4) cut = max;
			else cut += 1;
			lines.push(rest.slice(0, cut).trim());
			rest = rest.slice(cut).trim();
		}
		lines.push(rest);
	}
	const pieces: string[] = [];
	let current = "";
	for (const line of lines) {
		if (current && current.length + line.length + 1 > max) {
			pieces.push(current);
			current = "";
		}
		current = current ? `${current}\n${line}` : line;
	}
	if (current) pieces.push(current);
	return pieces.filter((p) => p.trim().length > 0);
}

/** The heading context of `page`: the deepest outline path whose entry sits
 *  at or before the page ("Chapter 12 > Heart failure"). */
export function sectionFor(toc: readonly LibraryTocEntry[], page: number): string | undefined {
	const path: string[] = [];
	for (const entry of toc) {
		if (entry.page > page) continue;
		path.length = Math.min(path.length, entry.depth);
		path[entry.depth] = entry.title;
	}
	const joined = path.filter((p) => typeof p === "string" && p.length > 0).join(" > ");
	return joined || undefined;
}

export interface PdfPageText {
	page: number;
	text: string;
	/** ChatGPT vision's description of the page, when it ran. */
	vision?: string;
}

/** Heading that introduces the AI-written part of a vision-described page. */
export const VISION_HEADING = "[Image description — AI read, verify]";

/** One page → one or more chunks (a long page splits on line boundaries). */
export function chunkPdfPages(pages: readonly PdfPageText[], toc: readonly LibraryTocEntry[]): LibraryChunk[] {
	const chunks: LibraryChunk[] = [];
	for (const p of pages) {
		const body = tidyText(p.text);
		const vision = p.vision ? tidyText(p.vision) : "";
		if (body.length < MIN_PAGE_CHARS && !vision) continue;
		const full = vision ? `${body}${body ? "\n\n" : ""}${VISION_HEADING}\n${vision}` : body;
		const section = sectionFor(toc, p.page);
		for (const piece of splitText(full, PDF_CHUNK_CHARS)) {
			chunks.push({
				index: chunks.length,
				page: p.page,
				...(section ? { section } : {}),
				text: piece,
				// Conservative: any piece of a described page may hold the AI text.
				...(vision ? { visionText: true } : {}),
			});
		}
	}
	return chunks;
}

// ─── SlideScribe notes ───────────────────────────────────────────────────────

/** SlideScribe writes "(AI read — verify)" for readings of an image that are
 *  the model's own; ⚠ for "check this". Both must stay visible when cited. */
const AI_READ_RE = /\(\s*AI read\s*[—–-]+\s*verify\s*\)/i;

export function noteMarks(text: string): LibraryChunkMarks | undefined {
	const marks: LibraryChunkMarks = {};
	if (text.includes("⚠")) marks.warning = true;
	if (AI_READ_RE.test(text)) marks.aiRead = true;
	return marks.warning || marks.aiRead ? marks : undefined;
}

export interface SlideScribeSection {
	/** Slide number; 0 = "Extra from the lecture". */
	slide: number;
	title: string;
	/** The section's Markdown, heading line included. */
	text: string;
}

export interface SlideScribeNote {
	title: string;
	course?: string;
	lecturer?: string;
	date?: string;
	sourcePdf?: string;
	slideCount?: number;
	generatedAt?: string;
	sections: SlideScribeSection[];
}

/** Read `key: "value"` lines of the top-level YAML frontmatter (the only
 *  shape SlideScribe's assemble step writes; nested blocks are skipped). */
export function parseFrontmatter(markdown: string): { fields: Record<string, string>; body: string } | null {
	const text = markdown.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
	if (!text.startsWith("---\n")) return null;
	const end = text.indexOf("\n---", 4);
	if (end === -1) return null;
	const fields: Record<string, string> = {};
	for (const line of text.slice(4, end).split("\n")) {
		const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
		if (!m || m[2] === undefined) continue;
		let value = m[2].trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (value) fields[m[1]!] = value;
	}
	return { fields, body: text.slice(end + 4).replace(/^\n/, "") };
}

const SLIDE_HEADING_RE = /^## Slide (\d+)\s*:?\s*(.*)$/;
const EXTRA_HEADING_RE = /^## Extra from the lecture\b/i;
const OTHER_H2_RE = /^## /;

/** Parse a SlideScribe lecture note. Returns an error string for a file that
 *  is not one (no frontmatter, or no `## Slide N:` sections at all). */
export function parseSlideScribeNote(markdown: string, fallbackTitle = "Lecture"): SlideScribeNote | { error: string } {
	const parsed = parseFrontmatter(markdown);
	if (!parsed) return { error: "This doesn't look like a SlideScribe note: it has no frontmatter block at the top." };
	const sections: SlideScribeSection[] = [];
	let current: { slide: number; title: string; lines: string[] } | null = null;
	let heading1: string | undefined;
	const flush = () => {
		if (current) {
			const text = current.lines.join("\n").trim();
			if (text) sections.push({ slide: current.slide, title: current.title, text });
		}
		current = null;
	};
	for (const line of parsed.body.split("\n")) {
		const slide = SLIDE_HEADING_RE.exec(line);
		if (slide) {
			flush();
			current = { slide: Number(slide[1]), title: (slide[2] ?? "").trim(), lines: [line] };
			continue;
		}
		if (EXTRA_HEADING_RE.test(line)) {
			flush();
			current = { slide: 0, title: "Extra from the lecture", lines: [line] };
			continue;
		}
		if (OTHER_H2_RE.test(line)) {
			// "## Run notes" and any other level-2 block: not lecture content.
			flush();
			continue;
		}
		if (!current && heading1 === undefined && /^# /.test(line)) heading1 = line.slice(2).trim();
		current?.lines.push(line);
	}
	flush();
	if (!sections.some((s) => s.slide > 0)) {
		return { error: "No `## Slide N:` sections found — this isn't a SlideScribe lecture note." };
	}
	const f = parsed.fields;
	const slideCount = f.slide_count ? Number(f.slide_count) : undefined;
	return {
		title: f.title || heading1 || fallbackTitle,
		...(f.course ? { course: f.course } : {}),
		...(f.lecturer ? { lecturer: f.lecturer } : {}),
		...(f.date ? { date: f.date } : {}),
		...(f.source_pdf ? { sourcePdf: f.source_pdf } : {}),
		...(slideCount !== undefined && Number.isFinite(slideCount) ? { slideCount } : {}),
		...(f.generated_at ? { generatedAt: f.generated_at } : {}),
		sections,
	};
}

/** Index a note: one chunk per `## Slide N:` section (a very long one splits
 *  into consecutive chunks of the same slide); the marks ride along. */
export function chunkSlideScribeNote(note: SlideScribeNote): LibraryChunk[] {
	const chunks: LibraryChunk[] = [];
	for (const s of note.sections) {
		const section = s.slide === 0 ? "Extra from the lecture" : s.title || undefined;
		for (const piece of splitText(s.text, NOTE_CHUNK_CHARS)) {
			const marks = noteMarks(piece);
			chunks.push({
				index: chunks.length,
				page: s.slide,
				...(section ? { section } : {}),
				text: piece,
				...(marks ? { marks } : {}),
			});
		}
	}
	return chunks;
}

// ─── Citations ───────────────────────────────────────────────────────────────

/** "Robbins Pathology p.412" · "Acute abdomen, slide 7". */
export function citationFor(book: Pick<LibraryBook, "kind" | "title">, page: number): string {
	if (book.kind === "slidescribe") return page === 0 ? `${book.title}, extra notes` : `${book.title}, slide ${page}`;
	return `${book.title} p.${page}`;
}

/** The line that keeps SlideScribe's own marks visible next to a cited passage. */
export function marksNotice(marks: LibraryChunkMarks | undefined): string | null {
	if (!marks) return null;
	const parts: string[] = [];
	if (marks.warning) parts.push("⚠ check mark");
	if (marks.aiRead) parts.push("(AI read — verify)");
	return parts.length > 0 ? `Marks kept from the lecture note: ${parts.join(", ")} — say so when you cite this passage.` : null;
}

export const VISION_NOTICE = "Contains an AI-written image description — unverified.";

// ─── Page specs ──────────────────────────────────────────────────────────────

/** 'all' | '5' | '1-5' | '1,3,7' | 'extra' → ascending unique page numbers
 *  inside [lo, hi] (0 = the note's extra section, accepted as 'extra'). */
export function parseLibraryPages(spec: string, lo: number, hi: number): number[] {
	const trimmed = spec.trim().toLowerCase();
	if (trimmed === "all") return Array.from({ length: Math.max(0, hi - lo + 1) }, (_, i) => lo + i);
	const pages = new Set<number>();
	for (const part of trimmed.split(",")) {
		const p = part.trim();
		if (!p) continue;
		if (p === "extra") {
			if (lo <= 0) pages.add(0);
			continue;
		}
		const range = /^(\d+)\s*-\s*(\d+)$/.exec(p);
		if (range) {
			const start = Math.max(lo, Number(range[1]));
			const end = Math.min(hi, Number(range[2]));
			for (let pg = start; pg <= end; pg++) pages.add(pg);
			continue;
		}
		const n = /^\d+$/.test(p) ? Number(p) : NaN;
		if (Number.isFinite(n) && n >= lo && n <= hi) pages.add(n);
	}
	return [...pages].sort((a, b) => a - b);
}

// ─── Resolving a book by what the model typed ────────────────────────────────

export type BookRef = { ok: true; book: LibraryBook } | { ok: false; error: string };

/** Exact id, then exact title, then a unique case-insensitive substring. */
export function resolveBook(books: readonly LibraryBook[], ref: string): BookRef {
	const q = ref.trim();
	if (!q) return { ok: false, error: "No book given." };
	const lower = q.toLowerCase();
	const byId = books.find((b) => b.id === q);
	if (byId) return { ok: true, book: byId };
	const exact = books.filter((b) => b.title.toLowerCase() === lower);
	if (exact.length === 1) return { ok: true, book: exact[0]! };
	const partial = exact.length > 1 ? exact : books.filter((b) => b.title.toLowerCase().includes(lower));
	if (partial.length === 1) return { ok: true, book: partial[0]! };
	if (partial.length > 1) {
		return { ok: false, error: `"${q}" matches ${partial.length} books: ${partial.map((b) => `"${b.title}"`).join(", ")}. Use the full title.` };
	}
	return {
		ok: false,
		error: `No book called "${q}". Books in the library: ${books.length > 0 ? books.map((b) => `"${b.title}"`).join(", ") : "(none)"}.`,
	};
}

// ─── Keyword ranker (BM25) ───────────────────────────────────────────────────

const STOPWORDS = new Set(
	"a an and are as at be but by for from has have in into is it its of on or that the their then there these this to was were which with within without not no".split(
		" ",
	),
);

/** Lowercase word tokens; plural -s folded so "diuretics" finds "diuretic". */
export function tokenize(text: string): string[] {
	const out: string[] = [];
	for (const raw of text.toLowerCase().normalize("NFKD").replace(/\p{M}+/gu, "").split(/[^\p{L}\p{N}]+/u)) {
		if (!raw || STOPWORDS.has(raw)) continue;
		if (raw.length < 2 && !/\d/.test(raw)) continue;
		out.push(raw.length > 3 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
	}
	return out;
}

/** One book's term statistics — built once per book, kept in memory. */
export interface KeywordIndex {
	/** term frequencies per chunk (parallel to the chunk list). */
	docs: Array<{ length: number; tf: Map<string, number> }>;
	/** document frequency per term. */
	df: Map<string, number>;
	totalLength: number;
}

export function buildKeywordIndex(chunks: readonly Pick<LibraryChunk, "text" | "section">[]): KeywordIndex {
	const docs: KeywordIndex["docs"] = [];
	const df = new Map<string, number>();
	let totalLength = 0;
	for (const c of chunks) {
		const tf = new Map<string, number>();
		// The section heading is part of what a passage is about.
		const tokens = tokenize(c.section ? `${c.section}\n${c.text}` : c.text);
		for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
		for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
		docs.push({ length: tokens.length, tf });
		totalLength += tokens.length;
	}
	return { docs, df, totalLength };
}

export interface ScoredChunk {
	/** Index into the `indexes` array passed to the ranker. */
	set: number;
	/** Chunk index inside that set. */
	chunk: number;
	score: number;
}

/** BM25 over several books' indexes at once, with corpus statistics pooled
 *  across them so scores are comparable between books. */
export function bm25Search(indexes: readonly KeywordIndex[], query: string, limit: number): ScoredChunk[] {
	const terms = [...new Set(tokenize(query))];
	if (terms.length === 0) return [];
	let n = 0;
	let total = 0;
	for (const ix of indexes) {
		n += ix.docs.length;
		total += ix.totalLength;
	}
	if (n === 0) return [];
	const avg = total / n || 1;
	const k1 = 1.2;
	const b = 0.75;
	const idf = new Map<string, number>();
	for (const t of terms) {
		let df = 0;
		for (const ix of indexes) df += ix.df.get(t) ?? 0;
		idf.set(t, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
	}
	const scored: ScoredChunk[] = [];
	indexes.forEach((ix, set) => {
		ix.docs.forEach((doc, chunk) => {
			let score = 0;
			for (const t of terms) {
				const f = doc.tf.get(t);
				if (!f) continue;
				score += idf.get(t)! * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * doc.length) / avg)));
			}
			if (score > 0) scored.push({ set, chunk, score });
		});
	});
	return scored.sort((x, y) => y.score - x.score).slice(0, limit);
}

// ─── Vector ranker ───────────────────────────────────────────────────────────

/** Cosine of two unit vectors = their dot product. */
export function dot(a: Float32Array, b: Float32Array): number {
	let s = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
	return s;
}

/** Top-`limit` rows of each row-major matrix against the query vector. */
export function vectorSearch(
	matrices: ReadonlyArray<{ vectors: Float32Array; dim: number } | null>,
	query: Float32Array,
	limit: number,
): ScoredChunk[] {
	const scored: ScoredChunk[] = [];
	matrices.forEach((m, set) => {
		if (!m || m.dim !== query.length) return;
		const rows = Math.floor(m.vectors.length / m.dim);
		for (let chunk = 0; chunk < rows; chunk++) {
			const score = dot(m.vectors.subarray(chunk * m.dim, (chunk + 1) * m.dim), query);
			scored.push({ set, chunk, score });
		}
	});
	return scored.sort((x, y) => y.score - x.score).slice(0, limit);
}

// ─── Fusion ──────────────────────────────────────────────────────────────────

export interface FusedHit {
	set: number;
	chunk: number;
	score: number;
	via: Array<"keyword" | "meaning">;
}

/** Reciprocal-rank fusion (k = 60): rewards a passage both rankers like,
 *  never needs their raw scores to line up. */
export function fuseRankings(keyword: readonly ScoredChunk[], meaning: readonly ScoredChunk[], limit: number): FusedHit[] {
	const K = 60;
	const merged = new Map<string, FusedHit>();
	const add = (list: readonly ScoredChunk[], via: "keyword" | "meaning") => {
		list.forEach((hit, rank) => {
			const key = `${hit.set}:${hit.chunk}`;
			const entry = merged.get(key) ?? { set: hit.set, chunk: hit.chunk, score: 0, via: [] };
			entry.score += 1 / (K + rank + 1);
			entry.via.push(via);
			merged.set(key, entry);
		});
	};
	add(keyword, "keyword");
	add(meaning, "meaning");
	return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Shorten a passage for a result list without cutting mid-word. */
export function snippet(text: string, max = 520): string {
	const flat = text.replace(/\s*\n\s*/g, " ⏎ ").replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	const cut = flat.lastIndexOf(" ", max);
	return `${flat.slice(0, cut > max * 0.6 ? cut : max)} …`;
}

// ─── Vision triage ───────────────────────────────────────────────────────────

/** A safety cap on one import's vision calls (they spend ChatGPT Plus quota). */
export const MAX_VISION_PAGES = 300;

/** Which pages are image-heavy enough to be worth a vision call: a painted
 *  image on a page with little text, or a drawn (vector) diagram — some text
 *  labels but too few words to be prose. Blank pages are skipped. */
export function pickVisionPages(pages: ReadonlyArray<{ page: number; text: string; imageCount: number }>): number[] {
	const picked: number[] = [];
	for (const p of pages) {
		const len = tidyText(p.text).length;
		const imageHeavy = p.imageCount >= 1 && len < 800;
		const drawn = p.imageCount === 0 && len > 0 && len < 150;
		if (imageHeavy || drawn) picked.push(p.page);
		if (picked.length >= MAX_VISION_PAGES) break;
	}
	return picked;
}
