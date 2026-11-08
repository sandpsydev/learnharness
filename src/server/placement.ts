/**
 * The placement service (medical fork, docs/medical-spec.md "Textbook outline
 * placement"): keeps every fact placed in the organ system → topic → aspect
 * outline, with no approval step and nothing for the learner to do.
 *
 * ONE mechanism covers both jobs. The set of facts still waiting for a place
 * is DERIVED (nodes with no placement line), and a light watch places them in
 * batches whenever any exist:
 *   - new facts: an extraction run adds nodes → the graph's revision moves →
 *     the next look finds them unplaced and places them;
 *   - the one-time back-fill: on first start every existing fact is unplaced,
 *     so the same pass works through them, batch by batch.
 * Because "unplaced" is derived from the ledger and every batch is appended as
 * soon as it returns, the back-fill is RESUMABLE (a stop or a restart loses
 * nothing placed) and IDEMPOTENT (a placed fact is never sent again, and a
 * placement the learner made meanwhile is never overridden).
 *
 * Every pass is journalled (data/graph/placer-runs.json) so it can be
 * reverted. A low-confidence placement is applied like any other and only
 * marked in the outline. A fact the model keeps failing to place is parked in
 * an "Unsorted" topic after a couple of tries, so the pass always converges.
 * Failures back off; a missing model or sign-in just waits — never a prompt.
 */

import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { extractionStatuses } from "../agent/subagents/extraction.ts";
import { withBgLlmSlot } from "../agent/subagents/bg-llm-semaphore.ts";
import { PLACER_BATCH_SIZE, runPlacer } from "../agent/subagents/placer.ts";
import type { GraphNode, PlacerRun } from "../core/contracts.ts";
import { getGraph } from "../core/graph.ts";
import { applyPlacerProposals, fallbackProposal, placementView, revertRunLines, unplacedNodes, type PlacerProposal } from "../core/placement.ts";
import type { GraphStore, PlacementStore, PlacerJournalStore } from "../core/ports.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../core/settings.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { placementStore, placerJournalStore } from "../store/placements.ts";
import { graphRevision } from "./graph.ts";
import { providerKeyPresent } from "./keys.ts";
import { stores } from "./stores.ts";

export const PLACEMENT_POLL_MS = 5000;
/** Runs the journal keeps. */
export const PLACER_RUN_LIMIT = 20;
/** Tries before a fact the model will not place is parked in "Unsorted". */
export const PLACER_MAX_ATTEMPTS = 2;
const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 900_000];
const NO_MODEL_RETRY_MS = 60_000;

export interface PlacementState {
	running: boolean;
	lastSig: string | undefined;
	/** Do not look again before this time (ms) — set after a failure or a missing model. */
	retryAt: number | undefined;
	failures: number;
	problem: "no-model" | "no-key" | "failed" | undefined;
	error: string | undefined;
	attempts: Map<string, number>;
	abort: AbortController | undefined;
}

export const newPlacementState = (): PlacementState => ({
	running: false,
	lastSig: undefined,
	retryAt: undefined,
	failures: 0,
	problem: undefined,
	error: undefined,
	attempts: new Map(),
	abort: undefined,
});

export interface PlacementStatus {
	running: boolean;
	/** Live facts still waiting for a place. */
	unplaced: number;
	total: number;
	/** Why placing is waiting, when it is — shown quietly, never as a task. */
	problem?: PlacementState["problem"];
	error?: string;
	/** The newest run that placed something and was not reverted. */
	lastRun?: PlacerRun;
}

export interface PlacementServiceDeps {
	graphStore: Pick<GraphStore, "readNodes" | "readChains">;
	placements: PlacementStore;
	journal: PlacerJournalStore;
	/** The placer role's engine, or undefined when no model is configured. */
	engine: () => PiEngine | undefined;
	providerKeyMissing: (provider: string) => boolean;
	extractionRunning: () => boolean;
	revision: () => number;
	now: () => Date;
	/** The model call (a seam: tests pass a local fake). */
	place?: typeof runPlacer;
	/** The shared background-LLM gate. */
	slot?: <T>(signal: AbortSignal | undefined, fn: () => Promise<T>) => Promise<T>;
	batchSize?: number;
	newRunId?: () => string;
	state?: PlacementState;
}

export type PassOutcome =
	| { started: false; reason: "busy" | "no-model" | "no-key" }
	| { started: true; placed: number; topicsCreated: number; error?: string };

export type RevertOutcome =
	| { ok: true; run: PlacerRun; reverted: number }
	| { ok: false; status: 404 | 409; error: string };

export function createPlacementService(deps: PlacementServiceDeps) {
	const s = deps.state ?? newPlacementState();
	const place = deps.place ?? runPlacer;
	const slot = deps.slot ?? (<T>(_signal: AbortSignal | undefined, fn: () => Promise<T>) => fn());
	const batchSize = deps.batchSize ?? PLACER_BATCH_SIZE;
	const newRunId = deps.newRunId ?? (() => `place_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);

	const liveNodes = (): GraphNode[] => getGraph(deps.graphStore).nodes;

	function status(): PlacementStatus {
		const nodes = liveNodes();
		const lines = deps.placements.read();
		const view = placementView(lines, nodes.map((n) => n.id));
		const lastRun = [...deps.journal.read()].reverse().find((r) => r.revertedAt === undefined && r.placed > 0);
		return {
			running: s.running,
			unplaced: view.unplaced,
			total: nodes.length,
			...(s.problem ? { problem: s.problem } : {}),
			...(s.error ? { error: s.error } : {}),
			...(lastRun ? { lastRun } : {}),
		};
	}

	function saveRun(run: PlacerRun): void {
		const runs = deps.journal.read();
		const at = runs.findIndex((r) => r.id === run.id);
		if (at >= 0) runs[at] = run;
		else runs.push(run);
		deps.journal.write(runs.slice(-PLACER_RUN_LIMIT));
	}

	/** One pass: place unplaced facts, batch after batch, until none are left or a batch fails. */
	async function runPass(options: { retryCleared?: boolean; signal?: AbortSignal } = {}): Promise<PassOutcome> {
		if (s.running) return { started: false, reason: "busy" };
		const engine = deps.engine();
		if (!engine) {
			s.problem = "no-model";
			s.retryAt = deps.now().getTime() + NO_MODEL_RETRY_MS;
			return { started: false, reason: "no-model" };
		}
		if (deps.providerKeyMissing(engine.model.provider)) {
			s.problem = "no-key";
			s.retryAt = deps.now().getTime() + NO_MODEL_RETRY_MS;
			return { started: false, reason: "no-key" };
		}
		s.running = true;
		s.problem = undefined;
		s.error = undefined;
		const abort = new AbortController();
		s.abort = abort;
		options.signal?.addEventListener("abort", () => abort.abort(), { once: true });
		const signal = abort.signal;
		let run: PlacerRun | undefined;
		let placed = 0;
		let topicsCreated = 0;
		let error: string | undefined;
		try {
			for (;;) {
				signal.throwIfAborted();
				const nodes = liveNodes();
				const todo = unplacedNodes(nodes, deps.placements.read(), { retryCleared: options.retryCleared });
				if (todo.length === 0) break;
				run ??= { id: newRunId(), startedAt: deps.now().toISOString(), kind: todo.length > batchSize ? "backfill" : "new", placed: 0, topicsCreated: 0 };
				const batch = todo.slice(0, batchSize);
				const stuck = batch.filter((n) => (s.attempts.get(n.id) ?? 0) >= PLACER_MAX_ATTEMPTS);
				const askable = batch.filter((n) => !stuck.includes(n));
				let proposals: PlacerProposal[] = [];
				if (askable.length > 0) {
					const topics = placementView(deps.placements.read(), nodes.map((n) => n.id)).topics;
					proposals = await slot(signal, () => place({ engine, nodes: askable, topics, signal }));
				}
				// THE SYNC BLOCK: re-read the ledger and append, with no await between —
				// a placement made while the model was thinking is never overridden.
				const byId = new Map(nodes.map((n) => [n.id, n]));
				const result = applyPlacerProposals(
					deps.placements.read(),
					[...proposals, ...stuck.map((n) => fallbackProposal(n))],
					{
						runId: run.id,
						now: deps.now().toISOString(),
						retryCleared: options.retryCleared,
						systemHint: (id) => byId.get(id)?.systems?.[0],
					},
				);
				deps.placements.append(result.lines);
				placed += result.placed.length;
				topicsCreated += result.topicsCreated;
				run.placed = placed;
				run.topicsCreated = topicsCreated;
				// Whatever the model skipped or botched is tried again, then parked.
				const placedNow = new Set([...result.placed, ...result.alreadyPlaced]);
				for (const n of askable) if (!placedNow.has(n.id)) s.attempts.set(n.id, (s.attempts.get(n.id) ?? 0) + 1);
				if (placed > 0) saveRun(run);
			}
			s.failures = 0;
			s.retryAt = undefined;
		} catch (err) {
			if (err instanceof ModelsNotConfiguredError) {
				s.problem = "no-model";
				s.retryAt = deps.now().getTime() + NO_MODEL_RETRY_MS;
			} else if (err instanceof ProviderKeyMissingError) {
				s.problem = "no-key";
				s.retryAt = deps.now().getTime() + NO_MODEL_RETRY_MS;
			} else if (signal.aborted) {
				// A stop, not a failure: what landed stays, the next look resumes.
			} else {
				error = err instanceof Error ? err.message : String(err);
				s.problem = "failed";
				s.error = error;
				s.retryAt = deps.now().getTime() + BACKOFF_MS[Math.min(s.failures, BACKOFF_MS.length - 1)]!;
				s.failures++;
				console.warn("[placement] batch failed:", err);
			}
		} finally {
			s.running = false;
			s.abort = undefined;
			if (run && run.placed > 0) saveRun({ ...run, finishedAt: deps.now().toISOString(), ...(error ? { error } : {}) });
		}
		return { started: true, placed, topicsCreated, ...(error ? { error } : {}) };
	}

	/** One look at whether anything needs placing. Cheap: runs only when the graph moved or a retry is due. */
	function tick(): void {
		if (s.running || deps.extractionRunning()) return;
		const nowMs = deps.now().getTime();
		const sig = String(deps.revision());
		const due = s.retryAt === undefined ? sig !== s.lastSig : nowMs >= s.retryAt;
		if (!due) return;
		s.lastSig = sig;
		s.retryAt = undefined;
		if (unplacedNodes(liveNodes(), deps.placements.read()).length === 0) {
			s.problem = undefined;
			return;
		}
		void runPass().catch((err) => console.warn("[placement] pass failed:", err));
	}

	/** Withdraw a run's placements (each fact goes back to what it had before it). */
	function revert(runId: string): RevertOutcome {
		if (s.running) return { ok: false, status: 409, error: "Placing is running — try again in a moment." };
		const runs = deps.journal.read();
		const run = runs.find((r) => r.id === runId);
		if (!run) return { ok: false, status: 404, error: "No such placement run." };
		if (run.revertedAt !== undefined) return { ok: false, status: 409, error: "That run was already reverted." };
		const now = deps.now().toISOString();
		const lines = revertRunLines(deps.placements.read(), runId, now);
		deps.placements.append(lines);
		const done: PlacerRun = { ...run, revertedAt: now };
		deps.journal.write(runs.map((r) => (r.id === runId ? done : r)));
		// The reverted facts stay out of the automatic pass (the revert must stick).
		return { ok: true, run: done, reverted: lines.length };
	}

	/** Ask the running pass to stop (what landed stays). */
	function stop(): void {
		s.abort?.abort();
	}

	return { status, tick, runPass, revert, stop, state: s };
}

interface PlacementGlobal {
	__lhPlacementState?: PlacementState;
	__lhPlacementPoll?: ReturnType<typeof setInterval>;
}
const shared = globalThis as typeof globalThis & PlacementGlobal;

/** The wired instance the routes use. */
export const placementService = createPlacementService({
	graphStore: stores.graphStore,
	placements: placementStore,
	journal: placerJournalStore,
	// A background engine, like the extractor's: placing runs on its own.
	engine: () => {
		const spec = resolveRoleSpec("placer", stores.settingsStore.readSettings());
		return spec ? piEngineForSpec(spec) : undefined;
	},
	providerKeyMissing: (provider) => !providerKeyPresent(provider),
	extractionRunning: () => extractionStatuses().length > 0,
	revision: graphRevision,
	now: () => new Date(),
	slot: withBgLlmSlot,
	state: (shared.__lhPlacementState ??= newPlacementState()),
});

/** Start watching (once per process). Called from instrumentation.ts at boot. */
export function startPlacement(): void {
	if (shared.__lhPlacementPoll) return;
	const timer = setInterval(() => {
		try {
			placementService.tick();
		} catch (err) {
			console.warn("[placement] watch failed:", err);
		}
	}, PLACEMENT_POLL_MS);
	timer.unref?.();
	shared.__lhPlacementPoll = timer;
	placementService.tick(); // catch up: place whatever is waiting from before the app closed
}
