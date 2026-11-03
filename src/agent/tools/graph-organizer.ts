import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { invalidInputResult, serverExecute, toToolResult } from "../tool-execute.ts";
import { FACT_TYPES, ORGAN_SYSTEMS, factTypeLabel, isUntagged, organSystemLabel, sanitizeFactType, sanitizeSystems } from "../../core/contracts/graph.ts";
import type { GraphNode } from "../../core/contracts.ts";
import { getGraph } from "../../core/graph.ts";
import { parseOrganizerChanges, planOrganizerChanges } from "../../core/graph-organizer.ts";
import { ORGANIZER_MAX_CHANGES, type OrganizerChangePreview, type RawOrganizerChange } from "../../core/organizer-types.ts";
import type { GraphStore } from "../../core/ports.ts";
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

const nodeLine = (node: GraphNode, full = false): string =>
	`- ${node.id} :: ${node.name} [${tagText(node)}]\n  ${full ? node.statement : clip(node.statement, STATEMENT_PREVIEW)}`;

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
	offset: Type.Optional(Type.Integer({ minimum: 0, description: "Skip this many (for paging). Default 0." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "How many to return. Default 40, at most 100." })),
});

const getInput = Type.Object({
	nodeId: Type.String({ minLength: 1, description: 'A node id exactly as listed ("n_…").' }),
});

const changeSchema = Type.Object({
	op: Type.String({
		description:
			'One of "create_node", "rename_node", "edit_node", "set_tags", "add_connection", "remove_connection", "change_connection".',
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
	return {
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
				return [
					`${graph.nodes.length} nodes, ${graph.chains.length} connections, ${graph.nodes.filter(isUntagged).length} missing a tag.`,
					`By organ system — ${bySystem.join(", ")}`,
					`By fact type — ${byType.join(", ")}`,
				].join("\n");
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
				return `${hits.length} match(es)${hits.length > shown.length ? ` (first ${shown.length})` : ""}:\n${shown.map((n) => nodeLine(n)).join("\n")}`;
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
				const offset = input.offset ?? 0;
				const limit = input.limit ?? 40;
				const page = list.slice(offset, offset + limit);
				if (page.length === 0) return list.length === 0 ? "No nodes match." : `No more nodes (there are ${list.length}).`;
				const more = offset + page.length < list.length ? ` — next page: offset ${offset + page.length}` : "";
				return `Nodes ${offset + 1}–${offset + page.length} of ${list.length}${more}:\n${page.map((n) => nodeLine(n)).join("\n")}`;
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
					nodeLine(node, true),
					node.aliases.length > 0 ? `  aliases: ${node.aliases.join(" | ")}` : "  aliases: none",
					involved.length > 0 ? `Connections (premises together imply the conclusion):\n${lines.join("\n")}` : "Connections: none",
				].join("\n");
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
				const plan = planOrganizerChanges(ctx.graphStore.readNodes(), ctx.graphStore.readChains(), parsed.changes);
				if (!plan.ok) return invalidInputResult(PROPOSE_CHANGES_TOOL, plan.problems);
				ctx.onProposal({ summary: summary.trim(), changes: parsed.changes, previews: plan.previews });
				return toToolResult(
					`Proposal recorded: ${plan.previews.length} change(s) for the learner to review. Nothing has been changed yet — do not say it has. Now tell the learner, in one or two sentences, what you proposed and that they can accept or reject it.`,
				);
			},
		},
	};
}
