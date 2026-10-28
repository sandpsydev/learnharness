/**
 * Anki export (docs/medical-spec.md Phase 5) — deterministic, zero network.
 *
 * AnkiConnect is ALWAYS a fake here: `fakeAnki()` answers the protocol in
 * memory, and ankiInvoke refuses to run under NODE_ENV=test without an
 * injected fetch, so nothing in this file can reach the owner's real Anki
 * on 127.0.0.1:8765.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import type { LibraryReader } from "../src/agent/library/searcher.ts";
import type { LibraryBook, LibraryChunk } from "../src/core/contracts.ts";
import { chunkMaterial, dedupeByFront, runAnkiMaker } from "../src/agent/subagents/anki-maker.ts";
import {
	AnkiConnectError,
	AnkiUnavailableError,
	ankiInvoke,
	pushCards,
} from "../src/core/anki-connect.ts";
import {
	CARD_KINDS,
	DECK_BY_SYSTEM,
	ORGAN_SYSTEMS,
	UNVERIFIED_SOURCE,
	cardProblem,
	cardTags,
	deckForSystem,
	noteShape,
	originKeyOf,
	sanitizeCard,
	tagSlug,
	tocSectionPages,
	toAnkiHtml,
	type AnkiCard,
	type AnkiDraft,
	type GraphChain,
	type GraphNode,
} from "../src/core/contracts.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../src/core/settings.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { AnkiDraftStore } from "../src/store/anki.ts";

// ── the data seam, BEFORE any config-loading import: nothing here may touch the real data dir ──
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-anki-"));
process.env.LH_DATA_DIR = TMP_DATA;
const { createAnkiService, libraryMaterial, MAX_LIBRARY_PAGES } = await import("../src/server/anki.ts");
const { createAnkiDraftStore } = await import("../src/store/anki.ts");
after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

// ─── fakes ──────────────────────────────────────────────────────────────────

interface FakeAnki {
	fetch: typeof fetch;
	calls: { action: string; params: any }[];
	/** deck → fronts already in it (the first field of each note). */
	decks: Map<string, string[]>;
	models: string[];
	added: { deckName: string; modelName: string; fields: Record<string, string>; tags: string[] }[];
}

/** An in-memory AnkiConnect: just enough of the protocol for pushCards. */
function fakeAnki(opts: { models?: string[]; existing?: Record<string, string[]>; refuse?: boolean } = {}): FakeAnki {
	const state: FakeAnki = {
		calls: [],
		decks: new Map(Object.entries(opts.existing ?? {})),
		models: opts.models ?? ["Basic", "Cloze", "Basic (and reversed card)"],
		added: [],
		fetch: undefined as never,
	};
	const firstField = (n: { fields: Record<string, string> }) => Object.values(n.fields)[0]!;
	state.fetch = (async (_url: string, init: RequestInit) => {
		if (opts.refuse) throw new TypeError("fetch failed: ECONNREFUSED");
		const { action, params } = JSON.parse(String(init.body)) as { action: string; params: any };
		state.calls.push({ action, params });
		let result: unknown = null;
		switch (action) {
			case "version":
				result = 6;
				break;
			case "modelNames":
				result = state.models;
				break;
			case "createDeck":
				if (!state.decks.has(params.deck)) state.decks.set(params.deck, []);
				result = 1;
				break;
			case "canAddNotes":
				result = params.notes.map((n: any) => !(state.decks.get(n.deckName) ?? []).includes(firstField(n)));
				break;
			case "addNotes":
				result = params.notes.map((n: any) => {
					state.added.push({ deckName: n.deckName, modelName: n.modelName, fields: n.fields, tags: n.tags });
					state.decks.get(n.deckName)!.push(firstField(n));
					return state.added.length;
				});
				break;
			default:
				return new Response(JSON.stringify({ result: null, error: `unsupported action: ${action}` }));
		}
		return new Response(JSON.stringify({ result, error: null }));
	}) as typeof fetch;
	return state;
}

const card = (over: Partial<AnkiCard> = {}): AnkiCard => ({
	id: "card_1",
	type: "basic",
	kind: "mechanism",
	system: "renal",
	topic: "Renal tubular acidosis",
	front: "Why does type 1 RTA cause hypokalaemia?",
	back: "Distal H+ secretion fails → more Na+ reabsorbed with K+ lost.",
	...over,
});

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

const submit = (cards: unknown, onContext?: (text: string) => void): FauxResponseStep => (context) => {
	onContext?.(JSON.stringify(context.messages));
	return fauxAssistantMessage([fauxToolCall("submit_cards", { cards } as ToolCall["arguments"], { id: "c" })], {
		stopReason: "toolUse",
	});
};

// ─── contracts ──────────────────────────────────────────────────────────────

describe("decks and tags", () => {
	it("every organ system from the shared list has its own deck under LearnHarness::", () => {
		const names = ORGAN_SYSTEMS.map((s) => deckForSystem(s.id));
		assert.equal(new Set(names).size, ORGAN_SYSTEMS.length);
		assert.ok(names.every((n) => n.startsWith("LearnHarness::")));
		assert.equal(Object.keys(DECK_BY_SYSTEM).length, ORGAN_SYSTEMS.length, "no second list: same keys");
		assert.equal(deckForSystem("cardiovascular"), "LearnHarness::Cardio");
		assert.equal(deckForSystem("renal"), "LearnHarness::Renal");
	});

	it("builds topic, type and session tags with no spaces", () => {
		assert.equal(tagSlug("Renal tubular acidosis (RTA)"), "renal-tubular-acidosis-rta");
		assert.equal(tagSlug("???"), "misc");
		assert.deepEqual(cardTags({ topic: "RTA type 1", kind: "ddx" }, ["chat_a", "chat_b"]), [
			"lh::topic::rta-type-1",
			"lh::type::ddx",
			"lh::session::chat_a",
			"lh::session::chat_b",
		]);
		assert.equal(cardTags({ topic: "x", kind: "labs" }, []).length, 2);
		assert.equal(cardTags({ topic: "x", kind: "labs" }, Array.from({ length: 9 }, (_, i) => `s${i}`)).length, 2 + 5);
		for (const k of CARD_KINDS) assert.ok(cardTags({ topic: "t", kind: k.id }, []).includes(`lh::type::${k.id}`));
	});

	it("keys an origin independently of node selection order", () => {
		assert.equal(originKeyOf({ kind: "nodes", nodeIds: ["b", "a", "a"] }), originKeyOf({ kind: "nodes", nodeIds: ["a", "b"] }));
		assert.equal(originKeyOf({ kind: "session", chatId: "c1" }), "session:c1");
	});
});

describe("card sanitizing", () => {
	it("repairs near-miss values and defaults instead of failing", () => {
		const c = sanitizeCard({ type: "Basic Q/A", kind: "Management", system: "Renal/Urinary", topic: " AKI ", front: " Q ", back: " A " })!;
		assert.equal(c.type, "basic");
		assert.equal(c.kind, "management");
		assert.equal(c.system, "renal");
		assert.equal(c.topic, "AKI");
		assert.equal(c.front, "Q");
		assert.equal(c.source, UNVERIFIED_SOURCE, "a management card without a source is flagged unverified");
		const odd = sanitizeCard({ type: "???", kind: "???", system: "???", front: "Q", back: "A" })!;
		assert.deepEqual([odd.type, odd.kind, odd.system, odd.topic], ["basic", "memorise", "general", "general"]);
	});

	it("keeps a given source, drops a card with no front, and keeps blanks only when asked", () => {
		assert.equal(sanitizeCard({ kind: "management", front: "Q", back: "A", source: "KDIGO 2024" })!.source, "KDIGO 2024");
		assert.equal(sanitizeCard({ kind: "mechanism", front: "Q", back: "A" })!.source, undefined);
		assert.equal(sanitizeCard({ front: "  ", back: "A" }), null);
		assert.equal(sanitizeCard({ front: "  ", back: "A" }, "general", true)!.front, "");
		assert.equal(sanitizeCard("nope"), null);
	});

	it("flags what Anki would reject", () => {
		assert.equal(cardProblem(card()), null);
		assert.match(cardProblem(card({ front: "" }))!, /front is empty/);
		assert.match(cardProblem(card({ back: " " }))!, /back is empty/);
		assert.match(cardProblem(card({ type: "cloze", front: "no deletion here" }))!, /cloze/i);
		assert.equal(cardProblem(card({ type: "cloze", front: "{{c1::Type 1}} RTA", back: "" })), null);
	});

	it("formats fields as escaped HTML and carries the source on management cards", () => {
		assert.equal(toAnkiHtml("a < b & c\nnext"), "a &lt; b &amp; c<br>next");
		const basic = noteShape(card({ kind: "management", source: "NICE NG203, 2021" }));
		assert.equal(basic.modelName, "Basic");
		assert.match(basic.fields.Back!, /Source: NICE NG203, 2021$/);
		const cloze = noteShape(card({ type: "cloze", front: "{{c1::Type 1}} RTA", back: "" }));
		assert.equal(cloze.modelName, "Cloze");
		assert.deepEqual(Object.keys(cloze.fields), ["Text", "Back Extra"]);
		assert.equal(cloze.fields.Text, "{{c1::Type 1}} RTA");
	});
});

// ─── AnkiConnect ────────────────────────────────────────────────────────────

describe("AnkiConnect client", () => {
	it("never reaches the real Anki from tests: a call without an injected fetch throws", async () => {
		await assert.rejects(ankiInvoke("version"), /tests must inject a fetch/);
	});

	it("says clearly when Anki is not running", async () => {
		const anki = fakeAnki({ refuse: true });
		await assert.rejects(pushCards([card()], { fetch: anki.fetch }), (err: unknown) => {
			assert.ok(err instanceof AnkiUnavailableError);
			assert.match((err as Error).message, /Open the Anki desktop app/);
			assert.match((err as Error).message, /2055492159/);
			return true;
		});
	});

	it("reports Anki's own error and a reply that is not AnkiConnect", async () => {
		const withError = (async () => new Response(JSON.stringify({ result: null, error: "collection is not available" }))) as unknown as typeof fetch;
		await assert.rejects(ankiInvoke("version", {}, { fetch: withError }), /collection is not available/);
		const notAnki = (async () => new Response("<html>hello</html>")) as unknown as typeof fetch;
		await assert.rejects(ankiInvoke("version", {}, { fetch: notAnki }), AnkiConnectError);
	});

	it("adds cards to the deck of their system, with tags and the right note type", async () => {
		const anki = fakeAnki();
		const out = await pushCards(
			[
				card(),
				card({ id: "card_2", type: "cloze", kind: "memorise", system: "cardiovascular", topic: "AF", front: "CHA2DS2-VASc ≥ {{c1::2}} in men", back: "" }),
			],
			{ fetch: anki.fetch, sessionIds: ["chat_x"] },
		);
		assert.deepEqual([...out.values()].map((r) => r.status), ["added", "added"]);
		assert.deepEqual(anki.added.map((n) => [n.deckName, n.modelName]), [
			["LearnHarness::Renal", "Basic"],
			["LearnHarness::Cardio", "Cloze"],
		]);
		assert.deepEqual(anki.added[0]!.tags, ["lh::topic::renal-tubular-acidosis", "lh::type::mechanism", "lh::session::chat_x"]);
		assert.ok(anki.calls.some((c) => c.action === "createDeck" && c.params.deck === "LearnHarness::Cardio"));
	});

	it("skips a card whose front is already in the target deck, using canAddNotes scoped to that deck", async () => {
		const anki = fakeAnki({ existing: { "LearnHarness::Renal": ["Why does type 1 RTA cause hypokalaemia?"] } });
		const out = await pushCards([card(), card({ id: "card_2", front: "A new question?" })], { fetch: anki.fetch });
		assert.equal(out.get("card_1")!.status, "duplicate");
		assert.match(out.get("card_1")!.message!, /already exists in LearnHarness::Renal/);
		assert.equal(out.get("card_2")!.status, "added");
		assert.equal(anki.added.length, 1);
		const check = anki.calls.find((c) => c.action === "canAddNotes")!;
		assert.equal(check.params.notes[0].options.duplicateScope, "deck");
		assert.equal(check.params.notes[0].options.duplicateScopeOptions.deckName, "LearnHarness::Renal");
		assert.equal(check.params.notes[0].options.allowDuplicate, false);
	});

	it("skips a repeated front inside the same batch, and never re-sends a card already added", async () => {
		const anki = fakeAnki();
		const out = await pushCards([card(), card({ id: "card_2", front: "  why does TYPE 1 rta cause hypokalaemia? " })], { fetch: anki.fetch });
		assert.equal(out.get("card_1")!.status, "added");
		assert.equal(out.get("card_2")!.status, "duplicate");
		const again = await pushCards([card({ push: { status: "added" } })], { fetch: anki.fetch });
		assert.equal(again.get("card_1")!.status, "added");
		assert.equal(anki.added.length, 1, "nothing sent twice");
	});

	it("fails a broken card with a reason without blocking the rest", async () => {
		const anki = fakeAnki();
		const out = await pushCards([card({ id: "bad", type: "cloze", front: "no deletion" }), card()], { fetch: anki.fetch });
		assert.equal(out.get("bad")!.status, "failed");
		assert.equal(out.get("card_1")!.status, "added");
	});

	it("honours a deck override for every card", async () => {
		const anki = fakeAnki();
		await pushCards([card(), card({ id: "card_2", system: "cardiovascular", front: "Q2?" })], { fetch: anki.fetch, deckOverride: "Exam::Block 3" });
		assert.deepEqual(new Set(anki.added.map((n) => n.deckName)), new Set(["Exam::Block 3"]));
	});

	it("refuses before adding anything when the stock note types are missing", async () => {
		const anki = fakeAnki({ models: ["Basic"] });
		await assert.rejects(
			pushCards([card({ type: "cloze", front: "{{c1::x}}", back: "" })], { fetch: anki.fetch }),
			/no "Cloze" note type/,
		);
		assert.equal(anki.added.length, 0);
		assert.ok(!anki.calls.some((c) => c.action === "createDeck"));
	});
});

// ─── the card maker ─────────────────────────────────────────────────────────

describe("card maker", () => {
	const quiet = { onStep: () => undefined, signal: undefined };

	it("drafts sanitized cards from the submit call", async () => {
		const cards = await runAnkiMaker({
			...quiet,
			title: "RTA",
			material: "Type 1 RTA ...",
			engine: fauxEngine([
				submit([
					{ type: "Mechanism", kind: "mechanism", system: "Renal/Urinary", topic: "RTA", front: "Why?", back: "A → B → hypokalaemia" },
					{ type: "cloze", kind: "management", system: "renal", topic: "RTA", front: "Treat with {{c1::alkali}}", back: "", source: "UpToDate 2025" },
				]),
			]),
		});
		assert.equal(cards.length, 2);
		assert.equal(cards[0]!.type, "mechanism");
		assert.equal(cards[0]!.system, "renal");
		assert.equal(cards[1]!.source, "UpToDate 2025");
		assert.ok(cards.every((c) => /^card_/.test(c.id)));
	});

	it("sends a cloze card with no deletion back for a fix", async () => {
		const seen: string[] = [];
		const cards = await runAnkiMaker({
			...quiet,
			title: "t",
			material: "m",
			engine: fauxEngine([
				submit([{ type: "cloze", kind: "memorise", system: "general", topic: "t", front: "plain text", back: "" }], (t) => seen.push(t)),
				submit([{ type: "cloze", kind: "memorise", system: "general", topic: "t", front: "{{c1::fixed}}", back: "" }], (t) => seen.push(t)),
			]),
		});
		assert.equal(seen.length, 2, "the model was asked again");
		assert.match(seen[1]!, /cloze card needs a deletion/i);
		assert.equal(cards[0]!.front, "{{c1::fixed}}");
	});

	it("carries the mnemonic policy, the kinds and the source rule in its instructions", async () => {
		let prompt = "";
		await runAnkiMaker({
			...quiet,
			title: "t",
			material: "m",
			engine: fauxEngine([submit([], (t) => (prompt = t))]),
		});
		assert.match(prompt, /first-letter acronyms/);
		assert.match(prompt, /look-alikes/);
		assert.match(prompt, /unverified/);
		assert.match(prompt, /memorise/);
	});

	it("chunks long material on paragraph boundaries and de-duplicates fronts", () => {
		const long = Array.from({ length: 10 }, (_, i) => `para ${i} ${"x".repeat(100)}`).join("\n\n");
		const chunks = chunkMaterial(long, 350);
		assert.ok(chunks.length > 1);
		assert.ok(chunks.every((c) => c.length <= 350));
		assert.equal(chunks.join("\n\n"), long);
		assert.equal(chunkMaterial("short").length, 1);
		assert.equal(dedupeByFront([card(), card({ id: "x", front: " WHY does type 1 RTA cause hypokalaemia?" })]).length, 1);
	});
});

describe("tutor prompt seam", () => {
	it("tells the tutor the learner makes the cards, and that it must not claim an export", () => {
		const text = fs.readFileSync(path.join(import.meta.dirname, "..", "src/agent/prompts/teacher/08-anki-export.md"), "utf-8");
		assert.match(text, /Make Anki cards…/);
		assert.match(text, /Never say a card was created, drafted or sent/);
		assert.match(text, /\[memorise\]/);
	});

	it("points the verify-app's key-points offer at the same action, still offer-only", async () => {
		const { ANKI_OFFER_INSTRUCTION } = await import("../src/core/contracts/verify.ts");
		assert.match(ANKI_OFFER_INSTRUCTION, /Make Anki cards…/);
		assert.match(ANKI_OFFER_INSTRUCTION, /Offer only/);
		assert.match(ANKI_OFFER_INSTRUCTION, /do not write cards yourself/);
	});
});

// ─── a fake library ─────────────────────────────────────────────────────────

const BOOK: LibraryBook = {
	id: "book_1",
	kind: "pdf",
	title: "Robbins Pathology",
	fileName: "robbins.pdf",
	pageCount: 900,
	importedAt: "2026-10-01T00:00:00.000Z",
	mode: "text",
	status: "ready",
	chunkCount: 3,
	embeddings: null,
	toc: [],
	visionPages: [],
};
const chunk = (page: number, text: string, extra: Partial<LibraryChunk> = {}): LibraryChunk => ({ index: page, page, text, ...extra });

function fakeReader(over: { pages?: Array<{ page: number; chunks: LibraryChunk[] }>; error?: string; book?: LibraryBook; hasBooks?: boolean } = {}): LibraryReader {
	return {
		hasBooks: () => over.hasBooks ?? true,
		search: async () => ({ hits: [], notes: [] }) as never,
		read: () =>
			over.error
				? { ok: false, error: over.error }
				: {
						ok: true,
						book: over.book ?? BOOK,
						pages: over.pages ?? [
							{ page: 412, chunks: [chunk(412, "Distal tubule acidification fails in type 1 RTA.", { section: "Renal > Tubular disorders" })] },
							{ page: 413, chunks: [chunk(413, "Type 2 RTA wastes bicarbonate.")] },
						],
					},
	};
}

describe("library sections", () => {
	it("builds material from pages under citation headers, with the library tools", () => {
		const m = libraryMaterial(fakeReader(), { kind: "library", bookId: "book_1", pages: "412-413" });
		assert.ok(!("ok" in m));
		assert.equal(m.title, "Robbins Pathology (412-413)");
		assert.match(m.text, /--- Robbins Pathology p\.412 ---\nSection: Renal > Tubular disorders\nDistal tubule/);
		assert.match(m.text, /--- Robbins Pathology p\.413 ---/);
		assert.deepEqual(Object.keys(m.extraTools!).sort(), ["library_read", "library_search"]);
		assert.deepEqual(m.sessionIds, []);
	});

	it("cites a lecture note by slide and keeps its marks and image notices visible", () => {
		const note: LibraryBook = { ...BOOK, kind: "slidescribe", title: "Acute abdomen" };
		const m = libraryMaterial(
			fakeReader({
				book: note,
				pages: [{ page: 7, chunks: [chunk(7, "Rebound tenderness.", { marks: { warning: true, aiRead: true }, visionText: true })] }],
			}),
			{ kind: "library", bookId: "book_1", pages: "7" },
		);
		assert.ok(!("ok" in m));
		assert.match(m.text, /--- Acute abdomen, slide 7 ---/);
		assert.match(m.text, /⚠ check mark, \(AI read — verify\)/);
		assert.match(m.text, /AI-written image description/);
	});

	it("refuses honestly: no books, a bad page spec, too many pages; skips empty pages", () => {
		const origin = { kind: "library", bookId: "book_1", pages: "1-5" } as const;
		const none = libraryMaterial(fakeReader({ hasBooks: false }), origin);
		assert.ok("ok" in none && none.status === 404);
		const bad = libraryMaterial(fakeReader({ error: 'No book called "x".' }), origin);
		assert.ok("ok" in bad && bad.status === 400 && /No book called/.test(bad.error));
		const many = libraryMaterial(
			fakeReader({ pages: Array.from({ length: MAX_LIBRARY_PAGES + 1 }, (_, i) => ({ page: i + 1, chunks: [chunk(i + 1, "x")] })) }),
			origin,
		);
		assert.ok("ok" in many && many.status === 400 && many.code === "too_big");
		const blank = libraryMaterial(fakeReader({ pages: [{ page: 1, chunks: [] }, { page: 2, chunks: [chunk(2, "Real text.")] }] }), origin);
		assert.ok(!("ok" in blank));
		assert.ok(!blank.text.includes("p.1 ---"));
	});

	it("turns an outline entry into its page range", () => {
		const toc = [
			{ title: "Renal", page: 400, depth: 0 },
			{ title: "Tubular disorders", page: 410, depth: 1 },
			{ title: "Glomerular disease", page: 420, depth: 1 },
			{ title: "Cardiac", page: 450, depth: 0 },
		];
		assert.equal(tocSectionPages(toc, 0, 900), "400-449");
		assert.equal(tocSectionPages(toc, 1, 900), "410-419");
		assert.equal(tocSectionPages(toc, 3, 900), "450-900");
		assert.equal(tocSectionPages(toc, 9, 900), "all");
	});
});

// ─── the service ────────────────────────────────────────────────────────────

const user = (id: string, text: string): LhMessage => ({ id, role: "user", content: text, timestamp: 1 }) as never;
const teacher = (id: string, text: string): LhMessage =>
	({
		id,
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openrouter",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason: "stop",
		timestamp: 2,
	}) as never;

const nodeBase = { aliases: [], createdAt: "2026-10-01T00:00:00.000Z" };
const NODES: GraphNode[] = [
	{ id: "n_a", name: "Type 1 RTA", statement: "Type 1 RTA is a failure of distal H+ secretion.", provenance: [{ chatId: "chat_one", messageId: "m" }], systems: ["renal"], factType: "mechanism", ...nodeBase },
	{ id: "n_b", name: "Hypokalaemia", statement: "Distal H+ failure wastes K+.", provenance: [{ chatId: "src_file", messageId: "" }], systems: ["renal", "endocrine"], ...nodeBase },
];
const CHAINS: GraphChain[] = [
	{ id: "arg_1", premises: ["n_a"], conclusion: "n_b", provenance: [], createdAt: nodeBase.createdAt },
];

function harness(over: { engine?: PiEngine | undefined; fetch?: typeof fetch; resolveLibrary?: any; keyMissing?: boolean } = {}) {
	const store: AnkiDraftStore = createAnkiDraftStore(path.join(TMP_DATA, `drafts-${crypto.randomUUID()}`));
	const record = { id: "chat_one", title: "Renal tubular acidosis", messages: [user("u1", "teach me RTA"), teacher("t1", "Type 1 RTA fails to acidify urine.")] };
	let prompt = "";
	const engine =
		"engine" in over
			? over.engine
			: fauxEngine([
					submit(
						[{ type: "basic", kind: "mechanism", system: "renal", topic: "RTA", front: "Why is urine pH high in type 1 RTA?", back: "No distal H+ secretion → urine stays alkaline" }],
						(t) => (prompt = t),
					),
				]);
	const service = createAnkiService({
		drafts: store,
		chatStore: { getChat: (id) => (id === record.id ? (record as never) : null) },
		graphStore: { readNodes: () => NODES, readChains: () => CHAINS },
		engine: () => engine,
		providerKeyMissing: () => over.keyMissing === true,
		fetch: over.fetch,
		resolveLibrary: over.resolveLibrary,
	});
	return { service, store, prompt: () => prompt };
}

async function settled(service: { get(id: string): AnkiDraft | null }, id: string): Promise<AnkiDraft> {
	for (let i = 0; i < 200; i++) {
		const d = service.get(id)!;
		if (d.status !== "generating") return d;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error("draft never settled");
}

describe("Anki service", () => {
	it("drafts cards for a session in the background, then lists, edits and pushes them", async () => {
		const anki = fakeAnki();
		const { service, prompt } = harness({ fetch: anki.fetch });
		const started = await service.start({ kind: "session", chatId: "chat_one" });
		assert.ok(started.ok);
		assert.equal(started.draft.status, "generating", "answers at once; drafting continues in the background");
		const draft = await settled(service, started.draft.id);
		assert.equal(draft.status, "ready");
		assert.equal(draft.cards.length, 1);
		assert.match(prompt(), /Type 1 RTA fails to acidify urine/);
		assert.deepEqual(draft.sessionIds, ["chat_one"]);
		assert.equal(anki.calls.length, 0, "nothing reaches Anki before the learner pushes");

		assert.equal(service.list("session:chat_one").length, 1);
		assert.equal(service.list("session:other").length, 0);

		// The learner edits the card and moves it to another deck before pushing.
		const edited = service.saveCards(draft.id, { cards: [{ ...draft.cards[0], front: "Why is urine pH high in type 1 RTA??", system: "general" }] });
		assert.ok(edited.ok);
		assert.equal(edited.draft.cards[0]!.system, "general");

		const pushed = await service.push(draft.id, {});
		assert.ok(pushed.ok);
		assert.deepEqual(pushed.summary, { added: 1, duplicate: 0, failed: 0 });
		assert.equal(anki.added[0]!.deckName, "LearnHarness::General");
		assert.ok(anki.added[0]!.tags.includes("lh::session::chat_one"));
		assert.equal(service.get(draft.id)!.cards[0]!.push!.status, "added");

		// Pushing again has nothing left to send.
		const again = await service.push(draft.id, {});
		assert.ok(!again.ok);
		assert.equal(again.code, "nothing_to_send");
	});

	it("drafts for selected nodes from their statements, tags and chains, with session tags from provenance", async () => {
		const { service, prompt } = harness();
		const started = await service.start({ kind: "nodes", nodeIds: ["n_b", "n_a"] });
		assert.ok(started.ok);
		assert.deepEqual(started.draft.sessionIds, ["chat_one"], "a notes-import source is not a session");
		await settled(service, started.draft.id);
		assert.match(prompt(), /Type 1 RTA \[Renal\/Urinary; Mechanism\]/);
		assert.match(prompt(), /Type 1 RTA ⇒ Hypokalaemia/);
		const missing = await service.start({ kind: "nodes", nodeIds: ["n_zzz"] });
		assert.ok(!missing.ok);
		assert.equal(missing.status, 404);
	});

	it("overrides the deck on push and reports a duplicate without adding it", async () => {
		const anki = fakeAnki({ existing: { "Exam::RTA": ["Why is urine pH high in type 1 RTA?"] } });
		const { service } = harness({ fetch: anki.fetch });
		const started = await service.start({ kind: "session", chatId: "chat_one" });
		assert.ok(started.ok);
		await settled(service, started.draft.id);
		const pushed = await service.push(started.draft.id, { deck: "Exam::RTA" });
		assert.ok(pushed.ok);
		assert.deepEqual(pushed.summary, { added: 0, duplicate: 1, failed: 0 });
		assert.equal(anki.added.length, 0);
	});

	it("answers a clear error when Anki is not running, and keeps the cards for another try", async () => {
		const down = fakeAnki({ refuse: true });
		const { service } = harness({ fetch: down.fetch });
		const started = await service.start({ kind: "session", chatId: "chat_one" });
		assert.ok(started.ok);
		await settled(service, started.draft.id);
		const pushed = await service.push(started.draft.id, {});
		assert.ok(!pushed.ok);
		assert.equal(pushed.status, 503);
		assert.equal(pushed.code, "anki_unavailable");
		assert.match(pushed.error, /Open the Anki desktop app/);
		assert.equal(service.get(started.draft.id)!.cards.length, 1);
	});

	it("rejects bad input and unknown sessions", async () => {
		const { service } = harness();
		const bads = [
			null,
			{},
			{ kind: "session" },
			{ kind: "nodes", nodeIds: [] },
			{ kind: "nodes", nodeIds: [1] },
			{ kind: "library", bookId: "b1" },
			{ kind: "library", pages: "1-2" },
			{ kind: "library", bookId: "b1", pages: "  " },
			{ kind: "x" },
		];
		for (const bad of bads) {
			const out = await service.start(bad);
			assert.ok(!out.ok && out.status === 400, JSON.stringify(bad));
		}
		const unknownChat = await service.start({ kind: "session", chatId: "nope" });
		assert.ok(!unknownChat.ok && unknownChat.status === 404);
	});

	it("answers 501 for a library section when no library is wired", async () => {
		const { service } = harness();
		const out = await service.start({ kind: "library", bookId: "b1", pages: "1-5" });
		assert.ok(!out.ok);
		assert.equal(out.status, 501);
	});

	it("drafts from a library section: pages under their citations, with the library tools in the agent's hands", async () => {
		let seen = "";
		const reader = fakeReader();
		const { service } = harness({
			resolveLibrary: (o: any) => libraryMaterial(reader, o),
			engine: fauxEngine([
				(context: any) => {
					seen = JSON.stringify([context.messages, (context.tools ?? []).map((t: { name: string }) => t.name)]);
					return fauxAssistantMessage(
						[fauxToolCall("submit_cards", { cards: [] } as ToolCall["arguments"], { id: "c" })],
						{ stopReason: "toolUse" },
					);
				},
			]),
		});
		const started = await service.start({ kind: "library", bookId: "book_1", pages: "412-413" });
		assert.ok(started.ok);
		assert.equal(started.draft.originKey, "library:book_1:412-413");
		assert.deepEqual(started.draft.sessionIds, []);
		await settled(service, started.draft.id);
		assert.match(seen, /--- Robbins Pathology p\.412 ---/);
		assert.match(seen, /Distal tubule acidification fails/);
		assert.match(seen, /library_search/);
		assert.match(seen, /library_read/);
		assert.match(seen, /--- Robbins Pathology p\.413 ---/);
	});

	it("refuses honestly with no model or no key, and writes no draft", async () => {
		const none = harness({ engine: undefined });
		await assert.rejects(none.service.start({ kind: "session", chatId: "chat_one" }), ModelsNotConfiguredError);
		assert.equal(none.store.list().length, 0);
		const keyless = harness({ keyMissing: true });
		await assert.rejects(keyless.service.start({ kind: "session", chatId: "chat_one" }), ProviderKeyMissingError);
	});

	it("lands a failed run on the draft instead of throwing, and can discard a draft", async () => {
		const { service, store } = harness({ engine: fauxEngine([() => { throw new Error("model down"); }]) });
		const started = await service.start({ kind: "session", chatId: "chat_one" });
		assert.ok(started.ok);
		const draft = await settled(service, started.draft.id);
		assert.equal(draft.status, "error");
		assert.ok(draft.error);
		assert.equal(service.discard(draft.id), true);
		assert.equal(store.list().length, 0);
		assert.equal(service.discard(draft.id), false);
	});

	it("does not start a second run for an origin that is still drafting", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const { service } = harness({
			engine: fauxEngine([
				async () => {
					await gate;
					return fauxAssistantMessage([fauxToolCall("submit_cards", { cards: [] } as ToolCall["arguments"], { id: "c" })], { stopReason: "toolUse" });
				},
			]),
		});
		const first = await service.start({ kind: "session", chatId: "chat_one" });
		const second = await service.start({ kind: "session", chatId: "chat_one" });
		assert.ok(first.ok && second.ok);
		assert.equal(second.reused, true);
		assert.equal(second.draft.id, first.draft.id);
		assert.equal(service.saveCards(first.draft.id, { cards: [] }).ok, false, "cannot edit while drafting");
		release();
		await settled(service, first.draft.id);
	});

	it("keeps a card that is already in Anki locked against later edits", async () => {
		const anki = fakeAnki();
		const { service } = harness({ fetch: anki.fetch });
		const started = await service.start({ kind: "session", chatId: "chat_one" });
		assert.ok(started.ok);
		const draft = await settled(service, started.draft.id);
		await service.push(draft.id, {});
		const saved = service.saveCards(draft.id, { cards: [{ ...draft.cards[0], front: "tampered" }] });
		assert.ok(saved.ok);
		assert.equal(saved.draft.cards[0]!.front, draft.cards[0]!.front);
		assert.equal(saved.draft.cards[0]!.push!.status, "added");
	});
});
