/**
 * Placement contracts (medical fork, docs/medical-spec.md "Textbook outline
 * placement"): every fact (graph node) gets ONE primary place —
 * organ system → topic (a disease or subject) → aspect — so the graph can be
 * read like a textbook contents page and the Obsidian copy can use the same
 * folders.
 *
 * Placement is its own APPEND-ONLY ledger beside the graph ledgers
 * (data/graph/placements.jsonl); node and chain records are never touched.
 * Everything the app shows is derived from it (core/placement.ts).
 *
 * Three kinds of line share the ledger:
 *   topic   a canonical topic — minted once, reused by every later placement
 *   place   a node's placement (the latest line for a node wins)
 *   clear   a node's placement withdrawn (written only when a placer run is
 *           reverted and the node had no earlier placement)
 *
 * Pure types + tiny helpers: browser-safe, the outline imports them.
 */

import { ORGAN_SYSTEMS, type OrganSystem } from "./graph.ts";

/** The aspect slots: the illness-script sections a fact can belong to, plus a
 *  catch-all for facts that fit none. Stored values are the stable `id`s. */
export const PLACEMENT_ASPECTS = [
	{ id: "risk-factors", label: "Risk factors" },
	{ id: "how-it-develops", label: "How it develops" },
	{ id: "presentation", label: "Presentation" },
	{ id: "workup", label: "Workup" },
	{ id: "management", label: "Management" },
	{ id: "complications", label: "Complications" },
	{ id: "other", label: "General / other" },
] as const;

export type PlacementAspect = (typeof PLACEMENT_ASPECTS)[number]["id"];

/** The aspect a fact gets when nothing better fits (or the model said nothing usable). */
export const DEFAULT_ASPECT: PlacementAspect = "other";

const ASPECT_IDS: ReadonlySet<string> = new Set(PLACEMENT_ASPECTS.map((a) => a.id));
export const isPlacementAspect = (v: unknown): v is PlacementAspect => typeof v === "string" && ASPECT_IDS.has(v);

export function placementAspectLabel(id: PlacementAspect): string {
	return PLACEMENT_ASPECTS.find((a) => a.id === id)?.label ?? id;
}

/** Tolerant lookup for model/learner text: an id or a label, any case, with
 *  spaces, underscores and slashes treated alike. Undefined when it names nothing. */
export function sanitizePlacementAspect(raw: unknown): PlacementAspect | undefined {
	if (typeof raw !== "string") return undefined;
	const norm = (v: string) => v.trim().toLowerCase().replace(/[\s_/]+/g, "-");
	const wanted = norm(raw);
	if (wanted === "") return undefined;
	const hit = PLACEMENT_ASPECTS.find((a) => a.id === wanted || norm(a.label) === wanted);
	if (hit) return hit.id;
	// A few natural phrasings the models and the learner use.
	const alias: Record<string, PlacementAspect> = {
		pathophysiology: "how-it-develops",
		mechanism: "how-it-develops",
		"how-it-develops": "how-it-develops",
		aetiology: "risk-factors",
		etiology: "risk-factors",
		"clinical-features": "presentation",
		"clinical-presentation": "presentation",
		investigations: "workup",
		investigation: "workup",
		diagnosis: "workup",
		treatment: "management",
		general: "other",
		"general-other": "other",
	};
	return alias[wanted];
}

/** A canonical topic — a disease or subject, owned by exactly one organ system. */
export interface PlacementTopic {
	/** "t_" + hex, minted by the store. */
	id: string;
	name: string;
	system: OrganSystem;
}

/** Who placed a fact. The learner's placement (organizer) is never overridden by the placer. */
export type PlacementSource = "placer" | "learner";

export type PlacementConfidence = "high" | "low";

export interface TopicLine {
	kind: "topic";
	id: string;
	name: string;
	system: OrganSystem;
	createdAt: string;
	/** The placer run that minted it, when one did. */
	runId?: string;
}

export interface PlaceLine {
	kind: "place";
	nodeId: string;
	topicId: string;
	aspect: PlacementAspect;
	source: PlacementSource;
	/** A best guess is still applied; "low" only marks it subtly in the outline. */
	confidence: PlacementConfidence;
	at: string;
	runId?: string;
}

export interface ClearLine {
	kind: "clear";
	nodeId: string;
	at: string;
	runId?: string;
}

export type PlacementLine = TopicLine | PlaceLine | ClearLine;

/** One node's current placement, derived. */
export interface NodePlacement {
	topicId: string;
	aspect: PlacementAspect;
	source: PlacementSource;
	confidence: PlacementConfidence;
}

/** What the graph payload and the outline carry: topics in use + each placed node. */
export interface PlacementView {
	/** Topics that hold at least one live fact. */
	topics: PlacementTopic[];
	byNode: Record<string, NodePlacement>;
	/** Live nodes with no placement yet (waiting for the placer). */
	unplaced: number;
	/** Live nodes whose placement a revert withdrew (the automatic pass leaves them alone). */
	withdrawn: number;
}

/** One placer run, as the journal keeps it (data/graph/placer-runs.json). */
export interface PlacerRun {
	id: string;
	startedAt: string;
	finishedAt?: string;
	/** "backfill" for a pass that began with a large backlog, "new" for a few fresh facts. */
	kind: "backfill" | "new";
	placed: number;
	topicsCreated: number;
	/** Set when the learner (or a test) reverted the run. */
	revertedAt?: string;
	error?: string;
}

/** The system a "move" or a prompt may name: an id or a label. */
export function systemLabelFor(id: OrganSystem): string {
	return ORGAN_SYSTEMS.find((s) => s.id === id)?.label ?? id;
}

/** "GI/Hepatobiliary › Small-bowel obstruction › How it develops". */
export function placementPathText(
	topic: Pick<PlacementTopic, "name" | "system"> | undefined,
	aspect: PlacementAspect | undefined,
): string {
	if (!topic) return "Not placed yet";
	const parts = [systemLabelFor(topic.system), topic.name];
	if (aspect) parts.push(placementAspectLabel(aspect));
	return parts.join(" › ");
}
