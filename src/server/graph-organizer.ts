/**
 * The knowledge-organizer service (medical fork, docs/medical-spec.md
 * "Knowledge organizer"): the server side of the graph page's organizer
 * panel. It owns the three things the agent must not:
 *
 *   chat    run the organizer agent on the conversation so far; a valid
 *           proposal it makes is stored here, PENDING, and handed to the page
 *   apply   write an accepted proposal — only the stored one (the page sends
 *           an id, never changes), re-checked against the graph as it is now
 *   undo    put the newest applied set back
 *
 * Applying and undoing follow the single-node delete's gate: refused with 409
 * while any extraction run is registered (a mid-flight run holds findings
 * from before the change). Layout is re-settled afterwards so new nodes get
 * a resting place; the response carries the new graphRevision, the refetch
 * signal every graph listener already follows.
 */

import { randomBytes } from "node:crypto";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { runOrganizer } from "../agent/subagents/organizer.ts";
import { extractionStatuses } from "../agent/subagents/extraction.ts";
import { applyOrganizerChanges, organizerHistoryItems, undoOrganizerEntry, type OrganizerHistoryStore } from "../core/graph-organizer.ts";
import { settleGraphLayout } from "../core/layout-settle.ts";
import {
	type OrganizerHistoryItem,
	type OrganizerMessage,
	type OrganizerProposal,
} from "../core/organizer-types.ts";
import type { GraphStore } from "../core/ports.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError, ROLE_SLOT } from "../core/settings.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { organizerHistoryStore } from "../store/organizer-history.ts";
import { graphRevision } from "./graph.ts";
import { providerKeyPresent } from "./keys.ts";
import { stores } from "./stores.ts";

/** Proposals kept waiting for the learner's decision (oldest dropped first). */
const PENDING_LIMIT = 30;
const MAX_TURNS_IN = 40;
const MAX_TEXT = 4000;

export type OrganizerFailure = { ok: false; status: 400 | 404 | 409 | 422; code: string; error: string; problems?: string[] };

export type OrganizerChatOutcome =
	| OrganizerFailure
	| { ok: true; reply: string; proposal?: OrganizerProposal };
export type OrganizerApplyOutcome =
	| OrganizerFailure
	| { ok: true; entryId: string; summary: string; graphRevision: number; history: OrganizerHistoryItem[] };
export type OrganizerUndoOutcome =
	| OrganizerFailure
	| { ok: true; entryId: string; graphRevision: number; history: OrganizerHistoryItem[] };

export interface GraphOrganizerDeps {
	graphStore: GraphStore;
	history: OrganizerHistoryStore;
	/** The organizer role's engine, or undefined when no model is configured. */
	engine: () => PiEngine | undefined;
	/** The provider's key is gone — the same refusal the other roles give. */
	providerKeyMissing: (provider: string) => boolean;
	extractionRunning: () => boolean;
	/** Re-settle the layout after a write (best effort). */
	settle: () => void;
	revision: () => number;
}

/** Validate the page's conversation: roles, text, and the learner speaking last. */
export function parseOrganizerMessages(raw: unknown): OrganizerMessage[] | string {
	if (!Array.isArray(raw) || raw.length === 0) return "messages must be a non-empty list.";
	if (raw.length > MAX_TURNS_IN) return `Too long a conversation (${raw.length} turns; at most ${MAX_TURNS_IN}) — start a new one.`;
	const out: OrganizerMessage[] = [];
	for (const item of raw) {
		const m = item as { role?: unknown; text?: unknown } | null;
		if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.text !== "string") {
			return 'Each message needs role "user" or "assistant" and text.';
		}
		const text = m.text.trim();
		if (text === "" || text.length > MAX_TEXT) return `A message must have between 1 and ${MAX_TEXT} characters.`;
		out.push({ role: m.role, text });
	}
	if (out[out.length - 1]!.role !== "user") return "The last message must be the learner's.";
	return out;
}

export function createGraphOrganizer(deps: GraphOrganizerDeps) {
	// Pending proposals live in memory (a restart drops them — the page then
	// asks the learner to request the change again). globalThis so dev
	// hot-reload, which re-evaluates this module, keeps them.
	const shared = globalThis as { __lhOrganizerPending?: Map<string, OrganizerProposal>; __lhOrganizerBusy?: { on: boolean } };
	const pending = (shared.__lhOrganizerPending ??= new Map<string, OrganizerProposal>());
	const busy = (shared.__lhOrganizerBusy ??= { on: false });

	const fail = (status: OrganizerFailure["status"], code: string, error: string, problems?: string[]): OrganizerFailure => ({
		ok: false,
		status,
		code,
		error,
		...(problems ? { problems } : {}),
	});

	async function chat(messages: readonly OrganizerMessage[], signal?: AbortSignal): Promise<OrganizerChatOutcome> {
		const engine = deps.engine();
		if (!engine) throw new ModelsNotConfiguredError([ROLE_SLOT.organizer]);
		if (deps.providerKeyMissing(engine.model.provider)) throw new ProviderKeyMissingError(engine.model.provider, [ROLE_SLOT.organizer]);
		if (busy.on) return fail(409, "organizer_busy", "The organizer is still working on your last message.");
		busy.on = true;
		try {
			const run = await runOrganizer({ engine, graphStore: deps.graphStore, messages, signal });
			if (!run.proposal) return { ok: true, reply: run.reply };
			const proposal: OrganizerProposal = {
				id: `prop_${randomBytes(6).toString("hex")}`,
				summary: run.proposal.summary,
				createdAt: new Date().toISOString(),
				changes: run.proposal.changes,
				previews: run.proposal.previews,
			};
			pending.set(proposal.id, proposal);
			while (pending.size > PENDING_LIMIT) pending.delete(pending.keys().next().value as string);
			return { ok: true, reply: run.reply, proposal };
		} finally {
			busy.on = false;
		}
	}

	function guard(): OrganizerFailure | null {
		return deps.extractionRunning()
			? fail(409, "extraction_running", "An extraction is running — try again when it finishes.")
			: null;
	}

	function settle(): void {
		try {
			deps.settle();
		} catch (err) {
			console.warn("[organizer] layout settle failed:", err);
		}
	}

	function apply(proposalId: string): OrganizerApplyOutcome {
		const refused = guard();
		if (refused) return refused;
		const proposal = pending.get(proposalId);
		if (!proposal) return fail(404, "proposal_not_found", "That proposal is no longer available — ask for the change again.");
		// THE SYNC BLOCK: check-and-write with no await in between.
		const result = applyOrganizerChanges(
			{ graphStore: deps.graphStore, history: deps.history },
			{ summary: proposal.summary, changes: proposal.changes },
		);
		if (!result.ok) {
			return fail(422, "invalid_changes", "The graph no longer allows these changes — nothing was applied.", result.problems);
		}
		pending.delete(proposalId);
		settle();
		return {
			ok: true,
			entryId: result.entry.id,
			summary: result.entry.summary,
			graphRevision: deps.revision(),
			history: organizerHistoryItems(deps.history.read()),
		};
	}

	function undo(entryId: string): OrganizerUndoOutcome {
		const refused = guard();
		if (refused) return refused;
		const result = undoOrganizerEntry({ graphStore: deps.graphStore, history: deps.history }, entryId);
		if (!result.ok) return fail(result.code === "not_found" ? 404 : 409, result.code, result.reason);
		settle();
		return { ok: true, entryId, graphRevision: deps.revision(), history: organizerHistoryItems(deps.history.read()) };
	}

	function history(): OrganizerHistoryItem[] {
		return organizerHistoryItems(deps.history.read());
	}

	return { chat, apply, undo, history };
}

/** The wired service the routes use. */
export const graphOrganizer = createGraphOrganizer({
	graphStore: stores.graphStore,
	history: organizerHistoryStore,
	// A foreground engine: the learner just asked for this, so it is not a
	// background run (those wait on the subscription's background opt-in).
	engine: () => {
		const spec = resolveRoleSpec("organizer", stores.settingsStore.readSettings());
		return spec ? piEngineForSpec(spec, false) : undefined;
	},
	providerKeyMissing: (provider) => !providerKeyPresent(provider),
	extractionRunning: () => extractionStatuses().length > 0,
	settle: () => settleGraphLayout(stores.graphStore),
	revision: graphRevision,
});
