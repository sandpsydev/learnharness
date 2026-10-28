import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * PDF plumbing for the pdf-reader sub-agent — sources v0 (2026-09): Node
 * ports of the four pdf-reader skill scripts (pdf_info / pdf_extract /
 * pdf_search / pdf_render), on the user-chosen hybrid stack:
 *
 * - TEXT (info / extract / search): pdfjs-dist — pure JS, no native deps.
 * - RENDER: subagents/headless.ts uses the same pdfjs engine with
 *   @napi-rs/canvas (Skia), in-process — no browser needed.
 *
 * Doctrine (the skill's reading strategy, mirrored in the sub-agent's system
 * prompt): triage with pdf_info FIRST, then size-based strategy — short PDFs
 * render all pages, medium render flagged (math/image-heavy) pages, long
 * ones search for targeted lookups before reading anything at length.
 *
 * These are pure library functions — no model in sight. The pdf-reader
 * agent (pdf-reader.ts) drives them through its own tool loop.
 */

export interface PdfPageInfo {
	page: number;
	text_length: number;
	image_count: number;
	/** Fraction of math-flavored chars — the render-this-page signal (port
	 *  of the skill's unicode-range density heuristic). */
	math_density: number;
}

export interface PdfInfo {
	path: string;
	page_count: number;
	/** Mean chars/page — the size class the strategy branches on. */
	mean_text_length: number;
	pages: PdfPageInfo[];
}

/** Load the legacy pdfjs build (runs headless in plain node, no worker). */
async function loadPdfjs() {
	const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
	return pdfjs;
}

/** Standard-font data dir (live-smoke finding 2026-09-19: without it pdfjs
 *  warns and falls back on non-embedded standard fonts — Helvetica, Times…).
 *  The node side takes a plain filesystem path, shared by text and rendering.
 *  pdfjs checks endsWith("/") even on Windows: use a literal trailing slash,
 *  NOT path.sep ("\\" on Windows). Node fs accepts this path on every OS. */
export function standardFontsDir(): string {
	return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "node_modules", "pdfjs-dist", "standard_fonts") + "/";
}

async function openDocument(source: string | Uint8Array) {
	const pdfjs = await loadPdfjs();
	const data = typeof source === "string" ? new Uint8Array(await fs.readFile(source)) : new Uint8Array(source);
	// The legacy build in plain node runs on a main-thread fake worker (no
	// workerSrc needed); teardown is the loading task's destroy().
	// verbosity 0 = errors only — scanned PDFs (JBIG2 XObjects) otherwise
	// flood the log with per-page warnings (live-smoke finding 2026-09-19).
	const task = pdfjs.getDocument({ data, standardFontDataUrl: standardFontsDir(), verbosity: 0 });
	return { doc: await task.promise, task };
}

/** Concatenate a page's text items into a body string. */
function itemsToText(items: unknown[]): string {
	let out = "";
	for (const it of items) {
		if (it && typeof it === "object" && "str" in (it as Record<string, unknown>)) {
			const str = (it as { str?: unknown }).str;
			if (typeof str === "string") out += str;
		}
	}
	return out;
}

/** Math-flavored char fraction — the skill's heuristic, verbatim ranges. */
function mathDensity(text: string): number {
	let mathChars = 0;
	for (const c of text) {
		const code = c.codePointAt(0)!;
		if (
			(code >= 0x2200 && code <= 0x22ff) || // Mathematical Operators
			(code >= 0x2100 && code <= 0x214f) || // Letterlike Symbols
			(code >= 0x2190 && code <= 0x21ff) || // Arrows
			(code >= 0x27c0 && code <= 0x27ef) || // Misc Mathematical Symbols-A
			(code >= 0x2980 && code <= 0x29ff) || // Misc Mathematical Symbols-B
			(code >= 0x2a00 && code <= 0x2aff) || // Supplemental Mathematical Operators
			(code >= 0x0370 && code <= 0x03ff) || // Greek
			(code >= 0x1d400 && code <= 0x1d7ff) || // Mathematical Alphanumeric Symbols
			"∫∑∏√∂∇∞≈≠≤≥±×÷∈∉⊂⊃∪∩∧∨¬∀∃∅".includes(c)
		) {
			mathChars++;
		}
	}
	return mathChars / Math.max(text.length, 1);
}

/** Cheap validity probe: getDocument resolves only for parseable PDFs —
 *  no page walk, no text extraction (unlike pdfInfo). The reader's upfront
 *  unreadable-source gate; garbage files throw pdfjs's precise error. */
export async function pdfProbe(filePath: string): Promise<void> {
	const { task } = await openDocument(filePath);
	await task.destroy();
}

/** pdf_info: page count + per-page triage signals. ALWAYS run first. */
export async function pdfInfo(filePath: string): Promise<PdfInfo> {
	const pdfjs = await loadPdfjs(); // OPS constant for the operator-list scan
	const { doc } = await openDocument(filePath);
	const pages: PdfPageInfo[] = [];
	let totalText = 0;
	for (let i = 1; i <= doc.numPages; i++) {
		const page = await doc.getPage(i);
		const content = await page.getTextContent();
		const text = itemsToText(content.items as unknown[]);
		// count page images: paintImageXObject ops in the operator list
		const ops = await page.getOperatorList();
		let imageCount = 0;
		for (const fn of ops.fnArray) {
			if (fn === pdfjs.OPS.paintImageXObject) imageCount++;
		}
		totalText += text.length;
		pages.push({
			page: i,
			text_length: text.length,
			image_count: imageCount,
			math_density: Math.round(mathDensity(text) * 10000) / 10000,
		});
	}
	return {
		path: filePath,
		page_count: doc.numPages,
		mean_text_length: Math.round(totalText / Math.max(doc.numPages, 1)),
		pages,
	};
}

/** Parse 'all' | '1-5' | '1,3,7' | '3' into a sorted 1-indexed page list. */
export function parsePageSpec(spec: string, total: number): number[] {
	const trimmed = spec.trim().toLowerCase();
	if (trimmed === "all") return Array.from({ length: total }, (_, i) => i + 1);
	const pages = new Set<number>();
	for (const part of spec.split(",")) {
		const p = part.trim();
		if (!p) continue;
		if (p.includes("-")) {
			const [startRaw, endRaw] = p.split("-", 2) as [string, string];
			const start = Math.max(1, parseInt(startRaw, 10));
			const end = Math.min(total, parseInt(endRaw, 10));
			for (let pg = start; pg <= end; pg++) pages.add(pg);
		} else {
			const pg = parseInt(p, 10);
			if (pg >= 1 && pg <= total) pages.add(pg);
		}
	}
	return [...pages].sort((a, b) => a - b);
}

/** pdf_extract: text of the requested pages, `--- Page N ---` headed. */
export async function pdfExtract(filePath: string, pageSpec: string): Promise<string> {
	const { doc } = await openDocument(filePath);
	const pages = parsePageSpec(pageSpec, doc.numPages);
	if (pages.length === 0) return "No pages selected — page spec matched nothing.";
	const out: string[] = [];
	for (const i of pages) {
		const page = await doc.getPage(i);
		const content = await page.getTextContent();
		out.push(`--- Page ${i} ---`);
		out.push(itemsToText(content.items as unknown[]));
	}
	return out.join("\n");
}

export interface PdfSearchHit {
	page: number;
	line: number;
	/** contextLines around the hit, `>>>` marking the hit line. */
	context: string;
}

/** pdf_search: keyword/regex across all pages with context lines.
 *  pageTexts rides along so the agent can extract a hit's full page without
 *  a second pass (the skill pipelines `search → extract` the same way). */
export async function pdfSearch(
	filePath: string,
	query: string,
	opts?: { contextLines?: number; literal?: boolean },
): Promise<{ hits: PdfSearchHit[]; pageTexts: Map<number, string> }> {
	const contextLines = opts?.contextLines ?? 3;
	const { doc } = await openDocument(filePath);
	let pattern: RegExp;
	if (opts?.literal) {
		pattern = new RegExp(escapeRegex(query), "i");
	} else {
		try {
			pattern = new RegExp(query, "i");
		} catch (err) {
			throw new Error(`Invalid regex: ${(err as Error).message}`);
		}
	}
	const hits: PdfSearchHit[] = [];
	const pageTexts = new Map<number, string>();
	for (let i = 1; i <= doc.numPages; i++) {
		const page = await doc.getPage(i);
		const content = await page.getTextContent();
		const text = itemsToText(content.items as unknown[]);
		pageTexts.set(i, text);
		const lines = text.split("\n");
		for (let ln = 0; ln < lines.length; ln++) {
			if (!pattern.test(lines[ln]!)) continue;
			const start = Math.max(0, ln - contextLines);
			const end = Math.min(lines.length, ln + contextLines + 1);
			const context = lines
				.slice(start, end)
				.map((l, j) => `${start + j === ln ? ">>>" : "   "} ${l}`)
				.join("\n");
			hits.push({ page: i, line: ln + 1, context });
		}
	}
	return { hits, pageTexts };
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Where rendered pages land (mirrors the skill's /tmp convention). */
export function renderDir(filePath: string): string {
	// FNV-1a short hash of the absolute path — stable per file, no deps.
	const abs = path.resolve(filePath);
	let h = 0x811c9dc5;
	for (let i = 0; i < abs.length; i++) {
		h ^= abs.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return path.join("/tmp", `lh-pdf-${h.toString(16).padStart(8, "0")}`);
}

// ─── Library indexing (medical fork, Phase 6) ───────────────────────────────
//
// The PDF library reads whole books through the same pdfjs plumbing: ONE
// document open, line-aware page text (itemsToText above glues a page into a
// single line — fine for pdf_search's regexes, poor for chunking and for
// keyword ranking), the per-page image count for the vision-pass triage, and
// the outline (bookmarks) the PDF carries.

/** Page count from raw bytes — the importer's validity gate before it copies
 *  anything. pdfjs throws its precise error for a file that isn't a PDF. */
export async function pdfPageCountOf(bytes: Uint8Array): Promise<number> {
	const { doc, task } = await openDocument(bytes);
	try {
		return doc.numPages;
	} finally {
		await task.destroy();
	}
}

/** Text items → lines: a new line on pdfjs's end-of-line flag or a vertical
 *  jump, a space where two runs sit apart on the same line. */
export function itemsToLines(items: unknown[]): string {
	let out = "";
	let prevY: number | null = null;
	let prevEnd: number | null = null;
	for (const it of items) {
		if (!it || typeof it !== "object" || typeof (it as { str?: unknown }).str !== "string") continue;
		const item = it as { str: string; hasEOL?: boolean; transform?: number[]; width?: number; height?: number };
		const x = item.transform?.[4];
		const y = item.transform?.[5];
		const h = item.height || 0;
		if (out && prevY !== null && typeof y === "number" && Math.abs(y - prevY) > Math.max(h * 0.5, 1)) {
			if (!out.endsWith("\n")) out += "\n";
		} else if (out && typeof x === "number" && prevEnd !== null && x - prevEnd > Math.max(h * 0.15, 0.5)) {
			if (!/\s$/.test(out) && !/^\s/.test(item.str)) out += " ";
		}
		out += item.str;
		if (typeof y === "number") prevY = y;
		prevEnd = typeof x === "number" && typeof item.width === "number" ? x + item.width : null;
		if (item.hasEOL && !out.endsWith("\n")) out += "\n";
	}
	return out;
}

export interface PdfPageContent {
	page: number;
	text: string;
	/** Painted images on the page (0 unless `images: true` was asked for). */
	imageCount: number;
}

export interface PdfOutlineEntry {
	title: string;
	page: number;
	depth: number;
}

export interface PdfBookRead {
	pageCount: number;
	pages: PdfPageContent[];
	outline: PdfOutlineEntry[];
}

interface OutlineNode {
	title?: string;
	dest?: unknown;
	items?: OutlineNode[];
}

/** Flatten the outline tree in reading order, resolving each destination to a
 *  1-based page. Unresolvable entries are dropped, never guessed. */
async function readOutline(doc: Awaited<ReturnType<typeof openDocument>>["doc"]): Promise<PdfOutlineEntry[]> {
	const entries: PdfOutlineEntry[] = [];
	let root: OutlineNode[] | null;
	try {
		root = (await doc.getOutline()) as OutlineNode[] | null;
	} catch {
		return [];
	}
	if (!root) return [];
	const walk = async (nodes: OutlineNode[], depth: number): Promise<void> => {
		for (const node of nodes) {
			if (entries.length >= 2000) return;
			try {
				let dest = node.dest;
				if (typeof dest === "string") dest = await doc.getDestination(dest);
				if (Array.isArray(dest) && dest[0] !== undefined && dest[0] !== null) {
					const ref = dest[0];
					const index = typeof ref === "number" ? ref : await doc.getPageIndex(ref as never);
					const title = (node.title ?? "").replace(/\s+/g, " ").trim();
					if (title && Number.isInteger(index) && index >= 0 && index < doc.numPages) {
						entries.push({ title, page: index + 1, depth });
					}
				}
			} catch {
				/* a dangling destination: skip the entry */
			}
			if (node.items?.length) await walk(node.items, depth + 1);
		}
	};
	await walk(root, 0);
	return entries;
}

/** Read every page's text (and optionally image counts) plus the outline.
 *  `onPage` fires after each page; `signal` aborts between pages. */
export async function readPdfBook(
	filePath: string,
	opts: { images?: boolean; onPage?: (page: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<PdfBookRead> {
	const pdfjs = opts.images ? await loadPdfjs() : null;
	const { doc, task } = await openDocument(filePath);
	try {
		const pages: PdfPageContent[] = [];
		for (let i = 1; i <= doc.numPages; i++) {
			if (opts.signal?.aborted) {
				const err = new Error("aborted");
				err.name = "AbortError";
				throw err;
			}
			const page = await doc.getPage(i);
			const content = await page.getTextContent();
			let imageCount = 0;
			if (pdfjs) {
				const ops = await page.getOperatorList();
				for (const fn of ops.fnArray) if (fn === pdfjs.OPS.paintImageXObject) imageCount++;
			}
			pages.push({ page: i, text: itemsToLines(content.items as unknown[]), imageCount });
			page.cleanup();
			opts.onPage?.(i, doc.numPages);
		}
		return { pageCount: doc.numPages, pages, outline: await readOutline(doc) };
	} finally {
		await task.destroy();
	}
}
