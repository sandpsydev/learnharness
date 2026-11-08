/**
 * The knowledge-organizer's change engine (medical fork, docs/medical-spec.md
 * "Knowledge organizer"). Pure over the graph storage port — no model, no
 * network — so every rule below is testable without an agent.
 *
 * THREE JOBS
 *   planOrganizerChanges   check a proposed set against the current ledgers
 *                          and compute the resulting ledger lines plus the
 *                          before/after preview the learner reviews. All
 *                          problems are reported together; nothing is written.
 *   applyOrganizerChanges  re-plan against the CURRENT graph (it may have
 *                          changed since the proposal) and, only if the whole
 *                          set is valid, write it in one step and journal it.
 *   undoOrganizerEntry     put the newest applied set back exactly as it was,
 *                          or refuse with a reason when something else has
 *                          touched those lines since.
 *
 * INVARIANTS (the ones the existing graph code enforces, kept here)
 *   - ids are store-minted ("n_…" nodes, "arg_…" connections); the agent
 *     never invents one. A new node is referred to inside its own set by a
 *     short `ref`.
 *   - a connection is a reasoning chain: at least one premise, one
 *     conclusion, every endpoint an existing node, the conclusion never one
 *     of its own premises, no duplicate of an existing chain, and no cycle
 *     (the extractor never mints one either). A chain the graph's own
 *     simplification pass would drop as redundant is refused up front, so a
 *     later extraction run cannot silently undo the learner's connection.
 *   - tags come from the fixed vocabulary (contracts/graph.ts) — an unknown
 *     organ system or fact type is a rejection, never a silent drop.
 *   - a placement (organ system › topic › aspect) is moved with set_placement:
 *     the topic is reused when it already exists under that name (the
 *     canonical list is never duplicated), a new topic needs its organ system,
 *     and the aspect comes from the fixed illness-script list.
 *   - the set is ALL OR NOTHING: any problem rejects the whole set.
 *
 * HOW EDITS LAND IN THE LEDGERS
 *   - create: one new node line (no provenance: the learner's own node; the
 *     tags are marked learner-edited so extraction never overrides them).
 *   - rename / edit statement: the node's defining (first) line changes, the
 *     old statement is kept as an alias — the identity audit trail.
 *   - tags: an appended learner-edit tag line, exactly like the detail card.
 *   - connections: chain lines added, removed or replaced in place.
 *   - placements: lines appended to the placement ledger (a learner-sourced
 *     "place", plus a "topic" line when the set mints a topic); the journal's
 *     placement diff lets undo take exactly those lines back out.
 *   The two ledgers are rewritten atomically (store.rewriteLedgers); the
 *   journal stores the line-level diff, so undo restores the exact lines.
 */

import { randomBytes } from "node:crypto";
import type { GraphChain, GraphNode } from "./contracts.ts";
import {
	factTypeLabel,
	organSystemLabel,
	sanitizeFactType,
	sanitizeSystems,
	type FactType,
	type OrganSystem,
} from "./contracts/graph.ts";
import { chainKey, getGraph, newGraphChainId, newGraphNodeId, simplifyChains, tagFields, tagLine } from "./graph.ts";
import {
	PLACEMENT_ASPECTS,
	placementAspectLabel,
	placementPathText,
	sanitizePlacementAspect,
	type PlacementAspect,
	type PlacementLine,
	type TopicLine,
} from "./contracts/placement.ts";
import { TOPIC_NAME_MAX, derivePlacements, findTopic, newTopicId } from "./placement.ts";
import {
	ORGANIZER_MAX_CHANGES,
	ORGANIZER_MAX_PLACED,
	ORGANIZER_NAME_MAX,
	ORGANIZER_OPS,
	ORGANIZER_STATEMENT_MAX,
	type OrganizerChangePreview,
	type OrganizerHistoryEntry,
	type OrganizerHistoryItem,
	type OrganizerLineDiff,
	type OrganizerOp,
	type OrganizerPreviewRow,
	type RawOrganizerChange,
} from "./organizer-types.ts";
import type { GraphStore } from "./ports.ts";

/** The journal's storage port (src/store/organizer-history.ts). */
export interface OrganizerHistoryStore {
	read(): OrganizerHistoryEntry[];
	write(entries: OrganizerHistoryEntry[]): void;
}

/** The placement ledger as the organizer sees it: read, and replace (undo / apply write whole). */
export interface OrganizerPlacementPort {
	read(): PlacementLine[];
	rewrite(lines: readonly PlacementLine[]): void;
}

/** How many applied sets the journal keeps. */
export const ORGANIZER_HISTORY_LIMIT = 20;

const REF_RE = /^[A-Za-z][A-Za-z0-9_-]{0,30}$/;

// ─── plan ────────────────────────────────────────────────────────────────────

export type OrganizerPlan =
	| {
			ok: true;
			nodeLines: GraphNode[];
			chainLines: GraphChain[];
			/** The placement ledger after the set (the input unchanged when no change touches placement). */
			placementLines: PlacementLine[];
			previews: OrganizerChangePreview[];
			createdNodeIds: string[];
	  }
	| { ok: false; problems: string[] };

export interface PlanOptions {
	now?: string;
	/** The placement ledger as it is now. Absent = placement is not available (set_placement is refused). */
	placementLines?: readonly PlacementLine[];
	/** Test seam: deterministic topic ids. */
	newTopicId?: () => string;
	/** Test seams: deterministic ids. */
	newNodeId?: () => string;
	newChainId?: () => string;
}

const norm = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim();
const describeOp = (op: string): string => op.replace(/_/g, " ");
const quote = (text: string): string => `“${text}”`;

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : undefined;
}

/**
 * Check a raw (model- or client-supplied) value is a list of changes and
 * return it typed, or say what is wrong. Field-level rules live in the plan.
 */
export function parseOrganizerChanges(raw: unknown): { changes: RawOrganizerChange[] } | { problems: string[] } {
	if (!Array.isArray(raw)) return { problems: ["changes must be a list."] };
	if (raw.length === 0) return { problems: ["changes is empty — propose at least one change."] };
	if (raw.length > ORGANIZER_MAX_CHANGES) {
		return { problems: [`Too many changes (${raw.length}) — send at most ${ORGANIZER_MAX_CHANGES} per proposal.`] };
	}
	const problems: string[] = [];
	const changes: RawOrganizerChange[] = [];
	raw.forEach((item, i) => {
		const at = `Change ${i + 1}`;
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			problems.push(`${at}: must be an object with an "op".`);
			return;
		}
		const r = item as Record<string, unknown>;
		const op = asString(r.op);
		if (op === undefined || !(ORGANIZER_OPS as readonly string[]).includes(op)) {
			problems.push(`${at}: unknown op ${JSON.stringify(r.op)} — use one of ${ORGANIZER_OPS.join(", ")}.`);
			return;
		}
		const change: RawOrganizerChange = { op };
		for (const key of ["ref", "name", "statement", "factType", "nodeId", "chainId", "conclusion", "topic", "system", "aspect"] as const) {
			if (r[key] === undefined || r[key] === null) continue;
			const value = asString(r[key]);
			if (value === undefined) problems.push(`${at} (${describeOp(op)}): ${key} must be text.`);
			else change[key] = value;
		}
		for (const key of ["systems", "premises", "nodeIds"] as const) {
			if (r[key] === undefined || r[key] === null) continue;
			const value = asStringArray(r[key]);
			if (value === undefined) problems.push(`${at} (${describeOp(op)}): ${key} must be a list of text.`);
			else change[key] = value;
		}
		changes.push(change);
	});
	return problems.length > 0 ? { problems } : { changes };
}

/** "A + B ⟹ C" for a connection, by node names. */
function connectionText(nameOf: (id: string) => string, premises: readonly string[], conclusion: string): string {
	return `${premises.map(nameOf).join(" + ")} ⟹ ${nameOf(conclusion)}`;
}

const systemsText = (systems: readonly OrganSystem[] | undefined): string =>
	systems && systems.length > 0 ? systems.map(organSystemLabel).join(", ") : "none";
const factTypeText = (factType: FactType | undefined): string => (factType ? factTypeLabel(factType) : "none");

/**
 * Check a proposed set against the ledgers. Pure: reads the lines it is
 * given, returns new line arrays (the inputs are not mutated) or the full
 * list of problems.
 */
export function planOrganizerChanges(
	currentNodeLines: readonly GraphNode[],
	currentChainLines: readonly GraphChain[],
	changes: readonly RawOrganizerChange[],
	options: PlanOptions = {},
): OrganizerPlan {
	const now = options.now ?? new Date().toISOString();
	const mintNode = options.newNodeId ?? newGraphNodeId;
	const mintChain = options.newChainId ?? newGraphChainId;

	if (changes.length === 0) return { ok: false, problems: ["changes is empty — propose at least one change."] };
	if (changes.length > ORGANIZER_MAX_CHANGES) {
		return { ok: false, problems: [`Too many changes (${changes.length}) — at most ${ORGANIZER_MAX_CHANGES} per proposal.`] };
	}

	// Working copies — shallow-cloned lines, because edits replace fields.
	const nodeLines: GraphNode[] = currentNodeLines.map((l) => ({ ...l, aliases: [...l.aliases], provenance: [...l.provenance] }));
	let chainLines: GraphChain[] = currentChainLines.map((l) => ({ ...l, premises: [...l.premises], provenance: [...l.provenance] }));
	const placementAvailable = options.placementLines !== undefined;
	const placementLines: PlacementLine[] = [...(options.placementLines ?? [])];
	const mintTopic = options.newTopicId ?? newTopicId;

	let cache: ReturnType<typeof getGraph> | null = null;
	const graph = () => (cache ??= getGraph({ readNodes: () => nodeLines, readChains: () => chainLines }));
	const touch = () => {
		cache = null;
	};
	const nodeById = (id: string): GraphNode | undefined => graph().nodes.find((n) => n.id === id);
	const nameOf = (id: string): string => nodeById(id)?.name ?? id;

	// New-node refs: minted up front, usable only AFTER their create_node ran.
	const refIds = new Map<string, string>();
	const problems: string[] = [];
	changes.forEach((c, i) => {
		if (c.op !== "create_node") return;
		const ref = c.ref?.trim();
		if (!ref) return; // reported by the create itself
		if (!REF_RE.test(ref) || /^(n_|arg_)/.test(ref)) {
			problems.push(`Change ${i + 1} (create node): ref ${quote(ref)} must be a short word like "new1" (letters, digits, - or _; not starting n_ or arg_).`);
			return;
		}
		if (refIds.has(ref)) {
			problems.push(`Change ${i + 1} (create node): ref ${quote(ref)} is used twice.`);
			return;
		}
		refIds.set(ref, mintNode());
	});

	const created = new Set<string>(); // refs whose create_node already ran
	const createdNodeIds: string[] = [];
	const previews: OrganizerChangePreview[] = [];

	/** An existing node id, or the ref of a node created earlier in the set. */
	const resolveNode = (at: string, what: string, value: unknown): string | undefined => {
		const text = typeof value === "string" ? value.trim() : "";
		if (text === "") {
			problems.push(`${at}: ${what} is missing.`);
			return undefined;
		}
		if (refIds.has(text)) {
			if (!created.has(text)) {
				problems.push(`${at}: ${what} ${quote(text)} is a new node created later in the set — put its create_node first.`);
				return undefined;
			}
			return refIds.get(text);
		}
		if (text.startsWith("arg_")) {
			problems.push(`${at}: ${what} ${quote(text)} is a connection id, not a node id.`);
			return undefined;
		}
		if (!nodeById(text)) {
			problems.push(`${at}: ${what} ${quote(text)} is not a node in the graph.`);
			return undefined;
		}
		return text;
	};

	const checkName = (at: string, value: unknown): string | undefined => {
		const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
		if (name === "") {
			problems.push(`${at}: name is missing.`);
			return undefined;
		}
		if (name.length > ORGANIZER_NAME_MAX) {
			problems.push(`${at}: name is too long (${name.length} characters; at most ${ORGANIZER_NAME_MAX}) — a name is a short handle.`);
			return undefined;
		}
		return name;
	};

	const checkStatement = (at: string, value: unknown, exceptId?: string): string | undefined => {
		const statement = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
		if (statement === "") {
			problems.push(`${at}: statement is missing.`);
			return undefined;
		}
		if (statement.length > ORGANIZER_STATEMENT_MAX) {
			problems.push(`${at}: statement is too long (${statement.length} characters; at most ${ORGANIZER_STATEMENT_MAX}).`);
			return undefined;
		}
		const same = graph().nodes.find((n) => n.id !== exceptId && [n.statement, ...n.aliases].some((s) => norm(s) === norm(statement)));
		if (same) {
			problems.push(`${at}: the graph already has this statement on node ${same.id} ${quote(same.name)} — change that node instead of duplicating it.`);
			return undefined;
		}
		return statement;
	};

	/** Tag values from the fixed vocabulary only. `none` clears the fact type. */
	const checkTags = (
		at: string,
		change: RawOrganizerChange,
		allowClear: boolean,
	): { systems?: OrganSystem[]; factType?: FactType | null } | undefined => {
		const out: { systems?: OrganSystem[]; factType?: FactType | null } = {};
		let bad = false;
		if (change.systems !== undefined) {
			const known = sanitizeSystems(change.systems);
			const unknown = change.systems.filter((s) => sanitizeSystems([s]).length === 0);
			if (unknown.length > 0) {
				problems.push(`${at}: unknown organ system ${unknown.map(quote).join(", ")} — use only the existing systems.`);
				bad = true;
			} else out.systems = known;
		}
		if (change.factType !== undefined) {
			if (allowClear && change.factType.trim().toLowerCase() === "none") out.factType = null;
			else {
				const factType = sanitizeFactType(change.factType);
				if (factType === undefined) {
					problems.push(`${at}: unknown fact type ${quote(change.factType)} — use only the existing fact types.`);
					bad = true;
				} else out.factType = factType;
			}
		}
		return bad ? undefined : out;
	};

	const firstLineIndex = (id: string): number => nodeLines.findIndex((l) => l.id === id);

	const edgesOf = (lines: readonly GraphChain[]): Map<string, Set<string>> => {
		const edges = new Map<string, Set<string>>();
		for (const line of lines) {
			for (const p of line.premises) {
				const to = edges.get(p) ?? new Set<string>();
				to.add(line.conclusion);
				edges.set(p, to);
			}
		}
		return edges;
	};

	/** Shared checks for a connection's endpoints against `lines` (the chain
	 *  lines WITHOUT the one being added/replaced). Returns the cleaned
	 *  premises/conclusion, or undefined after recording problems. */
	const checkConnection = (
		at: string,
		premisesRaw: readonly string[] | undefined,
		conclusionRaw: string | undefined,
		lines: readonly GraphChain[],
		newLineId: string,
	): { premises: string[]; conclusion: string } | undefined => {
		const before = problems.length;
		if (!premisesRaw || premisesRaw.length === 0) problems.push(`${at}: premises is missing — a connection needs at least one premise.`);
		const premises: string[] = [];
		for (const raw of premisesRaw ?? []) {
			const id = resolveNode(at, "premise", raw);
			if (id !== undefined && !premises.includes(id)) premises.push(id);
		}
		const conclusion = resolveNode(at, "conclusion", conclusionRaw);
		if (problems.length > before || conclusion === undefined) return undefined;
		if (premises.includes(conclusion)) {
			problems.push(`${at}: ${quote(nameOf(conclusion))} cannot be a premise of its own conclusion.`);
			return undefined;
		}
		const key = chainKey(premises, conclusion);
		const dup = lines.find((l) => chainKey(l.premises, l.conclusion) === key);
		if (dup) {
			problems.push(`${at}: this connection already exists (${dup.id}).`);
			return undefined;
		}
		// Cycle: the conclusion must not already lead (through existing
		// chains) back to one of the premises.
		const edges = edgesOf(lines);
		const seen = new Set<string>();
		const stack = [conclusion];
		while (stack.length > 0) {
			const cur = stack.pop()!;
			if (seen.has(cur)) continue;
			seen.add(cur);
			if (premises.includes(cur)) {
				problems.push(`${at}: this would create a loop — ${quote(nameOf(conclusion))} already leads back to ${quote(nameOf(cur))}.`);
				return undefined;
			}
			for (const next of edges.get(cur) ?? []) stack.push(next);
		}
		// Redundancy: the graph's own simplification would drop this chain.
		const probe: GraphChain = { id: newLineId, premises, conclusion, provenance: [], createdAt: now };
		if (!simplifyChains([...lines, probe]).some((l) => l.id === newLineId)) {
			problems.push(`${at}: ${connectionText(nameOf, premises, conclusion)} is already implied by other connections, so the graph would drop it as redundant.`);
			return undefined;
		}
		return { premises, conclusion };
	};

	changes.forEach((change, i) => {
		const at = `Change ${i + 1} (${describeOp(change.op)})`;
		const op = change.op as OrganizerOp;
		const rows: OrganizerPreviewRow[] = [];

		switch (op) {
			case "create_node": {
				const ref = change.ref?.trim();
				if (!ref) {
					problems.push(`${at}: ref is missing — give the new node a short ref like "new1" so other changes can point at it.`);
					return;
				}
				const id = refIds.get(ref);
				const name = checkName(at, change.name);
				const statement = checkStatement(at, change.statement);
				const tags = checkTags(at, change, false);
				if (id === undefined || name === undefined || statement === undefined || tags === undefined) return;
				const fields = tagFields({ systems: tags.systems, factType: tags.factType });
				const hasTags = Object.keys(fields).length > 0;
				nodeLines.push({
					id,
					name,
					statement,
					aliases: [],
					createdAt: now,
					provenance: [],
					...fields,
					...(hasTags ? { tagsEdited: true } : {}),
				});
				touch();
				created.add(ref);
				createdNodeIds.push(id);
				rows.push({ field: "Name", after: name }, { field: "Statement", after: statement });
				if (fields.systems) rows.push({ field: "Organ system", after: systemsText(fields.systems) });
				if (fields.factType) rows.push({ field: "Fact type", after: factTypeText(fields.factType) });
				previews.push({ op, title: `Create node ${quote(name)}`, rows });
				return;
			}
			case "rename_node": {
				const id = resolveNode(at, "nodeId", change.nodeId);
				const name = checkName(at, change.name);
				if (id === undefined || name === undefined) return;
				const node = nodeById(id)!;
				if (node.name === name) {
					problems.push(`${at}: ${quote(node.name)} already has that name.`);
					return;
				}
				nodeLines[firstLineIndex(id)]!.name = name;
				touch();
				previews.push({ op, title: `Rename ${quote(node.name)} → ${quote(name)}`, rows: [{ field: "Name", before: node.name, after: name }] });
				return;
			}
			case "edit_node": {
				const id = resolveNode(at, "nodeId", change.nodeId);
				if (id === undefined) return;
				const statement = checkStatement(at, change.statement, id);
				if (statement === undefined) return;
				const node = nodeById(id)!;
				if (norm(node.statement) === norm(statement)) {
					problems.push(`${at}: the statement of ${quote(node.name)} is already that.`);
					return;
				}
				const line = nodeLines[firstLineIndex(id)]!;
				// The old statement stays as a phrasing — the node's identity trail.
				if (line.statement.length > 0 && !line.aliases.includes(line.statement)) line.aliases.push(line.statement);
				line.statement = statement;
				touch();
				previews.push({
					op,
					title: `Edit the statement of ${quote(node.name)}`,
					rows: [{ field: "Statement", before: node.statement, after: statement }],
				});
				return;
			}
			case "set_tags": {
				const id = resolveNode(at, "nodeId", change.nodeId);
				if (change.systems === undefined && change.factType === undefined) {
					problems.push(`${at}: give systems and/or factType (systems [] or factType "none" clears).`);
					return;
				}
				const tags = checkTags(at, change, true);
				if (id === undefined || tags === undefined) return;
				const node = nodeById(id)!;
				const nextSystems = tags.systems !== undefined ? tags.systems : node.systems;
				const nextFactType = tags.factType === undefined ? node.factType : (tags.factType ?? undefined);
				const next = tagFields({ systems: nextSystems, factType: nextFactType });
				const sameSystems = systemsText(next.systems) === systemsText(node.systems);
				const sameType = next.factType === node.factType;
				if (sameSystems && sameType) {
					problems.push(`${at}: ${quote(node.name)} already has those tags.`);
					return;
				}
				nodeLines.push(tagLine(node, next, true));
				touch();
				if (!sameSystems) rows.push({ field: "Organ system", before: systemsText(node.systems), after: systemsText(next.systems) });
				if (!sameType) rows.push({ field: "Fact type", before: factTypeText(node.factType), after: factTypeText(next.factType) });
				previews.push({ op, title: `Change the tags of ${quote(node.name)}`, rows });
				return;
			}
			case "set_placement": {
				if (!placementAvailable) {
					problems.push(`${at}: placement is not available here.`);
					return;
				}
				const rawIds = change.nodeIds ?? [];
				const before = problems.length;
				if (rawIds.length === 0) problems.push(`${at}: nodeIds is missing — list the facts to move.`);
				else if (rawIds.length > ORGANIZER_MAX_PLACED) {
					problems.push(`${at}: too many facts (${rawIds.length}) — move at most ${ORGANIZER_MAX_PLACED} per change.`);
				}
				const ids: string[] = [];
				if (rawIds.length <= ORGANIZER_MAX_PLACED) {
					for (const raw of rawIds) {
						const id = resolveNode(at, "node", raw);
						if (id !== undefined && !ids.includes(id)) ids.push(id);
					}
				}
				const topicText = change.topic?.replace(/\s+/g, " ").trim() ?? "";
				if (topicText === "") problems.push(`${at}: topic is missing — name the disease or subject to move the facts under.`);
				let system: OrganSystem | undefined;
				if (change.system !== undefined) {
					system = sanitizeSystems([change.system])[0];
					if (system === undefined) problems.push(`${at}: unknown organ system ${quote(change.system)} — use only the existing systems.`);
				}
				let aspect: PlacementAspect | undefined;
				if (change.aspect !== undefined) {
					aspect = sanitizePlacementAspect(change.aspect);
					if (aspect === undefined) {
						problems.push(`${at}: unknown aspect ${quote(change.aspect)} — use one of ${PLACEMENT_ASPECTS.map((a) => a.id).join(", ")}.`);
					}
				}
				if (problems.length > before) return;

				const derived = derivePlacements(placementLines);
				let topic = findTopic(derived.topics.values(), topicText, system);
				let minted: TopicLine | undefined;
				if (topic) {
					if (system !== undefined && topic.system !== system) {
						problems.push(
							`${at}: the topic ${quote(topic.name)} lives under ${organSystemLabel(topic.system)}, not ${organSystemLabel(system)} — name that system, or choose a different topic.`,
						);
						return;
					}
				} else {
					if (/^t_[0-9a-f]+$/.test(topicText)) {
						problems.push(`${at}: ${quote(topicText)} is not a topic in the outline — give the topic's name instead.`);
						return;
					}
					if (system === undefined) {
						problems.push(`${at}: ${quote(topicText)} is a new topic — say which organ system it belongs under.`);
						return;
					}
					if (topicText.length > TOPIC_NAME_MAX) {
						problems.push(`${at}: the topic name is too long (${topicText.length} characters; at most ${TOPIC_NAME_MAX}).`);
						return;
					}
					minted = { kind: "topic", id: mintTopic(), name: topicText, system, createdAt: now };
					topic = { id: minted.id, name: minted.name, system: minted.system };
				}

				const moved: PlacementLine[] = [];
				for (const id of ids) {
					const current = derived.byNode.get(id);
					const target = aspect ?? current?.aspect ?? "other";
					if (current && current.topicId === topic.id && current.aspect === target) continue;
					moved.push({ kind: "place", nodeId: id, topicId: topic.id, aspect: target, source: "learner", confidence: "high", at: now });
					const was = current ? placementPathText(derived.topics.get(current.topicId), current.aspect) : "Not placed yet";
					rows.push({ field: nameOf(id), before: was, after: placementPathText(topic, target) });
				}
				if (moved.length === 0) {
					problems.push(`${at}: ${ids.length === 1 ? "that fact is" : "those facts are"} already there.`);
					return;
				}
				if (minted) placementLines.push(minted);
				placementLines.push(...moved);
				const where = placementPathText(topic, aspect);
				previews.push({
					op,
					title: `Move ${moved.length} ${moved.length === 1 ? "fact" : "facts"} to ${where}${aspect === undefined ? " (each keeps its aspect)" : ""}`,
					rows,
				});
				return;
			}
			case "add_connection": {
				const newId = mintChain();
				const ok = checkConnection(at, change.premises, change.conclusion, chainLines, newId);
				if (!ok) return;
				chainLines.push({ id: newId, premises: ok.premises, conclusion: ok.conclusion, provenance: [], createdAt: now });
				touch();
				const text = connectionText(nameOf, ok.premises, ok.conclusion);
				previews.push({ op, title: `Add connection ${text}`, rows: [{ field: "Connection", after: text }] });
				return;
			}
			case "remove_connection": {
				const chainId = change.chainId?.trim() ?? "";
				const chain = graph().chains.find((c) => c.id === chainId);
				if (!chain) {
					problems.push(`${at}: ${chainId === "" ? "chainId is missing" : `${quote(chainId)} is not a connection in the graph`}.`);
					return;
				}
				const key = chainKey(chain.premises, chain.conclusion);
				const text = connectionText(nameOf, chain.premises, chain.conclusion);
				chainLines = chainLines.filter((l) => chainKey(l.premises, l.conclusion) !== key);
				touch();
				previews.push({ op, title: `Remove connection ${text}`, rows: [{ field: "Connection", before: text }] });
				return;
			}
			case "change_connection": {
				const chainId = change.chainId?.trim() ?? "";
				const chain = graph().chains.find((c) => c.id === chainId);
				if (!chain) {
					problems.push(`${at}: ${chainId === "" ? "chainId is missing" : `${quote(chainId)} is not a connection in the graph`}.`);
					return;
				}
				if (change.premises === undefined && change.conclusion === undefined) {
					problems.push(`${at}: give the new premises and/or conclusion.`);
					return;
				}
				const oldKey = chainKey(chain.premises, chain.conclusion);
				const others = chainLines.filter((l) => chainKey(l.premises, l.conclusion) !== oldKey);
				const ok = checkConnection(
					at,
					change.premises ?? chain.premises,
					change.conclusion ?? chain.conclusion,
					others,
					chain.id,
				);
				if (!ok) return;
				if (chainKey(ok.premises, ok.conclusion) === oldKey) {
					problems.push(`${at}: the connection already is ${connectionText(nameOf, chain.premises, chain.conclusion)}.`);
					return;
				}
				const before = connectionText(nameOf, chain.premises, chain.conclusion);
				const after = connectionText(nameOf, ok.premises, ok.conclusion);
				// Replace in place: the first line of the old chain becomes the
				// new one (same id, provenance unioned); its duplicates go.
				const at0 = chainLines.findIndex((l) => chainKey(l.premises, l.conclusion) === oldKey);
				const replacement: GraphChain = { ...chain, premises: ok.premises, conclusion: ok.conclusion };
				chainLines = chainLines.flatMap((l, idx) =>
					idx === at0 ? [replacement] : chainKey(l.premises, l.conclusion) === oldKey ? [] : [l],
				);
				touch();
				previews.push({ op, title: `Change connection ${before} → ${after}`, rows: [{ field: "Connection", before, after }] });
				return;
			}
		}
	});

	if (problems.length > 0) return { ok: false, problems };
	return { ok: true, nodeLines, chainLines, placementLines, previews, createdNodeIds };
}

// ─── apply / undo ────────────────────────────────────────────────────────────

/** Chain ids whose endpoints are not nodes. A change must not ADD to this
 *  set (older data may already hold some; those are not our business). */
function danglingChainIds(nodeLines: readonly GraphNode[], chainLines: readonly GraphChain[]): Set<string> {
	const ids = new Set(nodeLines.map((n) => n.id));
	return new Set(
		chainLines.filter((c) => !ids.has(c.conclusion) || c.premises.some((p) => !ids.has(p))).map((c) => c.id),
	);
}

const lineText = (record: unknown): string => JSON.stringify(record);

/** The multiset difference between two ledgers, as exact line text. */
function diffLines(before: readonly unknown[], after: readonly unknown[]): OrganizerLineDiff {
	const beforeText = before.map(lineText);
	const afterText = after.map(lineText);
	const afterCount = new Map<string, number>();
	for (const t of afterText) afterCount.set(t, (afterCount.get(t) ?? 0) + 1);
	const removed: OrganizerLineDiff["removed"] = [];
	beforeText.forEach((t, index) => {
		const n = afterCount.get(t) ?? 0;
		if (n > 0) afterCount.set(t, n - 1);
		else removed.push({ index, line: t });
	});
	const beforeCount = new Map<string, number>();
	for (const t of beforeText) beforeCount.set(t, (beforeCount.get(t) ?? 0) + 1);
	const added: string[] = [];
	for (const t of afterText) {
		const n = beforeCount.get(t) ?? 0;
		if (n > 0) beforeCount.set(t, n - 1);
		else added.push(t);
	}
	return { removed, added };
}

const isEmptyDiff = (d: OrganizerLineDiff): boolean => d.removed.length === 0 && d.added.length === 0;

/** Undo one ledger's diff on top of the current lines; null when an added
 *  line is no longer there (something else changed it since). */
function revertDiff(currentLines: readonly unknown[], diff: OrganizerLineDiff): string[] | null {
	const lines = currentLines.map(lineText);
	for (const added of diff.added) {
		const at = lines.indexOf(added);
		if (at === -1) return null;
		lines.splice(at, 1);
	}
	for (const { index, line } of [...diff.removed].sort((a, b) => a.index - b.index)) {
		lines.splice(Math.min(index, lines.length), 0, line);
	}
	return lines;
}

export type OrganizerApplyResult =
	| { ok: true; entry: OrganizerHistoryEntry }
	| { ok: false; problems: string[] };

export interface OrganizerDeps {
	graphStore: GraphStore;
	history: OrganizerHistoryStore;
	/** The placement ledger. Absent = set_placement is unavailable (and undo has nothing to take back). */
	placements?: OrganizerPlacementPort;
}

/**
 * Apply an accepted set. Re-plans against the graph as it is NOW and writes
 * only if the whole set is valid. Synchronous end to end (no awaits) so
 * nothing interleaves between the check and the write.
 */
export function applyOrganizerChanges(
	deps: OrganizerDeps,
	input: { summary: string; changes: readonly RawOrganizerChange[] },
	options: PlanOptions & { entryId?: string } = {},
): OrganizerApplyResult {
	const { graphStore, history, placements } = deps;
	const nodesBefore = graphStore.readNodes();
	const chainsBefore = graphStore.readChains();
	const placementsBefore = placements?.read();
	const plan = planOrganizerChanges(nodesBefore, chainsBefore, input.changes, {
		...options,
		...(placementsBefore ? { placementLines: placementsBefore } : {}),
	});
	if (!plan.ok) return plan;

	const dangling = danglingChainIds(nodesBefore, chainsBefore);
	const fresh = [...danglingChainIds(plan.nodeLines, plan.chainLines)].filter((id) => !dangling.has(id));
	if (fresh.length > 0) {
		return { ok: false, problems: [`The change would leave connection ${fresh.join(", ")} without one of its nodes.`] };
	}

	const nodes = diffLines(nodesBefore, plan.nodeLines);
	const chains = diffLines(chainsBefore, plan.chainLines);
	const placementDiff = diffLines(placementsBefore ?? [], plan.placementLines);
	if (isEmptyDiff(nodes) && isEmptyDiff(chains) && isEmptyDiff(placementDiff)) {
		return { ok: false, problems: ["Nothing would change."] };
	}
	if (!isEmptyDiff(nodes) || !isEmptyDiff(chains)) {
		graphStore.rewriteLedgers({
			...(isEmptyDiff(nodes) ? {} : { nodes: plan.nodeLines }),
			...(isEmptyDiff(chains) ? {} : { chains: plan.chainLines }),
		});
	}
	if (placements && !isEmptyDiff(placementDiff)) placements.rewrite(plan.placementLines);

	const entry: OrganizerHistoryEntry = {
		id: options.entryId ?? `org_${randomBytes(6).toString("hex")}`,
		appliedAt: options.now ?? new Date().toISOString(),
		summary: input.summary,
		previews: plan.previews,
		nodes,
		chains,
		...(isEmptyDiff(placementDiff) ? {} : { placements: placementDiff }),
		createdNodeIds: plan.createdNodeIds,
	};
	history.write([...history.read(), entry].slice(-ORGANIZER_HISTORY_LIMIT));
	return { ok: true, entry };
}

export type OrganizerUndoResult =
	| { ok: true; entry: OrganizerHistoryEntry }
	| { ok: false; code: "not_found" | "already_undone" | "not_latest" | "conflict"; reason: string };

/** The newest applied set that is not undone yet. */
function latestLive(entries: readonly OrganizerHistoryEntry[]): OrganizerHistoryEntry | undefined {
	return [...entries].reverse().find((e) => e.undoneAt === undefined);
}

/**
 * Undo the newest applied set: remove the lines it added, put back the lines
 * it removed where they were. Refuses — changing nothing — when the lines it
 * added are no longer all there, when anything else now refers to a node it
 * created, or when putting the old lines back would orphan a connection.
 */
export function undoOrganizerEntry(deps: OrganizerDeps, entryId: string, options: { now?: string } = {}): OrganizerUndoResult {
	const { graphStore, history, placements } = deps;
	const entries = history.read();
	const entry = entries.find((e) => e.id === entryId);
	if (!entry) return { ok: false, code: "not_found", reason: "No such change set." };
	if (entry.undoneAt !== undefined) return { ok: false, code: "already_undone", reason: "That change set was already undone." };
	if (latestLive(entries)?.id !== entryId) {
		return { ok: false, code: "not_latest", reason: "Only the most recent change set can be undone — undo the later one first." };
	}
	const conflict = (reason: string): OrganizerUndoResult => ({ ok: false, code: "conflict", reason });
	const stale = "The graph has changed since — those lines were edited, so this can't be undone cleanly.";

	const nodesNow = graphStore.readNodes();
	const chainsNow = graphStore.readChains();
	const nodeText = revertDiff(nodesNow, entry.nodes);
	const chainText = revertDiff(chainsNow, entry.chains);
	if (nodeText === null || chainText === null) return conflict(stale);
	const placementsDiff = entry.placements;
	const placementText = placementsDiff && !isEmptyDiff(placementsDiff) ? revertDiff(placements?.read() ?? [], placementsDiff) : undefined;
	if (placementText === null) return conflict(stale);
	if (placementsDiff && !isEmptyDiff(placementsDiff) && !placements) return conflict(stale);

	let nodeLines: GraphNode[];
	let chainLines: GraphChain[];
	let placementLines: PlacementLine[] | undefined;
	try {
		nodeLines = nodeText.map((t) => JSON.parse(t) as GraphNode);
		chainLines = chainText.map((t) => JSON.parse(t) as GraphChain);
		placementLines = placementText?.map((t) => JSON.parse(t) as PlacementLine);
	} catch {
		return conflict(stale);
	}
	const created = new Set(entry.createdNodeIds);
	if (nodeLines.some((l) => created.has(l.id)) || chainLines.some((c) => created.has(c.conclusion) || c.premises.some((p) => created.has(p)))) {
		return conflict("Something else now uses a node this change set created, so it can't be undone cleanly.");
	}
	const dangling = danglingChainIds(nodesNow, chainsNow);
	const fresh = [...danglingChainIds(nodeLines, chainLines)].filter((id) => !dangling.has(id));
	if (fresh.length > 0) return conflict("Undoing would leave a connection without one of its nodes (a node was deleted since).");

	if (!isEmptyDiff(entry.nodes) || !isEmptyDiff(entry.chains)) {
		graphStore.rewriteLedgers({
			...(isEmptyDiff(entry.nodes) ? {} : { nodes: nodeLines }),
			...(isEmptyDiff(entry.chains) ? {} : { chains: chainLines }),
		});
	}
	if (placements && placementLines) placements.rewrite(placementLines);
	const undone: OrganizerHistoryEntry = { ...entry, undoneAt: options.now ?? new Date().toISOString() };
	history.write(entries.map((e) => (e.id === entryId ? undone : e)));
	return { ok: true, entry: undone };
}

/** The history list for the page (newest first). */
export function organizerHistoryItems(entries: readonly OrganizerHistoryEntry[]): OrganizerHistoryItem[] {
	const latestId = latestLive(entries)?.id;
	return [...entries].reverse().map((e) => ({
		id: e.id,
		appliedAt: e.appliedAt,
		summary: e.summary,
		changeCount: e.previews.length,
		undone: e.undoneAt !== undefined,
		canUndo: e.id === latestId,
	}));
}
