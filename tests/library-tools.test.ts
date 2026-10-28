/**
 * library_search / library_read (agent/tools/library.ts) over a real store,
 * real indexers and the real searcher — only the embedding model is faked.
 * Also pins: which agents get the pair and when, and that the prompt
 * fragments reach prober, teacher and practice.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { indexNoteBook, indexPdfBook } from "../src/agent/library/indexer.ts";
import { createLibrarySearcher, type LibraryReader } from "../src/agent/library/searcher.ts";
import { effectivePromptSegments } from "../src/agent/prompt-segments.ts";
import { createProberTools, createTeacherTools } from "../src/agent/tools.ts";
import { LIBRARY_TOOL_NAMES, libraryTools } from "../src/agent/tools/library.ts";
import { practiceTools } from "../src/agent/tools/practice.ts";
import type { LibraryEmbedder } from "../src/core/library.ts";
import type { ChatStore, JobStore, LibraryStore } from "../src/core/ports.ts";
import { createLibraryStore } from "../src/store/library.ts";
import { fakeEmbedder, makePdf, makeSlideScribeNote } from "./library-fixtures.ts";

const ID = "tool-call";

describe("library tools over a real index", () => {
	let root: string;
	let store: LibraryStore;
	let embedder: LibraryEmbedder;
	let reader: LibraryReader;
	let useEmbedder = true;
	let robbinsId: string;
	let lectureId: string;

	before(async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-library-tools-"));
		store = createLibraryStore(path.join(root, "library"));
		embedder = fakeEmbedder();
		reader = createLibrarySearcher({ store, embedder: () => (useEmbedder ? embedder : null) });

		const textbook = store.createBook(
			{ kind: "pdf", title: "Robbins Pathology", fileName: "robbins.pdf", pageCount: 3, mode: "text", toc: [], visionPages: [] },
			{
				pdf: makePdf(
					[
						{ lines: ["Loop diuretics", "Furosemide blocks the Na-K-2Cl cotransporter in the thick ascending limb of the loop of Henle."] },
						{ lines: ["Insulin", "Insulin promotes glucose uptake into skeletal muscle and adipose tissue."] },
						{ lines: ["Heart", "Aortic stenosis causes a crescendo-decrescendo systolic murmur radiating to the carotids."] },
					],
					[{ title: "Renal pharmacology", page: 1 }, { title: "Cardiology", page: 3 }],
				),
			},
		);
		robbinsId = textbook.id;
		await indexPdfBook({ store, embedder, vision: null }, textbook.id);

		const lecture = store.createBook(
			{ kind: "slidescribe", title: "Acute abdomen", fileName: "ab.pdf", pageCount: 2, mode: "note", toc: [], visionPages: [], note: { sourcePdf: "ab.pdf", slideCount: 2 } },
			{
				pdf: makePdf([{ lines: ["s1"] }, { lines: ["s2"] }]),
				note: makeSlideScribeNote({
					title: "Acute abdomen",
					slides: [
						{ n: 1, title: "Perforation", takeaway: "Free air under the diaphragm on an erect film means perforation.", onSlide: "Erect chest film with a lucent crescent (AI read — verify).", explained: "⚠ Check: the lecturer gave a different threshold." },
						{ n: 2, title: "Appendicitis", takeaway: "Migration of pain to the right iliac fossa suggests appendicitis.", onSlide: "A timeline of pain.", explained: "McBurney point tenderness." },
					],
				}),
			},
		);
		lectureId = lecture.id;
		await indexNoteBook({ store, embedder, vision: null }, lecture.id);
	});
	after(() => fs.rmSync(root, { recursive: true, force: true }));

	const tools = () => libraryTools({ reader });
	const run = async (name: (typeof LIBRARY_TOOL_NAMES)[number], args: Record<string, unknown>) => {
		const result = await tools()[name]!.execute!(ID, args as never);
		return (result.content[0] as { text: string }).text;
	};

	it("exposes exactly the pair, with mechanical descriptions", () => {
		assert.deepEqual(Object.keys(tools()).sort(), [...LIBRARY_TOOL_NAMES].sort());
		for (const t of Object.values(tools())) assert.ok(t.description.length > 40);
	});

	it("search ranks the right passage first and cites 'book p.N' with its section", async () => {
		const out = await run("library_search", { query: "which drug blocks the Na-K-2Cl cotransporter" });
		assert.match(out, /^\d+ passages? for "which drug blocks/);
		const first = out.split("\n").find((l) => /^1\. /.test(l))!;
		assert.equal(first, "1. Robbins Pathology p.1 — Renal pharmacology");
		assert.match(out, /Furosemide blocks/);
		assert.match(out, /Cite a passage by the name and page/);
	});

	it("a lecture-note hit is cited '<lecture>, slide N' and keeps its ⚠ / (AI read — verify) marks visible", async () => {
		const out = await run("library_search", { query: "free air under the diaphragm perforation" });
		assert.match(out, /1\. Acute abdomen, slide 1 — Perforation/);
		assert.match(out, /Marks kept from the lecture note: ⚠ check mark, \(AI read — verify\)/);
	});

	it("search can be limited to one book (by title) and by count", async () => {
		const out = await run("library_search", { query: "pain", book: "acute abdomen", limit: 1 });
		assert.match(out, /Acute abdomen, slide/);
		assert.ok(!/Robbins/.test(out));
		assert.equal((out.match(/^\d+\. /gm) ?? []).length, 1);
	});

	it("an unknown book filter answers in plain words instead of throwing", async () => {
		const out = await run("library_search", { query: "anything", book: "Harrison" });
		assert.match(out, /No passages found/);
		assert.match(out, /No book called "Harrison"/);
	});

	it("keyword search still works with no embedding model on disk, and says nothing misleading", async () => {
		useEmbedder = false;
		try {
			const out = await run("library_search", { query: "furosemide" });
			assert.match(out, /Robbins Pathology p\.1/);
		} finally {
			useEmbedder = true;
		}
	});

	it("an unrelated query finds nothing rather than the nearest junk", async () => {
		const out = await run("library_search", { query: "zebra quokka" });
		assert.match(out, /No passages found/);
	});

	it("the meaning ranker contributes when vectors exist (hits tagged by ranker)", async () => {
		const { hits } = await reader.search("aortic stenosis murmur carotids");
		assert.deepEqual(hits[0]!.via, ["keyword", "meaning"]);
		assert.equal(hits[0]!.chunk.page, 3);
	});

	it("read returns whole pages under citation headers, honoring ranges and lists", async () => {
		const out = await run("library_read", { book: "Robbins Pathology", pages: "1,3" });
		assert.match(out, /--- Robbins Pathology p\.1 ---\nSection: Renal pharmacology\nLoop diuretics\nFurosemide blocks/);
		assert.match(out, /--- Robbins Pathology p\.3 ---/);
		assert.ok(!/p\.2 ---/.test(out));
	});

	it("read of a lecture note shows the section text verbatim plus its marks", async () => {
		const out = await run("library_read", { book: "Acute abdomen", pages: "1" });
		assert.match(out, /--- Acute abdomen, slide 1 ---/);
		assert.match(out, /\*\*Takeaway:\*\* Free air/);
		assert.match(out, /\(AI read — verify\)/);
		assert.match(out, /Marks kept from the lecture note/);
	});

	it("read reports pages with no text, and rejects specs and books that don't resolve", async () => {
		await assert.rejects(() => run("library_read", { book: "Robbins Pathology", pages: "99" }), /matched nothing/);
		await assert.rejects(() => run("library_read", { book: "Nope", pages: "1" }), /No book called "Nope"/);
		const extra = await run("library_read", { book: "Acute abdomen", pages: "extra" });
		assert.match(extra, /--- Acute abdomen, extra notes ---\n\(no text on this page/);
	});

	it("read truncates a huge request with a narrowing notice", async () => {
		const big = store.createBook(
			{ kind: "pdf", title: "Big", fileName: "big.pdf", pageCount: 40, mode: "text", toc: [], visionPages: [] },
			{ pdf: makePdf(Array.from({ length: 40 }, (_, i) => ({ lines: Array.from({ length: 25 }, (_, k) => `Page ${i + 1} line ${k}: ${"detail ".repeat(12)}`) }))) },
		);
		await indexPdfBook({ store, embedder: null, vision: null }, big.id);
		const out = await run("library_read", { book: "Big", pages: "all" });
		assert.match(out, /Output truncated at 24000 characters/);
		store.deleteBook(big.id);
	});

	it("a re-index is picked up without a restart (cache keyed by fingerprint)", async () => {
		const before = await run("library_search", { query: "quokka" });
		assert.match(before, /No passages found/);
		const chunks = store.readChunks(robbinsId);
		await new Promise((r) => setTimeout(r, 15));
		store.writeChunks(robbinsId, [...chunks, { index: chunks.length, page: 2, text: "The quokka is a small marsupial." }]);
		store.updateBook(robbinsId, { chunkCount: chunks.length + 1 });
		const after = await run("library_search", { query: "quokka" });
		assert.match(after, /Robbins Pathology p\.2/);
	});

	it("books still indexing are mentioned, not searched; an empty library says how to fill it", async () => {
		const pending = store.createBook({ kind: "pdf", title: "Pending", fileName: "p.pdf", pageCount: 1, mode: "text", toc: [], visionPages: [] }, { pdf: new Uint8Array([1]) });
		const out = await run("library_search", { query: "furosemide" });
		assert.match(out, /Still indexing, not searched yet: "Pending"/);
		store.deleteBook(pending.id);

		const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-library-empty-"));
		const empty = libraryTools({ reader: createLibrarySearcher({ store: createLibraryStore(emptyDir), embedder: () => null }) });
		const result = await empty.library_search!.execute!(ID, { query: "x" } as never);
		assert.match((result.content[0] as { text: string }).text, /library is empty.*Settings → Library/);
		assert.equal(createLibrarySearcher({ store: createLibraryStore(emptyDir), embedder: () => null }).hasBooks(), false);
		assert.equal(reader.hasBooks(), true);
		void lectureId;
	});
});

describe("registration: who gets the pair", () => {
	const fakeChatStore = { getChat: () => null, saveMessages: () => {} } as unknown as ChatStore;
	const fakeJobStore = { createJob: () => { throw new Error("unused"); } } as unknown as JobStore;
	const library = { reader: { hasBooks: () => true, search: async () => ({ hits: [], notes: [] }), read: () => ({ ok: false as const, error: "x" }) } };
	const base = { chatId: "c1", chatStore: fakeChatStore };
	const names = (tools: Record<string, unknown>) => LIBRARY_TOOL_NAMES.filter((n) => n in tools);

	it("prober, teacher and practice carry both tools when a library context is passed", () => {
		const jobs = { jobStore: fakeJobStore, spawn: () => {} };
		assert.deepEqual(names(createProberTools({ ...base, deliver: () => {}, ...jobs, library })), [...LIBRARY_TOOL_NAMES]);
		assert.deepEqual(names(createTeacherTools({ ...base, ...jobs, library })), [...LIBRARY_TOOL_NAMES]);
		assert.deepEqual(names(practiceTools({ ...base, library })), [...LIBRARY_TOOL_NAMES]);
	});

	it("…and neither when there is no library context (an empty library adds nothing to the prompt budget)", () => {
		const jobs = { jobStore: fakeJobStore, spawn: () => {} };
		assert.deepEqual(names(createProberTools({ ...base, deliver: () => {}, ...jobs })), []);
		assert.deepEqual(names(createTeacherTools({ ...base, ...jobs })), []);
		assert.deepEqual(names(practiceTools(base)), []);
	});

	it("a user toggle can still switch a library tool off (generic tool filter)", () => {
		const jobs = { jobStore: fakeJobStore, spawn: () => {} };
		const tools = createTeacherTools({ ...base, ...jobs, library }, { library_search: false });
		assert.deepEqual(names(tools), ["library_read"]);
	});

	it("the med-anki seam: spreading libraryTools(ctx) into any registry is all it takes", () => {
		const registry = { ...libraryTools(library) };
		assert.deepEqual(Object.keys(registry).sort(), [...LIBRARY_TOOL_NAMES].sort());
	});
});

describe("prompt fragments", () => {
	it("the shared library fragment composes into prober, teacher and practice", () => {
		for (const agent of ["prober", "teacher", "practice"] as const) {
			const segment = effectivePromptSegments(agent, {}).find((s) => s.path === "shared/35-library.md");
			assert.ok(segment, `${agent} composes shared/35-library.md`);
			assert.match(segment.sourceText, /library_search/);
			assert.match(segment.sourceText, /\(AI read — verify\)/);
		}
	});

	it("only the teacher is told to ground settled science in the books and cite 'book p.N'", () => {
		const teacher = effectivePromptSegments("teacher", {}).find((s) => s.path === "teacher/07-library.md");
		assert.ok(teacher);
		assert.match(teacher.sourceText, /ground truth for settled science/);
		assert.match(teacher.sourceText, /`book p\.N`/);
		for (const agent of ["prober", "practice"] as const) {
			assert.ok(!effectivePromptSegments(agent, {}).some((s) => s.path === "teacher/07-library.md"));
		}
	});
});
