/**
 * Review mode and the Obsidian copy — shared shapes (medical fork,
 * docs/medical-spec.md "Obsidian copy and Review mode"). Types and constants
 * only, browser-safe. The behaviour lives in core/illness-script.ts (script
 * validation, staleness and rendering) and core/obsidian.ts (the vault).
 */

import type { OrganSystem } from "./graph.ts";

// ─── the illness script's shape ──────────────────────────────────────────────

/** The nine parts of an illness script, in reading order. */
export const SCRIPT_SECTIONS = [
	{ id: "definition", title: "Definition", hint: "What the illness is, in one or two sentences a clinician would accept." },
	{ id: "who", title: "Who gets it", hint: "Epidemiology and risk factors: who is affected and what raises the risk." },
	{ id: "pathophysiology", title: "Pathophysiology", hint: "The mechanism, step by step, ending at what the clinician sees." },
	{ id: "presentation", title: "Presentation", hint: "Symptoms and signs; the classic picture and the common variations." },
	{ id: "differentials", title: "Differentials", hint: "What it gets confused with and the one or two features that tell them apart." },
	{ id: "investigations", title: "Investigations", hint: "Which tests, in what order, and what they show." },
	{ id: "management", title: "Management", hint: "Treatment and the reasoning behind it. Changing-tier content." },
	{ id: "complications", title: "Complications and prognosis", hint: "What goes wrong and how it tends to turn out." },
	{ id: "pearls", title: "High-yield pearls", hint: "The facts an examiner or a ward round returns to." },
] as const;

export type ScriptSectionId = (typeof SCRIPT_SECTIONS)[number]["id"];

export const isScriptSectionId = (v: unknown): v is ScriptSectionId =>
	typeof v === "string" && SCRIPT_SECTIONS.some((s) => s.id === v);

/** Where a claim came from. Library labels are fixed at validation time. */
export type ScriptSourceRef =
	| { type: "graph"; nodeId: string }
	| { type: "library"; bookId: string; page: number; label: string }
	| { type: "expert"; id: string; date: string };

export interface ScriptClaim {
	text: string;
	sources: ScriptSourceRef[];
	/** True for settled-tier science the writer gave from general knowledge (no source read). */
	general: boolean;
	/** Changing tier: management, drugs, doses, thresholds, schedules. */
	changing: boolean;
	/** Render as a list item instead of running text. */
	bullet: boolean;
}

export interface ScriptImage {
	/** "page" = a page or slide of the learner's own library; "diagram" = drawn by the app. */
	kind: "page" | "diagram";
	/** File name inside the vault's Attachments folder (and the app's own copy). */
	file: string;
	caption: string;
	/** Page images only: the library page it was rendered from. */
	source?: { bookId: string; page: number; label: string };
}

export interface ScriptSection {
	id: ScriptSectionId;
	claims: ScriptClaim[];
	/** What the learner's sources do not cover — marked, never filled from memory. */
	gaps: string[];
	images: ScriptImage[];
}

/** What the script was built from — the yardstick for "out of date". */
export interface ScriptBasis {
	/** node id → fingerprint of its name, statement and tags when the script was written */
	nodes: Record<string, string>;
	/** node id → name then, for showing a node that has since been deleted */
	names: Record<string, string>;
	/** fingerprint of the connections that touch those nodes */
	chainsFp: string;
	/** lowercase words that name the illness, for spotting new related nodes */
	terms: string[];
}

export interface IllnessScript {
	slug: string;
	title: string;
	aliases: string[];
	systems: OrganSystem[];
	generatedAt: string;
	sections: ScriptSection[];
	basis: ScriptBasis;
	sources: {
		library: Array<{ bookId: string; label: string; pages: number[] }>;
		expert: Array<{ id: string; date: string; prompt: string }>;
	};
	usage: { calls: number; inputTokens: number; outputTokens: number };
}

// ─── the illness list ────────────────────────────────────────────────────────

export interface CatalogueIllness {
	title: string;
	aliases: string[];
	/** The graph nodes that belong to it. */
	nodeIds: string[];
}

export interface IllnessCatalogue {
	builtAt: string;
	/** Fingerprint of the graph when it was built. */
	graphFp: string;
	illnesses: CatalogueIllness[];
}

// ─── what the pages show ─────────────────────────────────────────────────────

export type ScriptFreshness = "current" | "outdated";

export interface ScriptListItem {
	slug: string;
	title: string;
	generatedAt: string;
	freshness: ScriptFreshness;
	/** Plain-language reasons it is out of date. */
	reasons: string[];
	claims: number;
	gaps: number;
	images: number;
}

export type ReviewPhase = "listing" | "gathering" | "drawing" | "saving";

export interface ReviewRunState {
	kind: "one" | "all";
	running: boolean;
	stopping: boolean;
	startedAt: string;
	finishedAt?: string;
	/** Illnesses to go through (known once the list is built). */
	total: number;
	/** Written so far. */
	written: number;
	/** Skipped because they were already up to date. */
	skipped: number;
	failed: Array<{ title: string; error: string }>;
	current?: string;
	phase?: ReviewPhase;
	/** A plain line for the learner: what happened or why it stopped. */
	message?: string;
}

export interface ReviewStatus {
	vault: { configured: boolean; problem?: string };
	scripts: ScriptListItem[];
	catalogue: { count: number; builtAt: string; outdated: boolean } | null;
	run: ReviewRunState | null;
}

export interface ObsidianSyncReport {
	written: number;
	unchanged: number;
	moved: number;
	removed: number;
	salvaged: number;
	skipped: number;
	assets: number;
	notes: number;
}

export interface ObsidianStatus {
	/** The configured vault folder, if any. */
	vaultPath: string | null;
	/** Where the notes go: <vault>/LearnHarness. */
	appFolder: string | null;
	/** A starting point the learner can accept (never applied on its own). */
	suggested: string | null;
	state: "off" | "idle" | "waiting" | "syncing" | "error";
	problem?: string;
	lastSyncAt?: string;
	lastReport?: ObsidianSyncReport;
}
