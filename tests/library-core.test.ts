/**
 * The library's pure brain (core/library.ts): chunking, the SlideScribe
 * parser (against a fixture laid out like slidescribe/assemble.py's output),
 * keyword + vector ranking, rank fusion, citations, page specs, book lookup.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LibraryBook } from "../src/core/contracts.ts";
import {
	bm25Search,
	buildKeywordIndex,
	chunkPdfPages,
	chunkSlideScribeNote,
	citationFor,
	fuseRankings,
	marksNotice,
	noteMarks,
	parseFrontmatter,
	parseLibraryPages,
	parseSlideScribeNote,
	pickVisionPages,
	resolveBook,
	sectionFor,
	snippet,
	splitText,
	tokenize,
	vectorSearch,
	VISION_HEADING,
} from "../src/core/library.ts";
import { makeSlideScribeNote } from "./library-fixtures.ts";

function book(over: Partial<LibraryBook>): LibraryBook {
	return {
		id: "bk_x",
		kind: "pdf",
		title: "Book",
		fileName: "book.pdf",
		pageCount: 10,
		importedAt: "2026-01-01T00:00:00.000Z",
		mode: "text",
		status: "ready",
		chunkCount: 1,
		embeddings: null,
		toc: [],
		visionPages: [],
		...over,
	};
}

describe("chunking", () => {
	it("splitText keeps short text whole and packs long text on line boundaries under the cap", () => {
		assert.deepEqual(splitText("one line", 100), ["one line"]);
		const lines = Array.from({ length: 30 }, (_, i) => `line number ${i} with some padding words`);
		const pieces = splitText(lines.join("\n"), 200);
		assert.ok(pieces.length > 3);
		assert.ok(pieces.every((p) => p.length <= 200));
		assert.equal(pieces.join("\n"), lines.join("\n"), "nothing lost, nothing reordered");
	});

	it("splitText breaks an over-long single line at a sentence end or a space", () => {
		const long = "The first sentence is long enough to count as a real sentence here. " + "word ".repeat(80);
		const pieces = splitText(long, 120);
		assert.ok(pieces.length >= 3);
		assert.ok(pieces.every((p) => p.length <= 120));
		assert.ok(pieces[0]!.endsWith("here."));
	});

	it("sectionFor gives the outline path at a page (deepest entry at or before it)", () => {
		const toc = [
			{ title: "Chapter 1", page: 1, depth: 0 },
			{ title: "Diuretics", page: 3, depth: 1 },
			{ title: "Chapter 2", page: 8, depth: 0 },
		];
		assert.equal(sectionFor(toc, 1), "Chapter 1");
		assert.equal(sectionFor(toc, 5), "Chapter 1 > Diuretics");
		assert.equal(sectionFor(toc, 9), "Chapter 2", "a new top-level entry clears the old child");
		assert.equal(sectionFor([], 4), undefined);
	});

	it("chunkPdfPages: one chunk per page with page + section; empty pages are skipped", () => {
		const toc = [{ title: "Renal", page: 1, depth: 0 }];
		const chunks = chunkPdfPages(
			[
				{ page: 1, text: "Furosemide blocks the NKCC2 transporter." },
				{ page: 2, text: "  " },
				{ page: 3, text: "Thiazides block NCC in the distal tubule." },
			],
			toc,
		);
		assert.deepEqual(chunks.map((c) => [c.index, c.page, c.section]), [[0, 1, "Renal"], [1, 3, "Renal"]]);
	});

	it("chunkPdfPages: a long page splits into several chunks of the SAME page", () => {
		const text = Array.from({ length: 80 }, (_, i) => `Sentence ${i} about the loop of Henle and its transporters.`).join("\n");
		const chunks = chunkPdfPages([{ page: 7, text }], []);
		assert.ok(chunks.length > 1);
		assert.ok(chunks.every((c) => c.page === 7));
		assert.deepEqual(chunks.map((c) => c.index), chunks.map((_, i) => i));
	});

	it("chunkPdfPages: vision text is appended under the AI-read heading and flagged", () => {
		const [c] = chunkPdfPages([{ page: 4, text: "Figure 3", vision: "A chest radiograph showing a right pleural effusion." }], []);
		assert.ok(c!.text.includes(VISION_HEADING));
		assert.ok(c!.text.includes("pleural effusion"));
		assert.equal(c!.visionText, true);
		const [plain] = chunkPdfPages([{ page: 4, text: "A page of ordinary text." }], []);
		assert.equal(plain!.visionText, undefined);
	});

	it("a page with only a vision description (no extractable text) is still indexed", () => {
		const chunks = chunkPdfPages([{ page: 2, text: "", vision: "A flowchart of the clotting cascade." }], []);
		assert.equal(chunks.length, 1);
		assert.equal(chunks[0]!.page, 2);
	});
});

describe("pickVisionPages", () => {
	const pages = [
		{ page: 1, text: "x".repeat(3000), imageCount: 0 }, // prose
		{ page: 2, text: "Fig. 2", imageCount: 1 }, // photo with a caption
		{ page: 3, text: "x".repeat(900), imageCount: 2 }, // prose with small figure
		{ page: 4, text: "", imageCount: 0 }, // blank
		{ page: 5, text: "Label A  Label B", imageCount: 0 }, // vector diagram
		{ page: 6, text: "x".repeat(200), imageCount: 0 }, // short prose, no picture
	];
	it("picks image-heavy and drawn pages, not prose or blanks", () => {
		assert.deepEqual(pickVisionPages(pages), [2, 5]);
	});
});

describe("SlideScribe notes", () => {
	const markdown = makeSlideScribeNote({
		slides: [
			{ n: 1, title: "Overview", takeaway: "Loop diuretics block NKCC2.", onSlide: "A nephron diagram.", explained: "Furosemide acts in the thick ascending limb." },
			{
				n: 2,
				title: "[Chest film]",
				takeaway: "Free air under the diaphragm means perforation.",
				onSlide: "An erect film with a lucent crescent (AI read — verify).",
				explained: "⚠ Check: the slide and the lecturer differ on the dose.",
				stressed: "This is examined.",
			},
		],
		extra: "Ask about the exam format.",
	});

	it("parses the frontmatter the way assemble.py writes it", () => {
		const fm = parseFrontmatter(markdown)!;
		assert.equal(fm.fields.title, "Fixture Lecture 3 - Test Topic");
		assert.equal(fm.fields.source_pdf, "fixture-lecture.pdf");
		assert.equal(fm.fields.slide_count, "2");
		assert.equal(fm.fields.lecturer, "Dr Example");
		assert.equal(fm.fields.engines, undefined, "nested blocks are skipped");
	});

	it("splits per `## Slide N:` section, keeps the extra section, drops Run notes", () => {
		const note = parseSlideScribeNote(markdown);
		assert.ok(!("error" in note));
		if ("error" in note) return;
		assert.equal(note.title, "Fixture Lecture 3 - Test Topic");
		assert.equal(note.course, "Fixture Course");
		assert.equal(note.sourcePdf, "fixture-lecture.pdf");
		assert.equal(note.slideCount, 2);
		assert.deepEqual(note.sections.map((s) => [s.slide, s.title]), [[1, "Overview"], [2, "[Chest film]"], [0, "Extra from the lecture"]]);
		assert.ok(note.sections[0]!.text.startsWith("## Slide 1: Overview"));
		assert.ok(!note.sections.some((s) => s.text.includes("Nothing to flag")), "Run notes are not lecture content");
	});

	it("chunks one per slide section and keeps ⚠ / (AI read — verify) marks on the chunk", () => {
		const note = parseSlideScribeNote(markdown);
		if ("error" in note) throw new Error(note.error);
		const chunks = chunkSlideScribeNote(note);
		assert.deepEqual(chunks.map((c) => c.page), [1, 2, 0]);
		assert.equal(chunks[0]!.marks, undefined);
		assert.deepEqual(chunks[1]!.marks, { warning: true, aiRead: true });
		assert.equal(chunks[1]!.section, "[Chest film]");
	});

	it("rejects files that aren't SlideScribe notes, with a reason", () => {
		const noFront = parseSlideScribeNote("# Just notes\n\n## Slide 1: x\ntext");
		assert.ok("error" in noFront && /frontmatter/i.test(noFront.error));
		const noSlides = parseSlideScribeNote('---\ntitle: "T"\n---\n\n# T\n\nNo sections here.');
		assert.ok("error" in noSlides && /Slide N/.test(noSlides.error));
	});

	it("falls back to the first heading when the frontmatter has no title", () => {
		const note = parseSlideScribeNote('---\ncourse: "C"\n---\n\n# Heading Title\n\n## Slide 1: a\nbody');
		assert.ok(!("error" in note));
		if (!("error" in note)) assert.equal(note.title, "Heading Title");
	});

	it("noteMarks / marksNotice see both marks, tolerate dash variants, and say nothing otherwise", () => {
		assert.deepEqual(noteMarks("⚠ Check: dose"), { warning: true });
		assert.deepEqual(noteMarks("shows a lesion (AI read - verify)"), { aiRead: true });
		assert.equal(noteMarks("plain text"), undefined);
		assert.match(marksNotice({ warning: true, aiRead: true })!, /⚠ check mark, \(AI read — verify\)/);
		assert.equal(marksNotice(undefined), null);
	});
});

describe("citations and lookups", () => {
	it("cites a PDF as 'title p.N' and a lecture note as 'title, slide N'", () => {
		assert.equal(citationFor({ kind: "pdf", title: "Robbins" }, 412), "Robbins p.412");
		assert.equal(citationFor({ kind: "slidescribe", title: "Acute abdomen" }, 7), "Acute abdomen, slide 7");
		assert.equal(citationFor({ kind: "slidescribe", title: "Acute abdomen" }, 0), "Acute abdomen, extra notes");
	});

	it("parseLibraryPages: all / single / range / list / clamping / extra", () => {
		assert.deepEqual(parseLibraryPages("all", 1, 4), [1, 2, 3, 4]);
		assert.deepEqual(parseLibraryPages("3", 1, 10), [3]);
		assert.deepEqual(parseLibraryPages("2-4", 1, 10), [2, 3, 4]);
		assert.deepEqual(parseLibraryPages("9-20", 1, 10), [9, 10]);
		assert.deepEqual(parseLibraryPages("5, 1,5", 1, 10), [1, 5]);
		assert.deepEqual(parseLibraryPages("0", 1, 10), []);
		assert.deepEqual(parseLibraryPages("extra", 0, 10), [0]);
		assert.deepEqual(parseLibraryPages("extra", 1, 10), []);
		assert.deepEqual(parseLibraryPages("all", 0, 2), [0, 1, 2], "a note's 'all' includes the extra section");
	});

	it("resolveBook: id, exact title, unique substring; honest errors otherwise", () => {
		const books = [book({ id: "bk_a", title: "Robbins Pathology" }), book({ id: "bk_b", title: "Robbins Basic Pathology" }), book({ id: "bk_c", title: "Guyton Physiology" })];
		assert.deepEqual(resolveBook(books, "bk_c"), { ok: true, book: books[2] });
		assert.deepEqual(resolveBook(books, "robbins pathology"), { ok: true, book: books[0] });
		assert.deepEqual(resolveBook(books, "guyton"), { ok: true, book: books[2] });
		const ambiguous = resolveBook(books, "robbins");
		assert.ok(!ambiguous.ok && /matches 2 books/.test(ambiguous.error));
		const none = resolveBook(books, "harrison");
		assert.ok(!none.ok && /Books in the library/.test(none.error));
	});
});

describe("ranking", () => {
	const docs = [
		{ text: "Furosemide is a loop diuretic that blocks the Na-K-2Cl cotransporter in the thick ascending limb." },
		{ text: "Insulin promotes glucose uptake into muscle and adipose tissue." },
		{ text: "Thiazide diuretics block the sodium chloride cotransporter in the distal convoluted tubule." },
	];

	it("tokenize lowercases, drops stopwords, folds plurals", () => {
		assert.deepEqual(tokenize("The Diuretics of the Loop"), ["diuretic", "loop"]);
		assert.deepEqual(tokenize("Na-K-2Cl, T2 and café"), ["na", "2cl", "t2", "cafe"], "single letters drop, digits stay, accents fold");
	});

	it("bm25 ranks the passage with the rare matching term first, across books", () => {
		const a = buildKeywordIndex([docs[0]!, docs[1]!]);
		const b = buildKeywordIndex([docs[2]!]);
		const hits = bm25Search([a, b], "furosemide loop diuretic", 5);
		assert.deepEqual([hits[0]!.set, hits[0]!.chunk], [0, 0]);
		assert.ok(hits.some((h) => h.set === 1), "the thiazide passage matches 'diuretic' too");
		assert.deepEqual(bm25Search([a], "zzzz", 5), []);
		assert.deepEqual(bm25Search([a], "the of and", 5), [], "stopwords alone match nothing");
	});

	it("the section heading counts as text for the keyword index", () => {
		const ix = buildKeywordIndex([{ text: "Details follow.", section: "Nephrotic syndrome" }, { text: "Other prose." }]);
		const hits = bm25Search([ix], "nephrotic", 3);
		assert.equal(hits[0]!.chunk, 0);
	});

	it("vectorSearch ranks rows by dot product and skips books without vectors", () => {
		const m = { dim: 2, vectors: new Float32Array([1, 0, 0, 1, 0.8, 0.6]) };
		const hits = vectorSearch([null, m], new Float32Array([0, 1]), 2);
		assert.deepEqual(hits.map((h) => [h.set, h.chunk]), [[1, 1], [1, 2]]);
		assert.deepEqual(vectorSearch([m], new Float32Array([1, 0, 0]), 2), [], "dimension mismatch is ignored, not guessed");
	});

	it("fuseRankings rewards agreement and tags which rankers found each hit", () => {
		const kw = [{ set: 0, chunk: 1, score: 9 }, { set: 0, chunk: 2, score: 5 }];
		const mean = [{ set: 0, chunk: 2, score: 0.9 }, { set: 0, chunk: 3, score: 0.8 }];
		const fused = fuseRankings(kw, mean, 10);
		assert.equal(fused[0]!.chunk, 2, "found by both rankers wins");
		assert.deepEqual(fused[0]!.via, ["keyword", "meaning"]);
		assert.deepEqual(fused.map((f) => f.chunk).sort(), [1, 2, 3]);
		assert.equal(fuseRankings(kw, mean, 2).length, 2);
	});

	it("snippet shortens at a word boundary and flattens line breaks", () => {
		assert.equal(snippet("short\ntext"), "short ⏎ text");
		const out = snippet("word ".repeat(300), 100);
		assert.ok(out.length <= 104 && out.endsWith("…"));
	});
});
