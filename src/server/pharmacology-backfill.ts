/**
 * The one-time drug back-fill (medical fork): facts saved before the
 * `pharmacology` fact type existed carry another type. This pass asks the
 * placer-role model, batch by batch, which facts are CLEARLY about a drug
 * itself and upgrades just those to `pharmacology` (the one exception to
 * "first assignment sticks"; a learner's own tag edit is never touched).
 *
 * Automatic and quiet, like placement: no prompt, no button. Progress is a
 * small file of facts already looked at, written after every batch, so the
 * pass is RESUMABLE (a stop or restart loses nothing) and ONE-TIME (it records
 * when it finished and never runs again; new facts get the type from
 * extraction). A missing model or sign-in just waits; a failure backs off.
 */

import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { extractionStatuses } from "../agent/subagents/extraction.ts";
import { withBgLlmSlot } from "../agent/subagents/bg-llm-semaphore.ts";
import { TAG_BATCH_SIZE, runDrugClassifier } from "../agent/subagents/tagger.ts";
import type { GraphNode } from "../core/contracts.ts";
import { getGraph, learnerTaggedIds, upgradeToPharmacology } from "../core/graph.ts";
import type { GraphStore } from "../core/ports.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../core/settings.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { pharmacologyBackfillStore, type PharmacologyBackfillStore } from "../store/pharmacology-backfill.ts";
import { providerKeyPresent } from "./keys.ts";
import { stores } from "./stores.ts";

export const PHARMACOLOGY_POLL_MS = 15_000;
const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 900_000];
const NO_MODEL_RETRY_MS = 60_000;

export interface PharmacologyBackfillRuntime {
	running: boolean;
	retryAt: number | undefined;
	failures: number;
}

export const newPharmacologyBackfillRuntime = (): PharmacologyBackfillRuntime => ({ running: false, retryAt: undefined, failures: 0 });

export interface PharmacologyBackfillDeps {
	graphStore: Pick<GraphStore, "readNodes" | "readChains" | "appendNode">;
	progress: PharmacologyBackfillStore;
	engine: () => PiEngine | undefined;
	providerKeyMissing: (provider: string) => boolean;
	extractionRunning: () => boolean;
	now: () => Date;
	/** The model call (a seam: tests pass a local fake). */
	classify?: typeof runDrugClassifier;
	slot?: <T>(signal: AbortSignal | undefined, fn: () => Promise<T>) => Promise<T>;
	batchSize?: number;
	state?: PharmacologyBackfillRuntime;
}

export type BackfillOutcome =
	| { started: false; reason: "busy" | "done" | "no-model" | "no-key" }
	| { started: true; looked: number; upgraded: number; completed: boolean; error?: string };

export function createPharmacologyBackfill(deps: PharmacologyBackfillDeps) {
	const s = deps.state ?? newPharmacologyBackfillRuntime();
	const classify = deps.classify ?? runDrugClassifier;
	const slot = deps.slot ?? (<T>(_signal: AbortSignal | undefined, fn: () => Promise<T>) => fn());
	const batchSize = deps.batchSize ?? TAG_BATCH_SIZE;

	/** Facts still to look at: not yet checked, not edited by the learner, not already pharmacology. */
	function remaining(): GraphNode[] {
		const state = deps.progress.read();
		if (state.completedAt !== undefined) return [];
		const checked = new Set(state.checked);
		return getGraph(deps.graphStore).nodes.filter((n) => !checked.has(n.id));
	}

	async function run(signal?: AbortSignal): Promise<BackfillOutcome> {
		if (s.running) return { started: false, reason: "busy" };
		if (deps.progress.read().completedAt !== undefined) return { started: false, reason: "done" };
		const engine = deps.engine();
		if (!engine) {
			s.retryAt = deps.now().getTime() + NO_MODEL_RETRY_MS;
			return { started: false, reason: "no-model" };
		}
		if (deps.providerKeyMissing(engine.model.provider)) {
			s.retryAt = deps.now().getTime() + NO_MODEL_RETRY_MS;
			return { started: false, reason: "no-key" };
		}
		s.running = true;
		let looked = 0;
		let upgraded = 0;
		let completed = false;
		let error: string | undefined;
		try {
			for (;;) {
				signal?.throwIfAborted();
				const todo = remaining();
				if (todo.length === 0) {
					const state = deps.progress.read();
					deps.progress.write({ checked: state.checked, completedAt: deps.now().toISOString() });
					completed = true;
					break;
				}
				const locked = learnerTaggedIds(deps.graphStore);
				// The learner's own tags and facts already pharmacology need no question.
				const askable = todo.filter((n) => !locked.has(n.id) && n.factType !== "pharmacology").slice(0, batchSize);
				const skipped = todo.filter((n) => locked.has(n.id) || n.factType === "pharmacology").slice(0, batchSize);
				let drugIds: string[] = [];
				if (askable.length > 0) {
					drugIds = await slot(signal, () => classify({ engine, nodes: askable, signal }));
				}
				// THE SYNC BLOCK: upgrade and record progress with no await between.
				upgraded += upgradeToPharmacology(deps.graphStore, drugIds).length;
				const state = deps.progress.read();
				const done = new Set([...state.checked, ...askable.map((n) => n.id), ...skipped.map((n) => n.id)]);
				deps.progress.write({ checked: [...done] });
				looked += askable.length + skipped.length;
			}
			s.failures = 0;
			s.retryAt = undefined;
		} catch (err) {
			if (err instanceof ModelsNotConfiguredError || err instanceof ProviderKeyMissingError) {
				s.retryAt = deps.now().getTime() + NO_MODEL_RETRY_MS;
			} else if (signal?.aborted) {
				// A stop, not a failure: what landed stays, the next look resumes.
			} else {
				error = err instanceof Error ? err.message : String(err);
				s.retryAt = deps.now().getTime() + BACKOFF_MS[Math.min(s.failures, BACKOFF_MS.length - 1)]!;
				s.failures++;
				console.warn("[pharmacology-backfill] batch failed:", err);
			}
		} finally {
			s.running = false;
		}
		return { started: true, looked, upgraded, completed, ...(error ? { error } : {}) };
	}

	/** One look: start the pass when it has work and is not waiting out a retry. Cheap once finished. */
	function tick(): void {
		if (s.running || deps.extractionRunning()) return;
		if (s.retryAt !== undefined && deps.now().getTime() < s.retryAt) return;
		if (deps.progress.read().completedAt !== undefined) return;
		void run().catch((err) => console.warn("[pharmacology-backfill] pass failed:", err));
	}

	return { run, tick, state: s };
}

interface BackfillGlobal {
	__lhPharmacologyState?: PharmacologyBackfillRuntime;
	__lhPharmacologyPoll?: ReturnType<typeof setInterval>;
}
const shared = globalThis as typeof globalThis & BackfillGlobal;

export const pharmacologyBackfill = createPharmacologyBackfill({
	graphStore: stores.graphStore,
	progress: pharmacologyBackfillStore,
	engine: () => {
		const spec = resolveRoleSpec("placer", stores.settingsStore.readSettings());
		return spec ? piEngineForSpec(spec) : undefined;
	},
	providerKeyMissing: (provider) => !providerKeyPresent(provider),
	extractionRunning: () => extractionStatuses().length > 0,
	now: () => new Date(),
	slot: withBgLlmSlot,
	state: (shared.__lhPharmacologyState ??= newPharmacologyBackfillRuntime()),
});

/** Start watching (once per process). Called from instrumentation.ts at boot. */
export function startPharmacologyBackfill(): void {
	if (shared.__lhPharmacologyPoll) return;
	const timer = setInterval(() => {
		try {
			pharmacologyBackfill.tick();
		} catch (err) {
			console.warn("[pharmacology-backfill] watch failed:", err);
		}
	}, PHARMACOLOGY_POLL_MS);
	timer.unref?.();
	shared.__lhPharmacologyPoll = timer;
	pharmacologyBackfill.tick(); // pick up where it left off
}
