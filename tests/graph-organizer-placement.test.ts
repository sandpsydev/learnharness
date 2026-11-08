/**
 * The organizer's set_placement op (src/core/graph-organizer.ts): move facts
 * under a topic by prompt — before → after preview, canonical-topic reuse,
 * all-or-nothing validation, and undo. Over in-memory ledgers; no model.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GraphChain, GraphNode } from "../src/core/contracts.ts";
import type { PlacementLine } from "../src/core/contracts/placement.ts";
import { applyOrganizerChanges, parseOrganizerChanges, planOrganizerChanges, undoOrganizerEntry, type OrganizerHistoryStore } from "../src/core/graph-organizer.ts";
import type { OrganizerHistoryEntry, RawOrganizerChange } from "../src/core/organizer-types.ts";
import { derivePlacements } from "../src/core/placement.ts";
import type { GraphStore } from "../src/core/ports.ts";
import { organizerTools } from "../src/agent/tools/graph-organizer.ts";

const T0 = "2026-11-01T00:00:00.000Z";
const node = (id: string, name: string, over: Partial<GraphNode> = {}): GraphNode => ({
	id,
	name,
	statement: `${name} statement.`,
	aliases: [],
	createdAt: T0,
	provenance: [{ chatId: "c1", messageId: "m1" }],
	...over,
});

const topic = (id: string, name: string, system: string): PlacementLine => ({ kind: "topic", id, name, system, createdAt: T0 }) as PlacementLine;
const place = (nodeId: string, topicId: string, aspect: string): PlacementLine =>
	({ kind: "place", nodeId, topicId, aspect, source: "placer", confidence: "high", at: T0 }) as PlacementLine;

function setup(initialPlacements: PlacementLine[] = []) {
	const state = {
		nodes: [node("n_ileus", "Paralytic ileus"), node("n_sbo", "Adhesions cause obstruction"), node("n_ap", "Amylase rises"), node("n_x", "Other")],
		chains: [] as GraphChain[],
		placements: [...initialPlacements],
	};
	const store = {
		readNodes: () => state.nodes.map((n) => structuredClone(n)),
		readChains: () => state.chains,
		rewriteLedgers: (next: { nodes?: GraphNode[]; chains?: GraphChain[] }) => {
			if (next.nodes) state.nodes = next.nodes;
			if (next.chains) state.chains = next.chains;
		},
	} as unknown as GraphStore;
	let entries: OrganizerHistoryEntry[] = [];
	const history: OrganizerHistoryStore = { read: () => entries, write: (e) => void (entries = e) };
	const placements = { read: () => [...state.placements], rewrite: (l: readonly PlacementLine[]) => void (state.placements = [...l]) };
	let n = 0;
	const opts = { now: "2026-11-09T09:00:00.000Z", newTopicId: () => `t_new${++n}`, newNodeId: () => `n_new${++n}`, newChainId: () => `arg_new${++n}` };
	return {
		state,
		store,
		history,
		placements,
		opts,
		deps: { graphStore: store, history, placements },
		plan: (changes: RawOrganizerChange[]) => planOrganizerChanges(state.nodes, state.chains, changes, { ...opts, placementLines: state.placements }),
		apply: (changes: RawOrganizerChange[]) => applyOrganizerChanges({ graphStore: store, history, placements }, { summary: "move", changes }, opts),
	};
}

const base = () => setup([topic("t_sbo", "Small-bowel obstruction", "gi"), topic("t_ap", "Acute pancreatitis", "gi"), place("n_ileus", "t_ap", "presentation"), place("n_sbo", "t_sbo", "how-it-develops")]);

describe("set_placement", () => {
	it("moves facts under an existing topic and shows each fact's before → after", () => {
		const h = base();
		const plan = h.plan([{ op: "set_placement", nodeIds: ["n_ileus", "n_x"], topic: "Small-bowel obstruction", aspect: "how it develops" }]);
		assert.ok(plan.ok);
		const preview = plan.previews[0]!;
		assert.match(preview.title, /Move 2 facts to GI\/Hepatobiliary › Small-bowel obstruction › How it develops/);
		const ileus = preview.rows.find((r) => r.field === "Paralytic ileus")!;
		assert.equal(ileus.before, "GI/Hepatobiliary › Acute pancreatitis › Presentation");
		assert.equal(ileus.after, "GI/Hepatobiliary › Small-bowel obstruction › How it develops");
		assert.equal(preview.rows.find((r) => r.field === "Other")!.before, "Not placed yet");
		assert.equal(plan.placementLines.filter((l) => l.kind === "topic").length, 2, "no new topic was minted");
	});

	it("reuses the canonical topic whatever the spelling, name or acronym used", () => {
		for (const topicText of ["small bowel obstruction", "SBO", "t_sbo", "  Small-Bowel   Obstruction "]) {
			const h = base();
			const plan = h.plan([{ op: "set_placement", nodeIds: ["n_x"], topic: topicText }]);
			assert.ok(plan.ok, topicText);
			assert.equal(plan.placementLines.filter((l) => l.kind === "topic").length, 2, topicText);
			assert.equal(derivePlacements(plan.placementLines).byNode.get("n_x")?.topicId, "t_sbo", topicText);
		}
	});

	it("omitting the aspect keeps each fact's own; an unplaced fact gets 'other'", () => {
		const h = base();
		const plan = h.plan([{ op: "set_placement", nodeIds: ["n_ileus", "n_x"], topic: "Small-bowel obstruction" }]);
		assert.ok(plan.ok);
		const d = derivePlacements(plan.placementLines);
		assert.equal(d.byNode.get("n_ileus")?.aspect, "presentation");
		assert.equal(d.byNode.get("n_x")?.aspect, "other");
		assert.match(plan.previews[0]!.title, /each keeps its aspect/);
	});

	it("a new topic needs its organ system, and is then minted once with the learner as the source", () => {
		const h = base();
		const missing = h.plan([{ op: "set_placement", nodeIds: ["n_x"], topic: "Paralytic ileus topic" }]);
		assert.ok(!missing.ok);
		assert.match(missing.problems[0]!, /new topic — say which organ system/);

		const plan = h.plan([{ op: "set_placement", nodeIds: ["n_ileus", "n_x"], topic: "Intestinal pseudo-obstruction", system: "gi", aspect: "workup" }]);
		assert.ok(plan.ok);
		const minted = plan.placementLines.filter((l) => l.kind === "topic");
		assert.equal(minted.length, 3);
		const d = derivePlacements(plan.placementLines);
		assert.equal(d.byNode.get("n_x")?.source, "learner");
		assert.equal(d.topics.get(d.byNode.get("n_x")!.topicId)?.system, "gi");
	});

	it("refuses an organ system that contradicts the existing topic's, and unknown systems or aspects", () => {
		const h = base();
		const clash = h.plan([{ op: "set_placement", nodeIds: ["n_x"], topic: "Small-bowel obstruction", system: "renal" }]);
		assert.ok(!clash.ok);
		assert.match(clash.problems[0]!, /lives under GI\/Hepatobiliary, not Renal\/Urinary/);
		const badSystem = h.plan([{ op: "set_placement", nodeIds: ["n_x"], topic: "Whatever", system: "kidneys" }]);
		assert.ok(!badSystem.ok && /unknown organ system/.test(badSystem.problems[0]!));
		const badAspect = h.plan([{ op: "set_placement", nodeIds: ["n_x"], topic: "Small-bowel obstruction", aspect: "vibes" }]);
		assert.ok(!badAspect.ok && /unknown aspect/.test(badAspect.problems[0]!));
	});

	it("refuses missing or unknown facts, a missing topic, an unknown topic id, and moves that change nothing", () => {
		const h = base();
		assert.ok(!h.plan([{ op: "set_placement", topic: "Small-bowel obstruction" }]).ok);
		const ghost = h.plan([{ op: "set_placement", nodeIds: ["n_ghost"], topic: "Small-bowel obstruction" }]);
		assert.ok(!ghost.ok && /not a node in the graph/.test(ghost.problems[0]!));
		assert.ok(!h.plan([{ op: "set_placement", nodeIds: ["n_x"] }]).ok);
		const badId = h.plan([{ op: "set_placement", nodeIds: ["n_x"], topic: "t_deadbeef", system: "gi" }]);
		assert.ok(!badId.ok && /not a topic in the outline/.test(badId.problems[0]!));
		const same = h.plan([{ op: "set_placement", nodeIds: ["n_sbo"], topic: "Small-bowel obstruction", aspect: "how-it-develops" }]);
		assert.ok(!same.ok && /already there/.test(same.problems[0]!));
	});

	it("is all or nothing: one bad change in the set rejects the whole set and writes nothing", () => {
		const h = base();
		const before = JSON.stringify(h.state.placements);
		const result = h.apply([
			{ op: "set_placement", nodeIds: ["n_x"], topic: "Small-bowel obstruction" },
			{ op: "rename_node", nodeId: "n_ghost", name: "Nope" },
		]);
		assert.ok(!result.ok);
		assert.equal(JSON.stringify(h.state.placements), before);
		assert.equal(h.history.read().length, 0);
	});

	it("can place a node created earlier in the same set, and refuses placement where none is available", () => {
		const h = base();
		const plan = h.plan([
			{ op: "create_node", ref: "new1", name: "Closed-loop obstruction", statement: "A closed loop can strangulate." },
			{ op: "set_placement", nodeIds: ["new1"], topic: "Small-bowel obstruction", aspect: "complications" },
		]);
		assert.ok(plan.ok);
		const created = plan.nodeLines.find((n) => n.name === "Closed-loop obstruction")!;
		assert.equal(derivePlacements(plan.placementLines).byNode.get(created.id)?.aspect, "complications");

		const none = planOrganizerChanges(h.state.nodes, h.state.chains, [{ op: "set_placement", nodeIds: ["n_x"], topic: "SBO" }], h.opts);
		assert.ok(!none.ok && /not available/.test(none.problems[0]!));
	});

	it("is parsed from the agent's list like the other ops", () => {
		const parsed = parseOrganizerChanges([{ op: "set_placement", nodeIds: ["n_x"], topic: "SBO", aspect: "workup", system: "gi" }]);
		assert.ok("changes" in parsed);
		assert.deepEqual(parsed.changes[0]!.nodeIds, ["n_x"]);
		assert.ok("problems" in parseOrganizerChanges([{ op: "set_placement", nodeIds: "n_x" }]));
	});
});

describe("apply and undo", () => {
	it("appends only placement lines (node and chain ledgers untouched), journals them, and undo takes them back out", () => {
		const h = base();
		const nodesBefore = JSON.stringify(h.state.nodes);
		const chainsBefore = JSON.stringify(h.state.chains);
		const linesBefore = h.state.placements.length;
		const result = h.apply([{ op: "set_placement", nodeIds: ["n_ileus", "n_x"], topic: "Small-bowel obstruction", aspect: "how-it-develops" }]);
		assert.ok(result.ok);
		assert.equal(JSON.stringify(h.state.nodes), nodesBefore);
		assert.equal(JSON.stringify(h.state.chains), chainsBefore);
		assert.equal(h.state.placements.length, linesBefore + 2);
		assert.equal(derivePlacements(h.state.placements).byNode.get("n_ileus")?.topicId, "t_sbo");
		assert.equal(result.entry.placements?.added.length, 2);

		const undone = undoOrganizerEntry(h.deps, result.entry.id);
		assert.ok(undone.ok);
		assert.equal(h.state.placements.length, linesBefore);
		const d = derivePlacements(h.state.placements);
		assert.equal(d.byNode.get("n_ileus")?.topicId, "t_ap", "the fact is back where it was");
		assert.equal(d.byNode.has("n_x"), false);
	});

	it("undo removes a topic the set minted, and refuses — changing nothing — when its lines are no longer there", () => {
		const h = base();
		const result = h.apply([{ op: "set_placement", nodeIds: ["n_x"], topic: "Volvulus", system: "gi" }]);
		assert.ok(result.ok);
		assert.ok(derivePlacements(h.state.placements).topics.has("t_new1"));

		// Something rewrote the ledger since: the added lines are gone.
		const snapshot = [...h.state.placements];
		h.state.placements = h.state.placements.filter((l) => l.kind !== "place" || l.nodeId !== "n_x");
		const refused = undoOrganizerEntry(h.deps, result.entry.id);
		assert.ok(!refused.ok && refused.code === "conflict");
		assert.equal(h.history.read()[0]!.undoneAt, undefined);

		h.state.placements = snapshot;
		assert.ok(undoOrganizerEntry(h.deps, result.entry.id).ok);
		assert.ok(!derivePlacements(h.state.placements).topics.has("t_new1"));
	});

	it("later placer lines do not stop an undo", () => {
		const h = base();
		const result = h.apply([{ op: "set_placement", nodeIds: ["n_x"], topic: "Small-bowel obstruction" }]);
		assert.ok(result.ok);
		h.placements.rewrite([...h.state.placements, place("n_ap", "t_ap", "workup")]);
		assert.ok(undoOrganizerEntry(h.deps, result.entry.id).ok);
		assert.equal(derivePlacements(h.state.placements).byNode.get("n_ap")?.aspect, "workup");
	});
});

describe("the organizer's tools", () => {
	const setupTools = () => {
		const h = base();
		const proposals: unknown[] = [];
		const tools = organizerTools({ graphStore: h.store, placements: h.placements, onProposal: (p) => void proposals.push(p) });
		return { h, tools, proposals };
	};
	const run = async (tool: { execute: (id: string, input: any) => Promise<any> }, input: unknown): Promise<string> => {
		const out = await tool.execute("t1", input);
		return out.content.map((c: { text?: string }) => c.text ?? "").join("\n");
	};

	it("get_outline lists the topics with counts, and one topic's facts by aspect", async () => {
		const { tools } = setupTools();
		const all = await run(tools.get_outline!, {});
		assert.match(all, /GI\/Hepatobiliary \[gi\]/);
		assert.match(all, /t_sbo \| Small-bowel obstruction \| 1 fact/);
		assert.match(all, /2 fact\(s\) not placed yet/);
		const one = await run(tools.get_outline!, { topic: "SBO" });
		assert.match(one, /How it develops \(how-it-develops\):/);
		assert.match(one, /n_sbo :: Adhesions cause obstruction/);
		assert.match(await run(tools.get_outline!, { topic: "Nope" }), /No topic/);
	});

	it("node lines show their place, and list_nodes filters by topic", async () => {
		const { tools } = setupTools();
		assert.match(await run(tools.find_nodes!, { query: "ileus" }), /\{GI\/Hepatobiliary › Acute pancreatitis › Presentation\}/);
		const listed = await run(tools.list_nodes!, { topic: "Small-bowel obstruction" });
		assert.match(listed, /n_sbo/);
		assert.doesNotMatch(listed, /n_ileus/);
	});

	it("propose_changes accepts a valid set_placement and records it for review", async () => {
		const { tools, proposals } = setupTools();
		const text = await run(tools.propose_changes!, { summary: "Move ileus", changes: [{ op: "set_placement", nodeIds: ["n_ileus"], topic: "SBO", aspect: "how-it-develops" }] });
		assert.match(text, /Proposal recorded/);
		assert.equal(proposals.length, 1);
		const refused = await run(tools.propose_changes!, { summary: "Bad", changes: [{ op: "set_placement", nodeIds: ["n_ileus"], topic: "Brand new" }] });
		assert.doesNotMatch(refused, /Proposal recorded/);
		assert.equal(proposals.length, 1);
	});

	it("without an outline there is no get_outline tool", () => {
		const h = base();
		const tools = organizerTools({ graphStore: h.store, onProposal: () => {} });
		assert.equal("get_outline" in tools, false);
	});
});
