/**
 * The Obsidian copy, live (medical fork, docs/medical-spec.md "Obsidian copy
 * and Review mode"): keeps the learner's vault in step with the graph and the
 * illness scripts, with no button.
 *
 * How "live" works. The graph has many writers (extraction, the organizer,
 * deletion, tag edits) and they all end in the graph ledgers, so the service
 * does not hook each one: a light poll watches the graph's revision (the
 * ledgers' newest mtime, `graphRevision()`) and the Settings record. When
 * either moves, a DEBOUNCED sync is scheduled — a burst of changes becomes
 * one run a few seconds after the last — and the run rebuilds the desired
 * notes from the graph and reconciles the vault (core/obsidian.ts), touching
 * only files whose content changed.
 *
 * One-way: nothing here reads the vault back into the graph. Off until a
 * vault folder is set in Settings. Everything is written inside one
 * app-owned folder (store/obsidian-vault.ts enforces it).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IllnessScript, ObsidianStatus, ObsidianSyncReport } from "../core/contracts.ts";
import { getGraph } from "../core/graph.ts";
import { scriptFreshness, renderScriptNote, scriptStem } from "../core/illness-script.ts";
import {
	ASSETS_DIR,
	OBSIDIAN_APP_FOLDER,
	StemRegistry,
	buildGraphNotes,
	syncVault,
	type DesiredAsset,
	type DesiredVault,
	type VaultPort,
} from "../core/obsidian.ts";
import type { GraphStore, ReviewStore } from "../core/ports.ts";
import type { UserSettings } from "../core/settings.ts";
import { createVault, VaultError, vaultProblem } from "../store/obsidian-vault.ts";
import { reviewStore } from "../store/review.ts";
import { graphRevision } from "./graph.ts";
import { stores } from "./stores.ts";

export const OBSIDIAN_DEBOUNCE_MS = 3000;
/** A steady stream of changes still syncs at least this often. */
export const OBSIDIAN_MAX_WAIT_MS = 20_000;
export const OBSIDIAN_POLL_MS = 2000;

interface SyncState {
	timer: ReturnType<typeof setTimeout> | undefined;
	pendingSince: number | undefined;
	lastSig: string | undefined;
	state: ObsidianStatus["state"];
	problem: string | undefined;
	lastSyncAt: string | undefined;
	lastReport: ObsidianSyncReport | undefined;
}

export interface ObsidianSyncDeps {
	readSettings: () => UserSettings | null;
	graphStore: Pick<GraphStore, "readNodes" | "readChains" | "readSources">;
	reviewStore: ReviewStore;
	makeVault: (vaultPath: string) => VaultPort & { appRoot: string };
	revision: () => number;
	now: () => Date;
	/** A starting point for the folder field, or null. Never applied by itself. */
	suggest: () => string | null;
	setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
	clearTimer: (t: ReturnType<typeof setTimeout>) => void;
	debounceMs?: number;
	maxWaitMs?: number;
	/** Shared state (the wired instance keeps it on globalThis so dev reloads don't fork it). */
	state?: SyncState;
}

export const newSyncState = (): SyncState => ({
	timer: undefined,
	pendingSince: undefined,
	lastSig: undefined,
	state: "off",
	problem: undefined,
	lastSyncAt: undefined,
	lastReport: undefined,
});

/** The notes and images the vault should hold for this graph and these scripts. */
export function buildDesiredVault(
	graphStore: ObsidianSyncDeps["graphStore"],
	scripts: readonly IllnessScript[],
	store: Pick<ReviewStore, "assetSize" | "readAsset">,
	reservedStems: readonly string[],
): DesiredVault {
	const graph = getGraph(graphStore);
	const fileSources: Record<string, string> = {};
	for (const source of graphStore.readSources()) fileSources[source.id] = source.filePath;

	// Script stems first, around names already in the folder; node names then avoid both.
	const scriptNames = new StemRegistry(reservedStems);
	const stemOfScript = new Map(
		[...scripts].sort((a, b) => a.slug.localeCompare(b.slug)).map((s) => [s.slug, scriptNames.claim(scriptStem(s.title), s.slug)] as const),
	);
	const { notes, names } = buildGraphNotes({ nodes: graph.nodes, chains: graph.chains, fileSources }, [...reservedStems, ...stemOfScript.values()]);
	const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));

	const assets: DesiredAsset[] = [];
	for (const script of scripts) {
		notes.push(
			renderScriptNote(script, {
				stem: stemOfScript.get(script.slug),
				stems: names.stems,
				nodesById,
				chains: graph.chains,
				freshness: scriptFreshness(script, graph),
			}),
		);
		for (const section of script.sections) {
			for (const image of section.images) {
				const size = store.assetSize(image.file);
				if (size === null) continue; // the app's own copy is gone; leave the vault as it is
				assets.push({
					path: `${ASSETS_DIR}/${image.file}`,
					size,
					bytes: () => store.readAsset(image.file) ?? new Uint8Array(),
				});
			}
		}
	}
	return { notes, assets };
}

export function createObsidianSync(deps: ObsidianSyncDeps) {
	const s = deps.state ?? newSyncState();
	const debounceMs = deps.debounceMs ?? OBSIDIAN_DEBOUNCE_MS;
	const maxWaitMs = deps.maxWaitMs ?? OBSIDIAN_MAX_WAIT_MS;

	const vaultPath = (): string | null => deps.readSettings()?.obsidian?.vaultPath ?? null;

	function status(): ObsidianStatus {
		const configured = vaultPath();
		const live = configured !== null;
		return {
			vaultPath: configured,
			// Display only. Plain concatenation: path.join here makes the bundler trace the whole project.
			appFolder: configured ? `${configured.replace(/[\\/]+$/, "")}${path.sep}${OBSIDIAN_APP_FOLDER}` : null,
			suggested: deps.suggest(),
			state: live ? (s.state === "off" ? "idle" : s.state) : "off",
			...(live && s.problem ? { problem: s.problem } : {}),
			...(live && s.lastSyncAt ? { lastSyncAt: s.lastSyncAt } : {}),
			...(live && s.lastReport ? { lastReport: s.lastReport } : {}),
		};
	}

	function clearPending(): void {
		if (s.timer !== undefined) deps.clearTimer(s.timer);
		s.timer = undefined;
		s.pendingSince = undefined;
	}

	/** Do the sync now. Never throws: a failure becomes the status the Settings page shows. */
	function run(): ObsidianStatus {
		clearPending();
		const configured = vaultPath();
		if (configured === null) {
			s.state = "off";
			s.problem = undefined;
			return status();
		}
		s.state = "syncing";
		try {
			const vault = deps.makeVault(configured);
			const scripts = deps.reviewStore.listScripts();
			const report = syncVault(
				vault,
				(reserved) => buildDesiredVault(deps.graphStore, scripts, deps.reviewStore, reserved),
				deps.now(),
			);
			s.state = "idle";
			s.problem = undefined;
			s.lastReport = report;
			s.lastSyncAt = deps.now().toISOString();
		} catch (err) {
			s.state = "error";
			s.problem = err instanceof VaultError ? err.message : `Couldn't update the Obsidian notes: ${err instanceof Error ? err.message : String(err)}`;
			console.warn("[obsidian] sync failed:", err);
		}
		return status();
	}

	/** Something changed: sync soon. Calls within the debounce window collapse into one run. */
	function notify(): void {
		if (vaultPath() === null) {
			clearPending();
			s.state = "off";
			return;
		}
		const nowMs = deps.now().getTime();
		s.pendingSince ??= nowMs;
		if (s.timer !== undefined) deps.clearTimer(s.timer);
		const wait = Math.max(0, Math.min(debounceMs, s.pendingSince + maxWaitMs - nowMs));
		s.state = "waiting";
		s.timer = deps.setTimer(() => {
			s.timer = undefined;
			run();
		}, wait);
	}

	/** One look at what could have changed. Cheap enough to call every couple of seconds. */
	function tick(): void {
		const configured = vaultPath();
		const sig = `${configured ?? ""}|${configured ? deps.revision() : ""}`;
		if (sig === s.lastSig) return;
		s.lastSig = sig;
		notify();
	}

	return { status, notify, run, tick, state: s };
}

/** Is `~/SlideScribe/vault` there? The owner's notes live under it; offered, never assumed. */
function suggestedVault(): string | null {
	const candidate = path.join(os.homedir(), "SlideScribe", "vault");
	return vaultProblem(candidate) === null && fs.existsSync(candidate) ? candidate : null;
}

interface ObsidianGlobal {
	__lhObsidianState?: SyncState;
	__lhObsidianPoll?: ReturnType<typeof setInterval>;
}
const shared = globalThis as typeof globalThis & ObsidianGlobal;

/** The wired instance the routes and the Review service use. */
export const obsidianSync = createObsidianSync({
	readSettings: () => stores.settingsStore.readSettings(),
	graphStore: stores.graphStore,
	reviewStore,
	makeVault: createVault,
	revision: graphRevision,
	now: () => new Date(),
	suggest: suggestedVault,
	setTimer: (fn, ms) => {
		const t = setTimeout(fn, ms);
		t.unref?.();
		return t;
	},
	clearTimer: clearTimeout,
	state: (shared.__lhObsidianState ??= newSyncState()),
});

/** Start watching (once per process). Called from instrumentation.ts at boot. */
export function startObsidianSync(): void {
	if (shared.__lhObsidianPoll) return;
	const timer = setInterval(() => {
		try {
			obsidianSync.tick();
		} catch (err) {
			console.warn("[obsidian] watch failed:", err);
		}
	}, OBSIDIAN_POLL_MS);
	timer.unref?.();
	shared.__lhObsidianPoll = timer;
	obsidianSync.tick(); // catch up with whatever changed while the app was closed
}
