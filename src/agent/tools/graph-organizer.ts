import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { invalidInputResult, serverExecute, toToolResult } from "../tool-execute.ts";
import { FACT_TYPES, ORGAN_SYSTEMS, factTypeLabel, isUntagged, organSystemLabel, sanitizeFactType, sanitizeSystems } from "../../core/contracts/graph.ts";
import type { GraphNode } from "../../core/contracts.ts";
import { getGraph } from "../../core/graph.ts";
import { parseOrganizerChanges, planOrganizerChanges } from "../../core/graph-organizer.ts";
import { ORGANIZER_MAX_CHANGES, type OrganizerChangePreview, type RawOrganizerChange } from "../../core/organizer-types.ts";
import { PLACEMENT_ASPECTS, placementAspectLabel, placementPathText } from "../../core/contracts/placement.ts";
import { derivePlacements, findTopic, topicsBySystem } from "../../core/placement.ts";
import type { GraphStore, PlacementStore } from "../../core/ports.ts";
import { globMatch } from "./graph.ts";

/**
 * THE KNOWLEDGE-ORGANIZER'S TOOLS (medical fork). Four read tools let it look
 * at the learner's graph; one write-shaped tool, propose_changes, hands a
 * SET of changes to the learner for review. propose_changes never touches
 * the ledgers: it checks the set against the current graph (the same check
 * the apply step repeats) and, if valid, records it as a pending proposal.
 * Nothing changes until the learner accepts (server/graph-organizer.ts).
 *
 * Delete and merge are deliberately not offered.
 */

export interface OrganizerToolContext {
	graphStore: GraphStore;
	/** The placement ledger (read). Absent = the placement tools say it is unavailable. */
	placements?: Pick<PlacementStore, "read">;
	/** Called once with a VALID proposal; the host stores it for review. */
	onProposal: (proposal: { summary: string; changes: RawOrganizerChange[]; previews: OrganizerChangePreview[] }) => void;
}

const STATEMENT_PREVIEW = 220;

function tagText(node: GraphNode): string {
	const systems = (node.systems ?? []).map(organSystemLabel).join(", ");
	const type = node.factType ? factTypeLabel(node.factType) : "";
	if (!systems && !type) return "untagged";
	return `${systems || "no system"} | ${type || "no fact type"}`;
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

type PlaceText = (nodeId: string) => string;

const nodeLine = (node: GraphNode, full = false, placeText?: PlaceText): string =>
	`- ${node.id} :: ${node.name} [${tagText(node)}]${placeText ? ` {${placeText(node.id)}}` : ""}\n  ${full ? node.statement : clip(node.statement, STATEMENT_PREVIEW)}`;

const findInput = Type.Object({
	query: Type.String({
		minLength: 1,
		description: "Glob over node names, statements and aliases — e.g. *nephro*. A bare term gets implicit surrounding *.",
	}),
});

const listInput = Type.Object({
	system: Type.Optional(Type.String({ description: "Only nodes carrying this organ-system id (e.g. renal)." })),
	factType: Type.Optional(Type.String({ description: "Only nodes with this fact-type id (e.g. management)." })),
	untagged: Type.Optional(Type.Boolean({ description: "Only nodes missing an organ system or a fact type." })),
	topic: Type.Optional(Type.String({ description: "Only nodes placed under this topic (name or t_… id from get_outline)." })),
	offset: Type.Optional(Type.Integer({ minimum: 0, description: "Skip this many (for paging). Default 0." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "How many to return. Default 40, at most 100." })),
});

const outlineInput = Type.Object({
	topic: Type.Optional(Type.String({ description: "A topic's name or t_… id — show that topic's facts by aspect. Omit for the whole outline." })),
});

const getInput = Type.Object({
	nodeId: Type.String({ minLength: 1, description: 'A node id exactly as listed ("n_…").' }),
});

const changeSchema = Type.Object({
	op: Type.String({
		description:
			'One of "create_node", "rename_node", "edit_node", "set_tags", "add_connection", "remove_connection", "change_connection", "set_placement".',
	}),
	ref: Type.Optional(Type.String({ description: 'create_node: a short handle for the new node, e.g. "new1". Other changes in this set refer to the node by it.' })),
	name: Type.Optional(Type.String({ description: "create_node / rename_node: the node's short name." })),
	statement: Type.Optional(Type.String({ description: "create_node / edit_node: the node's one-sentence statement." })),
	systems: Type.Optional(
		Type.Array(Type.String(), { description: "create_node / set_tags: organ-system ids. set_tags with [] clears them." }),
	),
	factType: Type.Optional(Type.String({ description: 'create_node / set_tags: a fact-type id. set_tags with "none" clears it.' })),
	nodeId: Type.Optional(Type.String({ description: "rename_node / edit_node / set_tags: the existing node's id." })),
	chainId: Type.Optional(Type.String({ description: 'remove_connection / change_connection: the connection id ("arg_…") from get_node.' })),
	premises: Type.Optional(
		Type.Array(Type.String(), { description: "add_connection / change_connection: node ids (or new-node refs) that TOGETHER imply the conclusion." }),
	),
	conclusion: Type.Optional(Type.String({ description: "add_connection / change_connection: the node id (or new-node ref) the premises imply." })),
	nodeIds: Type.Optional(
		Type.Array(Type.String(), { description: "set_placement: the facts to move — node ids (or new-node refs created earlier in the set)." }),
	),
	topic: Type.Optional(
		Type.String({ description: "set_placement: the topic to put them under — an existing topic's name (reused, never duplicated) or a new topic's name." }),
	),
	system: Type.Optional(Type.String({ description: "set_placement: the organ-system id the topic lives under. Required only when the topic is new." })),
	aspect: Type.Optional(
		Type.String({ description: "set_placement: one of " + PLACEMENT_ASPECTS.map((a) => a.id).join(", ") + ". Leave out to keep each fact's current aspect." }),
	),
});

const proposeInput = Type.Object({
	summary: Type.String({ minLength: 1, description: "One short line telling the learner what this set does." }),
	changes: Type.Array(changeSchema, {
		minItems: 1,
		maxItems: ORGANIZER_MAX_CHANGES,
		description: "The whole set, in order. All-or-nothing: if any change is invalid none is applied.",
	}),
});

export const PROPOSE_CHANGES_TOOL = "propose_changes";

export function organizerTools(ctx: OrganizerToolContext): Record<string, AgentTool<any>> {
	const nodes = () => getGraph(ctx.graphStore).nodes;
	/** "GI/Hepatobiliary › Small-bowel obstruction › Presentation" for a node, read fresh each call. */
	const placeTextFor = (): PlaceText | undefined => {
		if (!ctx.placements) return undefined;
		const derived = derivePlacements(ctx.placements.read());
		return (nodeId) => {
			const p = derived.byNode.get(nodeId);
			return p ? placementPathText(derived.topics.get(p.topicId), p.aspect) : "not placed yet";
		};
	};
	const tools: Record<string, AgentTool<any>> = {
		graph_overview: {
			name: "graph_overview",
			label: "graph_overview",
			description:
				"Counts for the learner's whole graph: nodes, connections, nodes per organ system and fact type, and how many are untagged. Call it first when the request is about the graph as a whole.",
			parameters: Type.Object({}),
			execute: serverExecute("graph_overview", Type.Object({}), async (): Promise<string> => {
				const graph = getGraph(ctx.graphStore);
				if (graph.nodes.length === 0) return "The knowledge graph is empty.";
				const bySystem = ORGAN_SYSTEMS.map((s) => `${s.id}: ${graph.nodes.filter((n) => n.systems?.includes(s.id)).length}`);
				const byType = FACT_TYPES.map((t) => `${t.id}: ${graph.nodes.filter((n) => n.factType === t.id).length}`);
				const lines = [
					`${graph.nodes.length} nodes, ${graph.chains.length} connections, ${graph.nodes.filter(isUntagged).length} missing a tag.`,
					`By organ system — ${bySystem.join(", ")}`,
					`By fact type — ${byType.join(", ")}`,
				];
				if (ctx.placements) {
					const derived = derivePlacements(ctx.placements.read());
					const placed = graph.nodes.filter((n) => derived.byNode.has(n.id)).length;
					lines.push(`Outline — ${placed} of ${graph.nodes.length} placed under ${new Set([...derived.byNode.values()].map((p) => p.topicId)).size} topics (use get_outline).`);
				}
				return lines.join("\n");
			}),
		},
		find_nodes: {
			name: "find_nodes",
			label: "find_nodes",
			description:
				"Search the graph for existing nodes — glob over names, statements and aliases. Returns id, name, tags and statement. Use it before creating a node (to avoid a duplicate) and to find the ids a change needs.",
			parameters: findInput,
			execute: serverExecute("find_nodes", findInput, async ({ query }): Promise<string> => {
				const hits = nodes().filter(
					(n) => globMatch(query, n.name) || globMatch(query, n.statement) || n.aliases.some((a) => globMatch(query, a)),
				);
				if (hits.length === 0) return `No node matches "${query}".`;
				const shown = hits.slice(0, 30);
				const placeText = placeTextFor();
				return `${hits.length} match(es)${hits.length > shown.length ? ` (first ${shown.length})` : ""}:\n${shown.map((n) => nodeLine(n, false, placeText)).join("\n")}`;
			}),
		},
		list_nodes: {
			name: "list_nodes",
			label: "list_nodes",
			description:
				"List nodes alphabetically by name, optionally filtered by organ system, fact type or untagged. Pages with offset/limit.",
			parameters: listInput,
			execute: serverExecute("list_nodes", listInput, async (input): Promise<string> => {
				let list = [...nodes()].sort((a, b) => a.name.localeCompare(b.name));
				if (input.system !== undefined) {
					const system = sanitizeSystems([input.system])[0];
					if (system === undefined) return `Unknown organ system "${input.system}". Use one of: ${ORGAN_SYSTEMS.map((s) => s.id).join(", ")}.`;
					list = list.filter((n) => n.systems?.includes(system));
				}
				if (input.factType !== undefined) {
					const factType = sanitizeFactType(input.factType);
					if (factType === undefined) return `Unknown fact type "${input.factType}". Use one of: ${FACT_TYPES.map((t) => t.id).join(", ")}.`;
					list = list.filter((n) => n.factType === factType);
				}
				if (input.untagged === true) list = list.filter(isUntagged);
				const placeText = placeTextFor();
				if (input.topic !== undefined) {
					if (!ctx.placements) return "The outline is not available.";
					const derived = derivePlacements(ctx.placements.read());
					const topic = findTopic(derived.topics.values(), input.topic);
					if (!topic) return `No topic "${input.topic}" in the outline. Use get_outline for the current topics.`;
					list = list.filter((n) => derived.byNode.get(n.id)?.topicId === topic.id);
				}
				const offset = input.offset ?? 0;
				const limit = input.limit ?? 40;
				const page = list.slice(offset, offset + limit);
				if (page.length === 0) return list.length === 0 ? "No nodes match." : `No more nodes (there are ${list.length}).`;
				const more = offset + page.length < list.length ? ` — next page: offset ${offset + page.length}` : "";
				return `Nodes ${offset + 1}–${offset + page.length} of ${list.length}${more}:\n${page.map((n) => nodeLine(n, false, placeText)).join("\n")}`;
			}),
		},
		get_node: {
			name: "get_node",
			label: "get_node",
			description:
				"One node in full — name, statement, tags, aliases — and every connection it takes part in, each with its connection id (needed to remove or change a connection).",
			parameters: getInput,
			execute: serverExecute("get_node", getInput, async ({ nodeId }): Promise<string> => {
				const graph = getGraph(ctx.graphStore);
				const node = graph.nodes.find((n) => n.id === nodeId);
				if (!node) return `No node ${nodeId}. Use find_nodes or list_nodes for current ids.`;
				const nameOf = (id: string) => graph.nodes.find((n) => n.id === id)?.name ?? id;
				const involved = graph.chains.filter((c) => c.conclusion === nodeId || c.premises.includes(nodeId));
				const lines = involved.map(
					(c) => `- ${c.id}: ${c.premises.map((p) => `${nameOf(p)} (${p})`).join(" + ")} ⟹ ${nameOf(c.conclusion)} (${c.conclusion})`,
				);
				return [
					nodeLine(node, true, placeTextFor()),
					node.aliases.length > 0 ? `  aliases: ${node.aliases.join(" | ")}` : "  aliases: none",
					involved.length > 0 ? `Connections (premises together imply the conclusion):\n${lines.join("\n")}` : "Connections: none",
				].join("\n");
			}),
		},
		get_outline: {
			name: "get_outline",
			label: "get_outline",
			description:
				"The textbook outline the facts are placed in: organ system → topic → aspect, with counts. With no arguments it lists every system with its topics (id, name, fact count). Pass a topic (name or t_… id) to see that topic's facts by aspect. Call it before moving facts, so you reuse an existing topic instead of creating a near-duplicate.",
			parameters: outlineInput,
			execute: serverExecute("get_outline", outlineInput, async ({ topic }): Promise<string> => {
				if (!ctx.placements) return "The outline is not available.";
				const graph = getGraph(ctx.graphStore);
				const derived = derivePlacements(ctx.placements.read());
				const live = new Set(graph.nodes.map((n) => n.id));
				const counts = new Map<string, number>();
				for (const [nodeId, p] of derived.byNode) if (live.has(nodeId)) counts.set(p.topicId, (counts.get(p.topicId) ?? 0) + 1);
				if (topic !== undefined) {
					const found = findTopic(derived.topics.values(), topic);
					if (!found) return `No topic "${topic}" in the outline. Call get_outline with no arguments for the topics.`;
					const mine = graph.nodes.filter((n) => derived.byNode.get(n.id)?.topicId === found.id);
					const lines = [`${placementPathText(found, undefined)} (${found.id}) — ${mine.length} fact(s)`];
					for (const a of PLACEMENT_ASPECTS) {
						const inAspect = mine.filter((n) => derived.byNode.get(n.id)?.aspect === a.id);
						if (inAspect.length === 0) continue;
						lines.push(`${placementAspectLabel(a.id)} (${a.id}):`, ...inAspect.map((n) => `- ${n.id} :: ${n.name}`));
					}
					return lines.join("\n");
				}
				const used = [...derived.topics.values()].filter((t) => (counts.get(t.id) ?? 0) > 0);
				if (used.length === 0) return "Nothing is placed in the outline yet.";
				const unplaced = graph.nodes.filter((n) => !derived.byNode.has(n.id)).length;
				const lines: string[] = [];
				for (const g of topicsBySystem(used)) {
					lines.push(`${g.label} [${g.system}]`, ...g.topics.map((t) => `  ${t.id} | ${t.name} | ${counts.get(t.id)} fact(s)`));
				}
				if (unplaced > 0) lines.push(`(${unplaced} fact(s) not placed yet)`);
				return lines.join("\n");
			}),
		},
		[PROPOSE_CHANGES_TOOL]: {
			name: PROPOSE_CHANGES_TOOL,
			label: PROPOSE_CHANGES_TOOL,
			description:
				"Hand the learner a SET of changes to review. Nothing is changed by this call — the learner sees each change (before and after) and accepts or rejects the set. " +
				"All-or-nothing: if any change is invalid the whole proposal is refused with the reasons, and you fix it and call again. " +
				"You cannot delete or merge nodes. Call this at most once per answer.",
			parameters: proposeInput,
			prepareArguments: (args: unknown) => {
				// Weak-model heal: the changes array sometimes arrives as one JSON string.
				if (typeof args !== "object" || args === null) return args as never;
				const record = { ...(args as Record<string, unknown>) };
				if (typeof record.changes === "string") {
					try {
						const parsed: unknown = JSON.parse(record.changes);
						if (Array.isArray(parsed)) record.changes = parsed;
					} catch {
						/* leave for validation */
					}
				}
				return record as never;
			},
			execute: async (_toolCallId, input: unknown) => {
				const { summary, changes: rawChanges } = input as { summary: string; changes: unknown };
				const parsed = parseOrganizerChanges(rawChanges);
				if ("problems" in parsed) return invalidInputResult(PROPOSE_CHANGES_TOOL, parsed.problems);
				const plan = planOrganizerChanges(ctx.graphStore.readNodes(), ctx.graphStore.readChains(), parsed.changes, {
					...(ctx.placements ? { placementLines: ctx.placements.read() } : {}),
				});
				if (!plan.ok) return invalidInputResult(PROPOSE_CHANGES_TOOL, plan.problems);
				ctx.onProposal({ summary: summary.trim(), changes: parsed.changes, previews: plan.previews });
				return toToolResult(
					`Proposal recorded: ${plan.previews.length} change(s) for the learner to review. Nothing has been changed yet — do not say it has. Now tell the learner, in one or two sentences, what you proposed and that they can accept or reject it.`,
				);
			},
		},
	};
	// The outline tool exists only where there is an outline to read.
	if (!ctx.placements) delete tools.get_outline;
	return tools;
}
