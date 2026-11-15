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
import type { IllnessScript, ObsidianStatus, ObsidianSyncReport, SessionRecap } from "../core/contracts.ts";
import { getGraph } from "../core/graph.ts";
import { scriptFreshness, renderScriptNote, scriptStem, systemsOf } from "../core/illness-script.ts";
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
import { placementView } from "../core/placement.ts";
import type { GraphStore, PlacementStore, RecapStore, ReviewStore } from "../core/ports.ts";
import { recapStem, renderRecapNote, sessionFacts } from "../core/session-recap.ts";
import type { UserSettings } from "../core/settings.ts";
import { createVault, VaultError, vaultProblem } from "../store/obsidian-vault.ts";
import { placementStore } from "../store/placements.ts";
import { recapStore } from "../store/recaps.ts";
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
	/** Where the last run put each session recap: chat id → path relative to the app folder. */
	recapPaths: Map<string, string>;
}

export interface ObsidianSyncDeps {
	readSettings: () => UserSettings | null;
	graphStore: Pick<GraphStore, "readNodes" | "readChains" | "readSources">;
	reviewStore: ReviewStore;
	/** The session recaps the app holds (optional: tests of the older parts leave it out). */
	recapStore?: RecapStore;
	/** Where each fact sits in the outline — absent keeps the flat Nodes/ layout. */
	placements?: Pick<PlacementStore, "read">;
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
	recapPaths: new Map(),
});

/** The notes and images the vault should hold for this graph and these scripts. */
export function buildDesiredVault(
	graphStore: ObsidianSyncDeps["graphStore"],
	scripts: readonly IllnessScript[],
	store: Pick<ReviewStore, "assetSize" | "readAsset">,
	reservedStems: readonly string[],
	placements?: Pick<PlacementStore, "read">,
	recaps?: { recaps: readonly SessionRecap[]; store: Pick<RecapStore, "assetSize" | "readAsset"> },
): DesiredVault {
	const graph = getGraph(graphStore);
	const fileSources: Record<string, string> = {};
	for (const source of graphStore.readSources()) fileSources[source.id] = source.filePath;

	// Script stems first, around names already in the folder; node names then avoid both.
	const scriptNames = new StemRegistry(reservedStems);
	const stemOfScript = new Map(
		[...scripts].sort((a, b) => a.slug.localeCompare(b.slug)).map((s) => [s.slug, scriptNames.claim(scriptStem(s.title), s.slug)] as const),
	);
	// Session recaps claim their names right after the scripts, in a fixed order, so a note keeps its name.
	const stemOfRecap = new Map(
		[...(recaps?.recaps ?? [])]
			.sort((a, b) => a.sessionDate.localeCompare(b.sessionDate) || a.chatId.localeCompare(b.chatId))
			.map((r) => [r.chatId, scriptNames.claim(recapStem(r.sessionDate, r.title), r.chatId)] as const),
	);
	const placement = placements ? placementView(placements.read(), graph.nodes.map((n) => n.id)) : undefined;
	const { notes, names } = buildGraphNotes(
		{ nodes: graph.nodes, chains: graph.chains, fileSources, ...(placement ? { placement } : {}) },
		[...reservedStems, ...stemOfScript.values(), ...stemOfRecap.values()],
	);
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

	for (const recap of recaps?.recaps ?? []) {
		const facts = sessionFacts(graph.nodes, recap.chatId).filter((n) => names.stems.has(n.id));
		notes.push(
			renderRecapNote(recap, {
				stem: stemOfRecap.get(recap.chatId),
				facts: facts.map((n) => ({ stem: names.stems.get(n.id)!, name: n.name })),
				systems: systemsOf(
					facts.map((n) => n.id),
					nodesById,
				),
			}),
		);
		for (const topic of recap.topics) {
			for (const figure of topic.figures) {
				const size = recaps!.store.assetSize(figure.file);
				if (size === null) continue; // the app's own copy is gone; leave the vault as it is
				assets.push({
					path: `${ASSETS_DIR}/${figure.file}`,
					size,
					bytes: () => recaps!.store.readAsset(figure.file) ?? new Uint8Array(),
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
			const recaps = deps.recapStore ? { recaps: deps.recapStore.list(), store: deps.recapStore } : undefined;
			const report = syncVault(
				vault,
				(reserved) => {
					const desired = buildDesiredVault(deps.graphStore, scripts, deps.reviewStore, reserved, deps.placements, recaps);
					s.recapPaths = new Map(desired.notes.filter((n) => n.kind === "recap").map((n) => [n.id, n.path]));
					return desired;
				},
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

	/** Where the last run put a session's recap, relative to the app folder, or null. */
	const recapPath = (chatId: string): string | null => s.recapPaths?.get(chatId) ?? null;

	return { status, notify, run, tick, recapPath, state: s };
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
	recapStore,
	placements: placementStore,
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
