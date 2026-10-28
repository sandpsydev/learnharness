/**
 * Settings → Library (components/settings/library-section.tsx): SSR markup of
 * the presentational view — the per-PDF choice, the progress bar, errors and
 * notices, the SlideScribe "needs its PDF" prompt — plus the pure helpers.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { bookFacts, LibraryView, progressLabel, progressPercent, splitPicked, type LibraryViewProps } from "../components/settings/library-section.tsx";
import { SettingsDialogBody } from "../components/settings/settings-dialog.tsx";
import type { LibraryBook, LibraryListing } from "../src/core/index.ts";

const noop = () => {};
function book(over: Partial<LibraryBook>): LibraryBook {
	return {
		id: "bk_a1",
		kind: "pdf",
		title: "Robbins Pathology",
		fileName: "robbins.pdf",
		pageCount: 1200,
		importedAt: "2026-01-01T00:00:00.000Z",
		mode: "text",
		status: "ready",
		chunkCount: 1500,
		embeddings: { model: "m", dim: 384 },
		toc: [{ title: "Ch 1", page: 1, depth: 0 }],
		visionPages: [],
		...over,
	};
}
function listing(books: LibraryBook[], visionAvailable = true): LibraryListing {
	return {
		books,
		vision: visionAvailable ? { available: true } : { available: false, reason: "No vision model is set — choose one in Settings → Agent." },
		embeddingModel: { name: "bge-small-en-v1.5 (int8)", sizeMb: 35, license: "MIT", downloaded: false },
	};
}
function view(over: Partial<LibraryViewProps> = {}): string {
	return renderToStaticMarkup(
		<LibraryView
			listing={listing([])}
			pending={[]}
			onPickPdfs={noop}
			onPickNote={noop}
			onPickNotePdf={noop}
			onCancelNote={noop}
			onModeChange={noop}
			onDropPending={noop}
			onImport={noop}
			onRemove={noop}
			onRetry={noop}
			{...over}
		/>,
	);
}
const pdf = (name: string) => new File(["x"], name);
/** The whole opening tag carrying a testid (attribute order isn't contractual). */
function tagOf(html: string, testid: string): string {
	const i = html.indexOf(`data-testid="${testid}"`);
	assert.ok(i >= 0, `missing ${testid}`);
	return html.slice(html.lastIndexOf("<", i), html.indexOf(">", i) + 1);
}

describe("LibraryView", () => {
	it("empty library: both import buttons, the model facts (name, size, license), and the empty line", () => {
		const html = view();
		assert.match(html, /data-testid="library-add-pdfs"[^>]*>Add PDFs…/);
		assert.match(html, /Import SlideScribe note…/);
		assert.match(html, /bge-small-en-v1\.5 \(int8\), ~35 MB, MIT license/);
		assert.match(html, /downloaded once, the first time a book is indexed/);
		assert.match(html, /data-testid="library-empty"/);
	});

	it("a ready book offers Make Anki cards when the Anki action is wired; an indexing one does not", () => {
		const ready = view({ listing: listing([book({})]), onMakeCards: noop });
		assert.match(ready, /data-testid="library-anki-bk_a1"[^>]*>Make Anki cards…/);
		assert.ok(!view({ listing: listing([book({})]) }).includes("library-anki-"), "no Anki action without the handler");
		const indexing = view({ listing: listing([book({ status: "indexing", progress: { phase: "reading", done: 1, total: 10 } })]), onMakeCards: noop });
		assert.ok(!indexing.includes("library-anki-"), "not while indexing");
	});

	it("each pending PDF asks the per-PDF question; text only is the default", () => {
		const html = view({ pending: [{ file: pdf("Slides.pdf"), mode: "text" }, { file: pdf("Book.pdf"), mode: "vision" }] });
		assert.match(html, /data-testid="library-pending-0"/);
		assert.match(html, /data-testid="library-pending-1"/);
		assert.match(html, /Text only — fast and free/);
		assert.match(html, /ChatGPT vision describes image-heavy pages — slower, uses your ChatGPT Plus quota/);
		assert.match(html, /Import 2 PDFs/);
		assert.match(tagOf(html, "library-mode-text-0"), /checked/);
		assert.ok(!/checked/.test(tagOf(html, "library-mode-vision-0")));
		assert.match(tagOf(html, "library-mode-vision-1"), /checked/);
	});

	it("vision is disabled, with the reason, when the vision model isn't usable", () => {
		const html = view({ listing: listing([], false), pending: [{ file: pdf("Slides.pdf"), mode: "text" }] });
		assert.match(tagOf(html, "library-mode-vision-0"), /disabled/);
		assert.match(html, /Not available: No vision model is set/);
	});

	it("an indexing book shows a progress bar with the phase and counts, and a Cancel", () => {
		const html = view({ listing: listing([book({ status: "indexing", progress: { phase: "embedding", done: 300, total: 1200 } })]) });
		assert.match(html, /role="progressbar"/);
		assert.match(html, /aria-valuenow="25"/);
		assert.match(html, /style="width:25%"/);
		assert.match(html, /Building the search index 300 \/ 1200/);
		assert.match(html, /data-testid="library-remove-bk_a1"[^>]*>Cancel/);
	});

	it("a ready book shows its facts and Remove; keyword-only books offer 'Retry search model'", () => {
		const ready = view({ listing: listing([book({})]) });
		assert.match(ready, /1200 pages · 1 outline entries · keyword \+ meaning search/);
		assert.match(ready, />Remove</);
		assert.ok(!ready.includes("Retry search model"));
		const keywordOnly = view({ listing: listing([book({ embeddings: null, notice: "Meaning search is off for this book: offline." })]) });
		assert.match(keywordOnly, /keyword search only/);
		assert.match(keywordOnly, /data-testid="library-embed-bk_a1"/);
		assert.match(keywordOnly, /Meaning search is off for this book: offline\./);
	});

	it("an errored book shows the reason and Retry", () => {
		const html = view({ listing: listing([book({ status: "error", error: "Couldn't read this PDF: boom" })]) });
		assert.match(html, /role="alert"[^>]*>Couldn&#x27;t read this PDF: boom|role="alert"[^>]*>Couldn't read this PDF: boom/);
		assert.match(html, /data-testid="library-retry-bk_a1"/);
	});

	it("a SlideScribe lecture is labelled as a lecture note with its slide count", () => {
		const facts = bookFacts(book({ kind: "slidescribe", mode: "note", course: "Surgery", note: { sourcePdf: "l.pdf", slideCount: 40 }, pageCount: 40 }));
		assert.equal(facts, "Lecture note · Surgery · 40 slides · keyword + meaning search");
		assert.equal(bookFacts(book({ mode: "vision", visionPages: [3, 9], toc: [] })), "1200 pages · 2 images described · keyword + meaning search");
	});

	it("a note waiting for its PDF asks for the exact file name it declares", () => {
		const html = view({ needsPdf: { noteName: "Lecture 3.md", expectedName: "lecture-3.pdf" } });
		assert.match(html, /data-testid="library-needs-pdf"/);
		assert.match(html, /Lecture 3\.md/);
		assert.match(html, /lecture-3\.pdf/);
		assert.match(html, /data-testid="library-pick-note-pdf"/);
	});

	it("shows load errors and import messages", () => {
		assert.match(view({ listing: null, loadError: "The library couldn't be loaded — refresh to retry." }), /role="alert"[^>]*>The library couldn/);
		assert.match(view({ message: "Imported — indexing has started." }), /data-testid="library-message"[^>]*>Imported — indexing has started\./);
	});
});

describe("helpers", () => {
	it("progressLabel reads the phase; a message wins (model download line)", () => {
		assert.equal(progressLabel({ progress: { phase: "queued", done: 0, total: 9 } }), "Waiting for its turn…");
		assert.equal(progressLabel({ progress: { phase: "reading", done: 5, total: 50 } }), "Reading pages 5 / 50");
		assert.equal(progressLabel({ progress: { phase: "describing", done: 2, total: 8 } }), "ChatGPT is describing image-heavy pages 2 / 8");
		assert.equal(progressLabel({ progress: { phase: "embedding", done: 0, total: 8, message: "Downloading the search model (one time, ~35 MB): 40%" } }), "Downloading the search model (one time, ~35 MB): 40%");
		assert.equal(progressLabel({}), "Indexing…");
	});

	it("progressPercent clamps and tolerates a zero total", () => {
		assert.equal(progressPercent({ progress: { phase: "reading", done: 1, total: 3 } }), 33);
		assert.equal(progressPercent({ progress: { phase: "reading", done: 9, total: 3 } }), 100);
		assert.equal(progressPercent({ progress: { phase: "reading", done: 0, total: 0 } }), 0);
		assert.equal(progressPercent({}), 0);
	});

	it("splitPicked tells the note from the PDFs, whatever the case", () => {
		const { note, pdfs } = splitPicked([pdf("A.PDF"), pdf("lecture.md"), pdf("b.pdf"), pdf("readme.txt")]);
		assert.equal(note?.name, "lecture.md");
		assert.deepEqual(pdfs.map((f) => f.name), ["A.PDF", "b.pdf"]);
		assert.equal(splitPicked([pdf("a.pdf")]).note, undefined);
	});
});

describe("settings dialog", () => {
	it("has a Library section between Agent and Appearance", () => {
		const html = renderToStaticMarkup(<SettingsDialogBody onClose={noop} />);
		assert.match(html, /data-testid="settings-nav-library"/);
		const order = ["agent", "library", "appearance"].map((id) => html.indexOf(`data-testid="settings-nav-${id}"`));
		assert.deepEqual([...order].sort((a, b) => a - b), order);
	});
});
