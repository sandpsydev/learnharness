/**
 * Placement — pure core (medical fork, docs/medical-spec.md "Textbook outline
 * placement"). Reads and derives from the placement ledger; decides, as data,
 * which lines a placer run or a revert appends. No model, no filesystem —
 * every rule here is testable on its own.
 *
 * The ledger is APPEND-ONLY (contracts/placement.ts):
 *   topic   a canonical topic (a disease/subject owned by one organ system)
 *   place   a node's placement — the latest line for a node wins
 *   clear   a node's placement withdrawn (a revert with nothing to go back to)
 *
 * Topics are CANONICAL and de-duplicated: a placement that names a topic the
 * app already holds — by id, by name in any spelling, or by an unambiguous
 * acronym ("SBO" for "Small-bowel obstruction") — reuses it; only a genuinely
 * new name mints one.
 */

import { randomBytes } from "node:crypto";
import { ORGAN_SYSTEMS, sanitizeSystems, type GraphNode, type OrganSystem } from "./contracts.ts";
import {
	DEFAULT_ASPECT,
	sanitizePlacementAspect,
	systemLabelFor,
	type NodePlacement,
	type PlaceLine,
	type PlacementAspect,
	type PlacementConfidence,
	type PlacementLine,
	type PlacementSource,
	type PlacementTopic,
	type PlacementView,
	type TopicLine,
} from "./contracts/placement.ts";

/** A topic name is a short handle, like a textbook chapter heading. */
export const TOPIC_NAME_MAX = 80;

export function newTopicId(): string {
	return `t_${randomBytes(6).toString("hex")}`;
}

// ─── topic identity ──────────────────────────────────────────────────────────

/** Spelling-insensitive key: "Small-bowel obstruction" = "small bowel obstruction". */
export function topicKey(name: string): string {
	return name
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "");
}

/** First letters of the words: "Small-bowel obstruction" → "sbo". Empty for a one-word name. */
export function topicInitials(name: string): string {
	const words = name
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((w) => w !== "" && !["of", "the", "and", "in", "with", "to", "a"].includes(w));
	return words.length >= 2 ? words.map((w) => w[0]).join("") : "";
}

const cleanName = (name: string): string => name.replace(/\s+/g, " ").trim();

/**
 * The existing topic a name means, or undefined. Order: an exact id; the same
 * name in any spelling; an acronym that is the initials of exactly ONE topic in
 * the same system (an ambiguous acronym is not guessed at).
 */
export function findTopic(topics: Iterable<PlacementTopic>, nameOrId: string, system?: OrganSystem): PlacementTopic | undefined {
	const wanted = cleanName(nameOrId);
	if (wanted === "") return undefined;
	const all = [...topics];
	const byId = all.find((t) => t.id === wanted);
	if (byId) return byId;
	const key = topicKey(wanted);
	if (key !== "") {
		const same = all.filter((t) => topicKey(t.name) === key);
		// A name shared by topics in different systems: prefer the asked system.
		const hit = (system !== undefined ? same.find((t) => t.system === system) : undefined) ?? same[0];
		if (hit) return hit;
	}
	// Acronym: 2–6 letters, no spaces.
	if (/^[A-Za-z]{2,6}$/.test(wanted)) {
		const acr = wanted.toLowerCase();
		const matches = all.filter((t) => topicInitials(t.name) === acr && (system === undefined || t.system === system));
		if (matches.length === 1) return matches[0];
	}
	return undefined;
}

// ─── derivation ──────────────────────────────────────────────────────────────

export interface DerivedPlacements {
	/** Every topic ever minted, by id. */
	topics: Map<string, PlacementTopic>;
	/** Current placement per node (nodes whose latest line is a clear are absent). */
	byNode: Map<string, NodePlacement>;
	/** Nodes whose latest line is a clear — deliberately unplaced. */
	cleared: Set<string>;
}

export function derivePlacements(lines: readonly PlacementLine[]): DerivedPlacements {
	const topics = new Map<string, PlacementTopic>();
	for (const line of lines) {
		if (line.kind === "topic" && !topics.has(line.id)) topics.set(line.id, { id: line.id, name: line.name, system: line.system });
	}
	const byNode = new Map<string, NodePlacement>();
	const cleared = new Set<string>();
	for (const line of lines) {
		if (line.kind === "place") {
			// A line pointing at a topic the ledger never defined is ignored, not guessed at.
			if (!topics.has(line.topicId)) continue;
			byNode.set(line.nodeId, { topicId: line.topicId, aspect: line.aspect, source: line.source, confidence: line.confidence });
			cleared.delete(line.nodeId);
		} else if (line.kind === "clear") {
			byNode.delete(line.nodeId);
			cleared.add(line.nodeId);
		}
	}
	return { topics, byNode, cleared };
}

/** The payload view: only live nodes, only topics that hold one. */
export function placementView(lines: readonly PlacementLine[], liveNodeIds: Iterable<string>): PlacementView {
	const derived = derivePlacements(lines);
	const live = new Set(liveNodeIds);
	const byNode: Record<string, NodePlacement> = {};
	const used = new Set<string>();
	for (const [nodeId, p] of derived.byNode) {
		if (!live.has(nodeId)) continue;
		byNode[nodeId] = p;
		used.add(p.topicId);
	}
	const topics = [...used].map((id) => derived.topics.get(id)!).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
	let unplaced = 0;
	let withdrawn = 0;
	for (const id of live) {
		if (derived.byNode.has(id)) continue;
		if (derived.cleared.has(id)) withdrawn++;
		else unplaced++;
	}
	return { topics, byNode, unplaced, withdrawn };
}

/** Live nodes with no placement. `retryCleared` also returns the ones a revert withdrew. */
export function unplacedNodes<T extends { id: string }>(
	nodes: readonly T[],
	lines: readonly PlacementLine[],
	options: { retryCleared?: boolean } = {},
): T[] {
	const { byNode, cleared } = derivePlacements(lines);
	return nodes.filter((n) => !byNode.has(n.id) && (options.retryCleared === true || !cleared.has(n.id)));
}

// ─── applying a placer's answers ─────────────────────────────────────────────

/** One answer from the placer (or the fallback), for one node. */
export interface PlacerProposal {
	nodeId: string;
	/** Organ-system id or label; ignored when the topic already exists. */
	system?: string;
	/** An existing topic's id (preferred) — reuse. */
	topicId?: string;
	/** A topic name: matched to an existing topic if it means the same, else minted. */
	newTopic?: string;
	aspect?: string;
	confidence?: string;
}

export interface ApplyOptions {
	runId: string;
	now: string;
	source?: PlacementSource;
	/** Used when a proposal names a new topic but no usable system. */
	systemHint?: (nodeId: string) => OrganSystem | undefined;
	mintTopicId?: () => string;
	/** Also place nodes a revert withdrew. */
	retryCleared?: boolean;
}

export interface ApplyResult {
	/** The lines to append, in order (topic lines before the places that use them). */
	lines: PlacementLine[];
	placed: string[];
	topicsCreated: number;
	/** Nodes whose answer was unusable or missing — still unplaced. */
	unresolved: string[];
	/** Nodes skipped because they were placed meanwhile (a learner's placement is never overridden). */
	alreadyPlaced: string[];
}

export function applyPlacerProposals(
	existing: readonly PlacementLine[],
	proposals: readonly PlacerProposal[],
	options: ApplyOptions,
): ApplyResult {
	const mint = options.mintTopicId ?? newTopicId;
	const source = options.source ?? "placer";
	const derived = derivePlacements(existing);
	const topics = new Map(derived.topics);
	const lines: PlacementLine[] = [];
	const result: ApplyResult = { lines, placed: [], topicsCreated: 0, unresolved: [], alreadyPlaced: [] };
	const seen = new Set<string>();

	for (const p of proposals) {
		if (seen.has(p.nodeId)) continue; // the first answer for a node stands
		seen.add(p.nodeId);
		if (derived.byNode.has(p.nodeId) || (derived.cleared.has(p.nodeId) && options.retryCleared !== true)) {
			result.alreadyPlaced.push(p.nodeId);
			continue;
		}
		const system = sanitizeSystems([p.system])[0] ?? options.systemHint?.(p.nodeId);
		let topic = p.topicId ? topics.get(p.topicId.trim()) : undefined;
		if (!topic && p.newTopic !== undefined) {
			const name = cleanName(p.newTopic).slice(0, TOPIC_NAME_MAX).trim();
			if (name !== "") {
				topic = findTopic(topics.values(), name, system);
				if (!topic) {
					const minted: PlacementTopic = { id: mint(), name, system: system ?? "general" };
					topics.set(minted.id, minted);
					const line: TopicLine = { kind: "topic", id: minted.id, name, system: minted.system, createdAt: options.now, runId: options.runId };
					lines.push(line);
					result.topicsCreated++;
					topic = minted;
				}
			}
		}
		if (!topic) {
			result.unresolved.push(p.nodeId);
			continue;
		}
		const confidence: PlacementConfidence = p.confidence === "low" ? "low" : "high";
		const place: PlaceLine = {
			kind: "place",
			nodeId: p.nodeId,
			topicId: topic.id,
			aspect: sanitizePlacementAspect(p.aspect) ?? DEFAULT_ASPECT,
			source,
			confidence,
			at: options.now,
			runId: options.runId,
		};
		lines.push(place);
		result.placed.push(p.nodeId);
	}
	return result;
}

/** A node the placer could not place after repeated tries: park it, marked low
 *  confidence, in an "Unsorted" topic of its best-guess system. Never asks anyone. */
export function fallbackProposal(node: Pick<GraphNode, "id" | "systems">): PlacerProposal {
	const system: OrganSystem = node.systems?.[0] ?? "general";
	return {
		nodeId: node.id,
		system,
		newTopic: `Unsorted – ${systemLabelFor(system)}`,
		aspect: DEFAULT_ASPECT,
		confidence: "low",
	};
}

// ─── reverting a run ─────────────────────────────────────────────────────────

/**
 * The lines that put a placer run's effect back. Per node whose CURRENT
 * placement came from that run: restore the placement it had before (as a new
 * line), or withdraw it. A node the learner has since moved is left alone.
 * Append-only: nothing in the ledger is rewritten.
 */
export function revertRunLines(lines: readonly PlacementLine[], runId: string, now: string): PlacementLine[] {
	const events = new Map<string, Array<PlaceLine | { kind: "clear"; runId?: string }>>();
	for (const line of lines) {
		if (line.kind === "topic") continue;
		const list = events.get(line.nodeId) ?? [];
		list.push(line);
		events.set(line.nodeId, list);
	}
	const out: PlacementLine[] = [];
	for (const [nodeId, list] of events) {
		const latest = list[list.length - 1]!;
		if (latest.runId !== runId) continue;
		const before = [...list].reverse().find((e) => e.runId !== runId);
		if (before && before.kind === "place") {
			out.push({ ...before, at: now, runId: `revert_${runId}` });
		} else {
			out.push({ kind: "clear", nodeId, at: now, runId: `revert_${runId}` });
		}
	}
	return out;
}

// ─── display helpers ─────────────────────────────────────────────────────────

/** Systems in the fixed list order, each with its topics (by name) — the outline's spine. */
export function topicsBySystem(topics: readonly PlacementTopic[]): Array<{ system: OrganSystem; label: string; topics: PlacementTopic[] }> {
	return ORGAN_SYSTEMS.map((s) => ({
		system: s.id as OrganSystem,
		label: s.label,
		topics: topics.filter((t) => t.system === s.id).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
	})).filter((g) => g.topics.length > 0);
}

export type { PlacementAspect };
