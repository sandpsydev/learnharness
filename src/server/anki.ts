/**
 * Anki export service (docs/medical-spec.md Phase 5). Learner-triggered
 * only: `start` creates a draft and drafts its cards in the background (the
 * card maker sub-agent), the review panel edits the draft through
 * `saveCards`, and `push` delivers it to a running Anki through AnkiConnect.
 * Nothing is sent to Anki before `push`.
 *
 * Built as a factory so tests inject the draft store, the model and the
 * fetch (never the real AnkiConnect); `anki` below is the wired instance the
 * routes use.
 *
 * Runs are tracked in a globalThis registry (the extraction / practice
 * idiom: Next dev gives each route its own module instance), each with an
 * abort controller and a hard time limit. A draft left `generating` by a
 * dead server is marked interrupted on its next read.
 */

import type { Usage } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { runAnkiMaker, chunkMaterial, dedupeByFront } from "../agent/subagents/anki-maker.ts";
import { withBgLlmSlot } from "../agent/subagents/bg-llm-semaphore.ts";
import { ROLE_SLOT, ModelsNotConfiguredError, ProviderKeyMissingError } from "../core/settings.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import {
	AnkiConnectError,
	AnkiUnavailableError,
	pushCards,
} from "../core/anki-connect.ts";
import { chainsForSelection } from "../core/chains.ts";
import {
	accumulateJobUsage,
	factTypeLabel,
	originKeyOf,
	organSystemLabel,
	piUsageToStep,
	sanitizeCard,
	type AnkiCard,
	type AnkiDraft,
	type AnkiOrigin,
	type GraphNode,
	type OrganSystem,
} from "../core/contracts.ts";
import { getGraph } from "../core/graph.ts";
import type { ChatStore, GraphStore } from "../core/ports.ts";
import { sessionMarkdown } from "../core/session-markdown.ts";
import { citationFor, marksNotice, VISION_NOTICE } from "../core/library.ts";
import { libraryTools } from "../agent/tools/library.ts";
import type { LibraryReader } from "../agent/library/searcher.ts";
import { library } from "./library.ts";
import { ankiDraftStore, newDraftId, type AnkiDraftStore } from "../store/anki.ts";
import { providerKeyPresent } from "./keys.ts";
import { stores } from "./stores.ts";

/** One drafting run is cut off after this long. */
export const ANKI_RUN_LIMIT_MS = 8 * 60_000;
/** A `generating` draft nobody is running and nobody touched this long is dead. */
const STALE_MS = ANKI_RUN_LIMIT_MS + 2 * 60_000;
/** Most nodes one request may cover. */
export const MAX_NODES = 200;

/** What the maker is given for one origin. */
export interface AnkiMaterial {
	title: string;
	text: string;
	sessionIds: string[];
	fallbackSystem?: OrganSystem;
	/** Extra agent tools for this origin: where the library's search/read tools plug in. */
	extraTools?: Record<string, AgentTool<any>>;
}

export interface AnkiServiceDeps {
	drafts: AnkiDraftStore;
	chatStore: Pick<ChatStore, "getChat">;
	graphStore: Pick<GraphStore, "readNodes" | "readChains">;
	/** The card maker's engine, resolved fresh per run; undefined = no model configured. */
	engine: () => PiEngine | undefined;
	/** The engine's provider key gate (null = fine). */
	providerKeyMissing?: (provider: string) => boolean;
	/** AnkiConnect transport; tests always pass a fake. */
	fetch?: typeof fetch;
	/**
	 * Resolve a library origin (a section of a book) to material plus the
	 * library tools. Wired to the real library below; tests pass a fake reader.
	 */
	resolveLibrary?: (origin: Extract<AnkiOrigin, { kind: "library" }>) => Promise<AnkiMaterial | AnkiFailure> | AnkiMaterial | AnkiFailure;
	/** Test seam: shrink the run limit. */
	runLimitMs?: number;
}

export type AnkiFailure = { ok: false; status: 400 | 404 | 409 | 501 | 502 | 503; code: string; error: string };
export type StartOutcome = AnkiFailure | { ok: true; draft: AnkiDraft; reused: boolean };
export type DraftOutcome = AnkiFailure | { ok: true; draft: AnkiDraft };
export type PushSummary = { added: number; duplicate: number; failed: number };
export type PushOutcomeResult = AnkiFailure | { ok: true; draft: AnkiDraft; summary: PushSummary };

interface AnkiRunsGlobal {
	__lhAnkiRuns?: Map<string, AbortController>;
	__lhAnkiPushes?: Set<string>;
}
const runs = (): Map<string, AbortController> =>
	((globalThis as typeof globalThis & AnkiRunsGlobal).__lhAnkiRuns ??= new Map());
const pushes = (): Set<string> => ((globalThis as typeof globalThis & AnkiRunsGlobal).__lhAnkiPushes ??= new Set());

const fail = (status: AnkiFailure["status"], code: string, error: string): AnkiFailure => ({ ok: false, status, code, error });

// ─── material ───────────────────────────────────────────────────────────────

function nodesMaterial(
	graphStore: AnkiServiceDeps["graphStore"],
	nodeIds: readonly string[],
): AnkiMaterial | AnkiFailure {
	const graph = getGraph(graphStore);
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const unknown = nodeIds.filter((id) => !byId.has(id));
	if (unknown.length > 0) return fail(404, "not_found", `Unknown node: ${unknown[0]}`);
	const picked = nodeIds.map((id) => byId.get(id)!) as GraphNode[];

	const lines = picked.map((n) => {
		const tags = [
			...(n.systems ?? []).map(organSystemLabel),
			...(n.factType ? [factTypeLabel(n.factType)] : []),
		];
		return `- ${n.name}${tags.length > 0 ? ` [${tags.join("; ")}]`: ""}: ${n.statement.replace(/\s+/g, " ")}`;
	});
	const name = (id: string): string => byId.get(id)?.name ?? id;
	const chains = chainsForSelection(picked, graph.chains)
		.filter((c) => c.premises.length > 0)
		.map((c) => `- ${c.premises.map(name).join(" + ")} ⇒ ${name(c.conclusion)}`);

	const text =
		`## True statements\n\n${lines.join("\n")}` +
		(chains.length > 0 ? `\n\n## Reasoning chains (premises jointly imply the conclusion)\n\n${chains.join("\n")}` : "");
	// Notes imports use a "src_…" id as their provenance: that is a file, not a session.
	const sessionIds = [
		...new Set(picked.flatMap((n) => n.provenance.map((p) => p.chatId)).filter((id) => !id.startsWith("src_"))),
	].sort();
	const fallbackSystem = picked.find((n) => (n.systems?.length ?? 0) > 0)?.systems?.[0];
	return {
		title: picked.length === 1 ? picked[0]!.name : `${picked.length} knowledge-graph nodes`,
		text,
		sessionIds,
		...(fallbackSystem ? { fallbackSystem } : {}),
	};
}

// ─── library sections ───────────────────────────────────────────────────────

/** Most pages (slides) one request may cover: keeps a "section" a section, not a whole textbook. */
export const MAX_LIBRARY_PAGES = 60;

/**
 * The material for a library section: the pages' text, each under its
 * citation header ("--- Book p.12 ---"), with a lecture note's ⚠ / AI-read
 * marks and image-description notices kept beside the passage. The card
 * maker also gets library_search / library_read to look a point up.
 */
export function libraryMaterial(
	reader: LibraryReader,
	origin: Extract<AnkiOrigin, { kind: "library" }>,
): AnkiMaterial | AnkiFailure {
	if (!reader.hasBooks()) return fail(404, "not_found", "The library has no searchable books yet.");
	const result = reader.read(origin.bookId, origin.pages);
	if (!result.ok) return fail(400, "bad_request", result.error);
	if (result.pages.length > MAX_LIBRARY_PAGES) {
		return fail(400, "too_big", `That is ${result.pages.length} pages. Choose at most ${MAX_LIBRARY_PAGES} at a time.`);
	}
	const blocks: string[] = [];
	for (const { page, chunks } of result.pages) {
		if (chunks.length === 0) continue;
		const lines = [`--- ${citationFor(result.book, page)} ---`];
		const section = chunks[0]!.section;
		if (section && result.book.kind === "pdf") lines.push(`Section: ${section}`);
		lines.push(chunks.map((c) => c.text).join("\n"));
		for (const c of chunks) {
			const marks = marksNotice(c.marks);
			if (marks) lines.push(marks);
			if (c.visionText) lines.push(VISION_NOTICE);
		}
		blocks.push(lines.join("\n"));
	}
	return {
		title: `${result.book.title} (${origin.pages})`,
		text: blocks.join("\n\n"),
		sessionIds: [],
		extraTools: libraryTools({ reader }),
	};
}

// ─── the service ────────────────────────────────────────────────────────────

export function createAnkiService(deps: AnkiServiceDeps) {
	const { drafts } = deps;
	const limit = deps.runLimitMs ?? ANKI_RUN_LIMIT_MS;

	function touch(draft: AnkiDraft, patch: Partial<AnkiDraft>): AnkiDraft {
		const next = { ...draft, ...patch, updatedAt: new Date().toISOString() };
		drafts.save(next);
		return next;
	}

	async function materialFor(origin: AnkiOrigin): Promise<AnkiMaterial | AnkiFailure> {
		if (origin.kind === "session") {
			const record = deps.chatStore.getChat(origin.chatId);
			if (!record) return fail(404, "not_found", "No such session.");
			const text = sessionMarkdown(record.messages, { title: record.title, anchors: false });
			return { title: record.title, text, sessionIds: [origin.chatId] };
		}
		if (origin.kind === "nodes") return nodesMaterial(deps.graphStore, origin.nodeIds);
		if (!deps.resolveLibrary) return fail(501, "library_unavailable", "Making cards from a library section isn't available here.");
		return deps.resolveLibrary(origin);
	}

	function validateOrigin(raw: unknown): AnkiOrigin | AnkiFailure {
		const bad = (error: string) => fail(400, "bad_request", error);
		if (typeof raw !== "object" || raw === null) return bad("Body must be {origin: {...}}.");
		const o = raw as Record<string, unknown>;
		if (o.kind === "session") {
			return typeof o.chatId === "string" && o.chatId !== "" ? { kind: "session", chatId: o.chatId } : bad("origin.chatId is required.");
		}
		if (o.kind === "nodes") {
			if (!Array.isArray(o.nodeIds) || o.nodeIds.length === 0 || !o.nodeIds.every((id) => typeof id === "string")) {
				return bad("origin.nodeIds must be a non-empty list of node ids.");
			}
			const nodeIds = [...new Set(o.nodeIds as string[])];
			if (nodeIds.length > MAX_NODES) return bad(`Select at most ${MAX_NODES} nodes at a time.`);
			return { kind: "nodes", nodeIds };
		}
		if (o.kind === "library") {
			if (typeof o.bookId !== "string" || o.bookId.trim() === "") return bad("origin.bookId is required.");
			if (typeof o.pages !== "string" || o.pages.trim() === "" || o.pages.length > 100) {
				return bad("origin.pages is required, e.g. \"12-20\".");
			}
			return { kind: "library", bookId: o.bookId.trim(), pages: o.pages.trim() };
		}
		return bad("origin.kind must be session, nodes or library.");
	}

	/** Start drafting cards for an origin. Idempotent while that origin is still being drafted. */
	async function start(rawOrigin: unknown): Promise<StartOutcome> {
		const origin = validateOrigin(rawOrigin);
		if ("ok" in origin) return origin;
		const originKey = originKeyOf(origin);

		const running = drafts.list().find((d) => d.originKey === originKey && d.status === "generating" && runs().has(d.id));
		if (running) return { ok: true, draft: running, reused: true };

		const material = await materialFor(origin);
		if ("ok" in material) return material;
		if (material.text.trim() === "") return fail(400, "empty", "There is nothing in this material to make cards from yet.");

		const engine = deps.engine();
		if (!engine) throw new ModelsNotConfiguredError([ROLE_SLOT.extractor]);
		if (deps.providerKeyMissing?.(engine.model.provider)) {
			throw new ProviderKeyMissingError(engine.model.provider, [ROLE_SLOT.extractor]);
		}

		const now = new Date().toISOString();
		const draft: AnkiDraft = {
			id: newDraftId(),
			origin,
			originKey,
			title: material.title,
			status: "generating",
			activity: "starting",
			cards: [],
			sessionIds: material.sessionIds,
			createdAt: now,
			updatedAt: now,
		};
		drafts.save(draft);
		void runDraft(draft.id, engine, material);
		return { ok: true, draft, reused: false };
	}

	/** The background drafting run. Never throws: failure lands on the draft. */
	async function runDraft(id: string, engine: PiEngine, material: AnkiMaterial): Promise<void> {
		const controller = new AbortController();
		runs().set(id, controller);
		const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(limit)]);
		let usage: AnkiDraft["usage"];
		const cards: AnkiCard[] = [];
		try {
			const chunks = chunkMaterial(material.text);
			for (const [i, chunk] of chunks.entries()) {
				signal.throwIfAborted();
				const label = chunks.length > 1 ? `Drafting cards (part ${i + 1} of ${chunks.length})` : "Drafting cards";
				const current = drafts.get(id);
				if (!current) return; // discarded while running
				touch(current, { activity: label });
				const drafted = await withBgLlmSlot(signal, () =>
					runAnkiMaker({
						engine,
						title: material.title,
						material: chunk,
						hints: { fallbackSystem: material.fallbackSystem },
						extraTools: material.extraTools,
						signal,
						onStep: (u: Usage, model: string) => {
							usage = accumulateJobUsage(usage, model, piUsageToStep(u));
						},
					}),
				);
				cards.push(...drafted);
			}
			const current = drafts.get(id);
			if (!current) return;
			touch(current, { status: "ready", activity: "ready for review", cards: dedupeByFront(cards), usage });
		} catch (err) {
			const current = drafts.get(id);
			if (!current) return;
			const aborted = controller.signal.aborted;
			const timedOut = !aborted && signal.aborted;
			const message = aborted
				? "Stopped."
				: timedOut
					? "Drafting took too long and was stopped."
					: err instanceof Error
						? err.message
						: String(err);
			console.error("[anki] drafting failed:", err);
			touch(current, { status: "error", activity: "failed", error: message, cards: dedupeByFront(cards), usage });
		} finally {
			runs().delete(id);
		}
	}

	/** A draft by id; a dead `generating` run is marked interrupted on read. */
	function get(id: string): AnkiDraft | null {
		const draft = drafts.get(id);
		if (!draft) return null;
		if (draft.status === "generating" && !runs().has(id) && Date.now() - Date.parse(draft.updatedAt) > STALE_MS) {
			return touch(draft, { status: "error", activity: "failed", error: "Interrupted (the app restarted while drafting)." });
		}
		return draft;
	}

	/** Drafts, optionally only those of one origin key; newest first. */
	function list(originKey?: string): AnkiDraft[] {
		return drafts
			.list()
			.map((d) => get(d.id) ?? d)
			.filter((d) => originKey === undefined || d.originKey === originKey);
	}

	/** Replace the draft's cards with the panel's edited list. */
	function saveCards(id: string, body: unknown): DraftOutcome {
		const draft = get(id);
		if (!draft) return fail(404, "not_found", "No such draft.");
		if (draft.status === "generating") return fail(409, "generating", "The cards are still being drafted.");
		const raw = typeof body === "object" && body !== null ? (body as { cards?: unknown }).cards : undefined;
		if (!Array.isArray(raw)) return fail(400, "bad_request", "Body must be {cards: [...]}.");
		const prior = new Map(draft.cards.map((c) => [c.id, c]));
		const seenIds = new Set<string>();
		const cards: AnkiCard[] = [];
		for (const item of raw) {
			const card = sanitizeCard(item, "general", true);
			if (!card) return fail(400, "bad_request", "Each card must be an object.");
			if (seenIds.has(card.id)) card.id = `${card.id}_${seenIds.size}`;
			seenIds.add(card.id);
			// A card already in Anki is locked: its text and push state are the server's.
			const before = prior.get(card.id);
			if (before?.push?.status === "added") cards.push(before);
			else cards.push(before?.push ? { ...card, push: before.push } : card);
		}
		return { ok: true, draft: touch(draft, { cards }) };
	}

	/** Throw the draft away; aborts a run in flight. */
	function discard(id: string): boolean {
		runs().get(id)?.abort();
		return drafts.delete(id);
	}

	/** Stop a run in flight; the draft ends as an error "Stopped." */
	function stop(id: string): boolean {
		const controller = runs().get(id);
		if (!controller) return false;
		controller.abort();
		return true;
	}

	/** Deliver the draft's unsent cards to Anki. */
	async function push(id: string, body: unknown): Promise<PushOutcomeResult> {
		const draft = get(id);
		if (!draft) return fail(404, "not_found", "No such draft.");
		if (draft.status !== "ready") return fail(409, "not_ready", "The cards are not ready to send yet.");
		if (pushes().has(id)) return fail(409, "pushing", "These cards are already being sent.");
		const rawDeck = typeof body === "object" && body !== null ? (body as { deck?: unknown }).deck : undefined;
		if (rawDeck !== undefined && rawDeck !== null && typeof rawDeck !== "string") {
			return fail(400, "bad_request", "deck must be text.");
		}
		const deckOverride = typeof rawDeck === "string" && rawDeck.trim() !== "" ? rawDeck.trim().slice(0, 200) : undefined;
		if (deckOverride !== undefined && /[\u0000-\u001f"]/.test(deckOverride)) {
			return fail(400, "bad_request", "That deck name has characters Anki can't use.");
		}
		if (draft.cards.every((c) => c.push?.status === "added")) {
			return fail(400, "nothing_to_send", "There are no cards left to send.");
		}
		pushes().add(id);
		try {
			const outcome = await pushCards(draft.cards, { fetch: deps.fetch, sessionIds: draft.sessionIds, deckOverride });
			const latest = drafts.get(id) ?? draft;
			const cards = latest.cards.map((c) => (outcome.has(c.id) ? { ...c, push: outcome.get(c.id) } : c));
			const summary: PushSummary = { added: 0, duplicate: 0, failed: 0 };
			for (const c of cards) if (c.push) summary[c.push.status]++;
			return { ok: true, draft: touch(latest, { cards }), summary };
		} catch (err) {
			if (err instanceof AnkiUnavailableError) return fail(503, "anki_unavailable", err.message);
			if (err instanceof AnkiConnectError) return fail(502, "anki_error", err.message);
			throw err;
		} finally {
			pushes().delete(id);
		}
	}

	return { start, get, list, saveCards, discard, stop, push };
}

/** The wired service the routes use. */
export const anki = createAnkiService({
	drafts: ankiDraftStore,
	chatStore: stores.chatStore,
	graphStore: stores.graphStore,
	engine: () => {
		const spec = resolveRoleSpec("extractor", stores.settingsStore.readSettings());
		return spec ? piEngineForSpec(spec) : undefined;
	},
	providerKeyMissing: (provider) => !providerKeyPresent(provider),
	resolveLibrary: (origin) => libraryMaterial(library.reader, origin),
});
