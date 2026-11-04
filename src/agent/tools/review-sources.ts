import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { factTypeLabel, organSystemLabel } from "../../core/contracts/graph.ts";
import { formatVerifyReference } from "../../core/contracts/verify.ts";
import type { GraphNode, VerifyItem } from "../../core/contracts.ts";
import { getGraph } from "../../core/graph.ts";
import { seenPageKey, type SeenSources } from "../../core/illness-script.ts";
import { tokenize } from "../../core/library.ts";
import type { GraphStore, VerifyStore } from "../../core/ports.ts";
import type { LibraryReader } from "../library/searcher.ts";
import { globMatch } from "./graph.ts";

/**
 * THE SCRIPTWRITER'S SOURCES (medical fork, Review mode): the read tools the
 * illness-script writer gathers from, each of which RECORDS what it showed
 * into a `SeenSources`. The script is validated against that record
 * (core/illness-script.ts), so a citation to a node, page or answer the
 * writer was never shown is refused — a citation cannot be invented.
 *
 * Three sources, matching the spec: the learner's graph, their library (the
 * existing library tools, wrapped), and the Expert AI answers they sent back.
 */

const STATEMENT_PREVIEW = 260;
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const tagText = (node: GraphNode): string => {
	const parts = [...(node.systems ?? []).map(organSystemLabel), ...(node.factType ? [factTypeLabel(node.factType)] : [])];
	return parts.length > 0 ? parts.join(" | ") : "untagged";
};

const nodeLine = (node: GraphNode, full = false): string =>
	`- ${node.id} :: ${node.name} [${tagText(node)}]\n  ${full ? node.statement : clip(node.statement, STATEMENT_PREVIEW)}`;

// ─── the graph ───────────────────────────────────────────────────────────────

const findInput = Type.Object({
	query: Type.String({ minLength: 1, description: "Glob over node names, statements and aliases — e.g. *pancreat*. A bare term gets implicit surrounding *." }),
});
const getInput = Type.Object({ nodeId: Type.String({ minLength: 1, description: 'A node id exactly as listed ("n_…").' }) });

export function scriptGraphTools(ctx: { graphStore: Pick<GraphStore, "readNodes" | "readChains">; seen: SeenSources }): Record<string, AgentTool<any>> {
	const note = (node: GraphNode): void => void ctx.seen.nodes.set(node.id, { id: node.id, name: node.name });
	return {
		find_nodes: {
			name: "find_nodes",
			label: "find_nodes",
			description:
				"Search the learner's knowledge graph — glob over node names, statements and aliases. Returns each matching node's id, name, tags and statement. A node id is what a claim cites as a graph source.",
			parameters: findInput,
			execute: serverExecute("find_nodes", findInput, async ({ query }): Promise<string> => {
				const hits = getGraph(ctx.graphStore).nodes.filter(
					(n) => globMatch(query, n.name) || globMatch(query, n.statement) || n.aliases.some((a) => globMatch(query, a)),
				);
				if (hits.length === 0) return `No node matches "${query}".`;
				const shown = hits.slice(0, 40);
				for (const n of shown) note(n);
				return `${hits.length} match(es)${hits.length > shown.length ? ` (first ${shown.length})` : ""}:\n${shown.map((n) => nodeLine(n)).join("\n")}`;
			}),
		},
		get_node: {
			name: "get_node",
			label: "get_node",
			description:
				"One node in full — name, tags, statement — and every connection it takes part in (premises that together imply a conclusion), with the neighbours' ids.",
			parameters: getInput,
			execute: serverExecute("get_node", getInput, async ({ nodeId }): Promise<string> => {
				const graph = getGraph(ctx.graphStore);
				const node = graph.nodes.find((n) => n.id === nodeId);
				if (!node) return `No node ${nodeId}. Use find_nodes for current ids.`;
				const byId = new Map(graph.nodes.map((n) => [n.id, n]));
				note(node);
				const involved = graph.chains.filter((c) => c.conclusion === nodeId || c.premises.includes(nodeId));
				const label = (id: string): string => {
					const n = byId.get(id);
					if (n) note(n);
					return `${n?.name ?? id} (${id})`;
				};
				const lines = involved.map((c) => `- ${c.premises.map(label).join(" + ")} ⟹ ${label(c.conclusion)}`);
				return [nodeLine(node, true), involved.length > 0 ? `Connections (premises together imply the conclusion):\n${lines.join("\n")}` : "Connections: none"].join("\n");
			}),
		},
	};
}

// ─── the library ─────────────────────────────────────────────────────────────

/** The library reader, recording every book and page it shows into `seen`. */
export function recordingLibraryReader(reader: LibraryReader, seen: SeenSources): LibraryReader {
	return {
		hasBooks: () => reader.hasBooks(),
		async search(query, opts) {
			const result = await reader.search(query, opts);
			for (const h of result.hits) {
				seen.pages.set(seenPageKey(h.book.id, h.chunk.page), { bookId: h.book.id, title: h.book.title, kind: h.book.kind, page: h.chunk.page });
			}
			return result;
		},
		read(book, pages) {
			const result = reader.read(book, pages);
			if (result.ok) {
				for (const p of result.pages) {
					seen.pages.set(seenPageKey(result.book.id, p.page), { bookId: result.book.id, title: result.book.title, kind: result.book.kind, page: p.page });
				}
			}
			return result;
		},
	};
}

// ─── Expert AI answers ───────────────────────────────────────────────────────

const searchInput = Type.Object({
	query: Type.String({ minLength: 1, description: "Words to look for in the Expert AI questions and answers the learner has collected." }),
});
const readInput = Type.Object({ id: Type.String({ minLength: 1, description: "An Expert AI answer id as expert_search printed it." }) });

const ANSWER_CAP = 20_000;

const answerDate = (item: VerifyItem): string => (item.answer?.receivedAt ?? item.updatedAt).slice(0, 10);

function score(item: VerifyItem, words: string[]): number {
	const haystack = `${item.prompt} ${item.answer?.text ?? ""} ${(item.answer?.references ?? []).map((r) => r.title ?? "").join(" ")}`.toLowerCase();
	let n = 0;
	for (const w of words) {
		let at = haystack.indexOf(w);
		while (at !== -1 && n < 200) {
			n++;
			at = haystack.indexOf(w, at + w.length);
		}
	}
	return n;
}

function excerpt(text: string, words: string[], span = 420): string {
	const lower = text.toLowerCase();
	const at = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
	const start = Math.max(0, at - 80);
	const piece = text.slice(start, start + span).replace(/\s+/g, " ").trim();
	return `${start > 0 ? "…" : ""}${piece}${start + span < text.length ? "…" : ""}`;
}

export function expertTools(ctx: { verifyStore: Pick<VerifyStore, "listItems" | "getItem">; seen: SeenSources }): Record<string, AgentTool<any>> {
	const note = (item: VerifyItem): void =>
		void ctx.seen.expert.set(item.id, { id: item.id, date: answerDate(item), prompt: item.prompt });
	return {
		expert_search: {
			name: "expert_search",
			label: "expert_search",
			description:
				"Search the UpToDate Expert AI answers the learner has collected (the question that was asked, the answer, its references). Returns the best matches with an id, the date, the question and an excerpt. Use expert_read for the whole answer.",
			parameters: searchInput,
			execute: serverExecute("expert_search", searchInput, async ({ query }): Promise<string> => {
				const words = [...new Set(tokenize(query))];
				const answered = ctx.verifyStore.listItems({ status: ["answered"] }).filter((i) => i.answer);
				const ranked = answered
					.map((item) => ({ item, s: words.length > 0 ? score(item, words) : 0 }))
					.filter((r) => r.s > 0)
					.sort((a, b) => b.s - a.s)
					.slice(0, 5);
				if (ranked.length === 0) return answered.length === 0 ? "The learner has no Expert AI answers yet." : `No Expert AI answer mentions "${query}".`;
				return [
					`${ranked.length} Expert AI answer(s) for "${query}", best first:`,
					...ranked.flatMap(({ item }) => {
						note(item);
						return ["", `${item.id} — ${answerDate(item)}`, `  Question: ${clip(item.prompt.replace(/\s+/g, " "), 300)}`, `  ${excerpt(item.answer!.text, words)}`];
					}),
				].join("\n");
			}),
		},
		expert_read: {
			name: "expert_read",
			label: "expert_read",
			description: "The full text of one collected Expert AI answer, with its references.",
			parameters: readInput,
			execute: serverExecute("expert_read", readInput, async ({ id }): Promise<string> => {
				const item = ctx.verifyStore.getItem(id);
				if (!item || item.status !== "answered" || !item.answer) return `No Expert AI answer ${id}. Use expert_search for current ids.`;
				note(item);
				const refs = item.answer.references.map((r) => `- ${formatVerifyReference(r)}`);
				const body = item.answer.text.length > ANSWER_CAP ? `${item.answer.text.slice(0, ANSWER_CAP)}\n[Truncated at ${ANSWER_CAP} characters.]` : item.answer.text;
				return [`${item.id} — UpToDate Expert AI, ${answerDate(item)}`, `Question: ${item.prompt}`, "", body, ...(refs.length > 0 ? ["", "References:", ...refs] : [])].join("\n");
			}),
		},
	};
}
