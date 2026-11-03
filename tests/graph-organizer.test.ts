/**
 * The knowledge-organizer's change engine (src/core/graph-organizer.ts):
 * every operation, every rejection, and undo — over an in-memory ledger, no
 * model involved.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GraphChain, GraphNode } from "../src/core/contracts.ts";
import { getGraph } from "../src/core/graph.ts";
import { deleteChatTraces } from "../src/core/graph-deletion.ts";
import {
	applyOrganizerChanges,
	organizerHistoryItems,
	parseOrganizerChanges,
	planOrganizerChanges,
	undoOrganizerEntry,
	type OrganizerHistoryStore,
} from "../src/core/graph-organizer.ts";
import type { OrganizerHistoryEntry, RawOrganizerChange } from "../src/core/organizer-types.ts";
import type { GraphStore } from "../src/core/ports.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const T0 = "2026-10-01T00:00:00.000Z";
const node = (id: string, name: string, over: Partial<GraphNode> = {}): GraphNode => ({
	id,
	name,
	statement: `${name} statement.`,
	aliases: [],
	createdAt: T0,
	provenance: [{ chatId: "chat1", messageId: "m1" }],
	...over,
});
const chain = (id: string, premises: string[], conclusion: string): GraphChain => ({
	id,
	premises,
	conclusion,
	provenance: [{ chatId: "chat1", messageId: "" }],
	createdAt: T0,
});

/** An in-memory GraphStore that rewrites like the real one (whole-ledger replace). */
function memory(nodes: GraphNode[], chains: GraphChain[]) {
	const state = { nodes: [...nodes], chains: [...chains], rewrites: 0 };
	const store = {
		readNodes: () => state.nodes.map((n) => structuredClone(n)),
		readChains: () => state.chains.map((c) => structuredClone(c)),
		appendNode: (n: GraphNode) => void state.nodes.push(n),
		appendChain: (c: GraphChain) => void state.chains.push(c),
		rewriteLedgers: (next: { nodes?: GraphNode[]; chains?: GraphChain[] }) => {
			state.rewrites++;
			if (next.nodes) state.nodes = next.nodes.map((n) => structuredClone(n));
			if (next.chains) state.chains = next.chains.map((c) => structuredClone(c));
		},
		readCoverage: () => [],
		readCheckpoints: () => [],
		readPositions: () => ({}),
		writePositions: () => {},
	} as unknown as GraphStore;
	let entries: OrganizerHistoryEntry[] = [];
	const history: OrganizerHistoryStore = { read: () => entries, write: (e) => void (entries = e) };
	return { state, store, history, deps: { graphStore: store, history } };
}

/** A small renal graph: three nodes in one tagged cluster, one chain. */
function renal() {
	return memory(
		[
			node("n_a", "Low GFR", { systems: ["renal"], factType: "mechanism" }),
			node("n_b", "Retained urea", { systems: ["renal"], factType: "mechanism" }),
			node("n_c", "Uraemia", { systems: ["renal"], factType: "clinical-feature" }),
			node("n_d", "Untagged fact"),
		],
		[chain("arg_1", ["n_a"], "n_b")],
	);
}

let counter = 0;
const ids = { newNodeId: () => `n_new${++counter}`, newChainId: () => `arg_new${++counter}` };
const opts = { now: "2026-11-04T10:00:00.000Z", ...ids };

const apply = (m: ReturnType<typeof memory>, changes: RawOrganizerChange[], summary = "test set") =>
	applyOrganizerChanges(m.deps, { summary, changes }, opts);

const graphOf = (m: ReturnType<typeof memory>) => getGraph(m.store);

// ─── parsing ─────────────────────────────────────────────────────────────────

describe("parseOrganizerChanges", () => {
	it("accepts well-formed changes and drops nothing", () => {
		const parsed = parseOrganizerChanges([{ op: "rename_node", nodeId: "n_a", name: "X" }]);
		assert.deepEqual("changes" in parsed && parsed.changes, [{ op: "rename_node", nodeId: "n_a", name: "X" }]);
	});

	it("rejects unknown ops — delete and merge are not offered", () => {
		for (const op of ["delete_node", "merge_nodes"]) {
			const parsed = parseOrganizerChanges([{ op, nodeId: "n_a" }]);
			assert.ok("problems" in parsed, op);
			assert.match(parsed.problems[0]!, /unknown op/);
		}
	});

	it("rejects non-lists, empty lists, wrong field types and oversize sets", () => {
		assert.ok("problems" in parseOrganizerChanges("nope"));
		assert.ok("problems" in parseOrganizerChanges([]));
		assert.ok("problems" in parseOrganizerChanges([{ op: "rename_node", nodeId: 7 }]));
		assert.ok("problems" in parseOrganizerChanges([{ op: "set_tags", nodeId: "n_a", systems: "renal" }]));
		assert.ok("problems" in parseOrganizerChanges(Array.from({ length: 41 }, () => ({ op: "rename_node" }))));
	});
});

// ─── operations ──────────────────────────────────────────────────────────────

describe("create_node", () => {
	it("adds a learner-owned node (no provenance, tags locked) and connects to it by ref", () => {
		const m = renal();
		const result = apply(m, [
			{ op: "create_node", ref: "new1", name: "Hyperkalaemia", statement: "Potassium is raised.", systems: ["renal"], factType: "clinical-feature" },
			{ op: "add_connection", premises: ["n_a"], conclusion: "new1" },
		]);
		assert.ok(result.ok);
		const g = graphOf(m);
		const created = g.nodes.find((n) => n.name === "Hyperkalaemia")!;
		assert.deepEqual(created.provenance, []);
		assert.deepEqual(created.systems, ["renal"]);
		assert.equal(created.factType, "clinical-feature");
		assert.ok(g.chains.some((c) => c.conclusion === created.id && c.premises[0] === "n_a"));
		assert.deepEqual(result.entry.createdNodeIds, [created.id]);
		assert.match(result.entry.previews[0]!.title, /Create node/);
	});

	it("rejects a statement the graph already has, as a node or an alias", () => {
		const m = memory([node("n_a", "Low GFR", { statement: "GFR is low.", aliases: ["Reduced GFR"] })], []);
		for (const statement of ["GFR is low", "  reduced   gfr. "]) {
			const plan = planOrganizerChanges(m.state.nodes, m.state.chains, [{ op: "create_node", ref: "x", name: "Dup", statement }], opts);
			assert.ok(!plan.ok, statement);
			assert.match(plan.problems[0]!, /already has this statement on node n_a/);
		}
	});

	it("rejects a missing ref, a bad ref, a duplicate ref, an empty or too-long name/statement, and unknown tags", () => {
		const m = renal();
		const problemsOf = (change: RawOrganizerChange | RawOrganizerChange[]) => {
			const plan = planOrganizerChanges(m.state.nodes, m.state.chains, Array.isArray(change) ? change : [change], opts);
			assert.ok(!plan.ok);
			return plan.problems.join(" | ");
		};
		const base = { op: "create_node", ref: "new1", name: "N", statement: "S." };
		assert.match(problemsOf({ ...base, ref: undefined }), /ref is missing/);
		assert.match(problemsOf({ ...base, ref: "n_x" }), /must be a short word/);
		assert.match(problemsOf([base, { ...base, name: "M", statement: "T." }]), /used twice/);
		assert.match(problemsOf({ ...base, name: "  " }), /name is missing/);
		assert.match(problemsOf({ ...base, name: "x".repeat(81) }), /name is too long/);
		assert.match(problemsOf({ ...base, statement: "" }), /statement is missing/);
		assert.match(problemsOf({ ...base, statement: "x".repeat(601) }), /statement is too long/);
		assert.match(problemsOf({ ...base, systems: ["cardiology"] }), /unknown organ system “cardiology”/);
		assert.match(problemsOf({ ...base, factType: "drug therapy" }), /unknown fact type/);
		assert.match(problemsOf({ ...base, factType: "none" }), /unknown fact type/);
	});

	it("a node made by the learner survives deleting an unrelated chat", () => {
		const m = renal();
		assert.ok(apply(m, [{ op: "create_node", ref: "new1", name: "Mine", statement: "My own fact." }]).ok);
		deleteChatTraces(m.store, "chat1", "delete-nodes");
		assert.deepEqual(
			graphOf(m).nodes.map((n) => n.name),
			["Mine"],
			"the session's nodes die with the chat, the learner's own node stays",
		);
	});
});

describe("rename_node and edit_node", () => {
	it("renames by changing the defining line; id, statement and tags stay", () => {
		const m = renal();
		const result = apply(m, [{ op: "rename_node", nodeId: "n_c", name: "Uraemic syndrome" }]);
		assert.ok(result.ok);
		const after = graphOf(m).nodes.find((n) => n.id === "n_c")!;
		assert.equal(after.name, "Uraemic syndrome");
		assert.equal(after.statement, "Uraemia statement.");
		assert.deepEqual(after.systems, ["renal"]);
		assert.deepEqual(result.entry.previews[0]!.rows, [{ field: "Name", before: "Uraemia", after: "Uraemic syndrome" }]);
	});

	it("edits the statement and keeps the old wording as an alias", () => {
		const m = renal();
		assert.ok(apply(m, [{ op: "edit_node", nodeId: "n_c", statement: "Uraemia is the clinical syndrome of retained urea." }]).ok);
		const after = graphOf(m).nodes.find((n) => n.id === "n_c")!;
		assert.equal(after.statement, "Uraemia is the clinical syndrome of retained urea.");
		assert.deepEqual(after.aliases, ["Uraemia statement."]);
	});

	it("rejects no-ops, unknown nodes, connection ids, and an edit that duplicates another node", () => {
		const m = renal();
		const problemsOf = (c: RawOrganizerChange) => {
			const plan = planOrganizerChanges(m.state.nodes, m.state.chains, [c], opts);
			assert.ok(!plan.ok);
			return plan.problems[0]!;
		};
		assert.match(problemsOf({ op: "rename_node", nodeId: "n_c", name: "Uraemia" }), /already has that name/);
		assert.match(problemsOf({ op: "rename_node", nodeId: "n_zzz", name: "X" }), /is not a node in the graph/);
		assert.match(problemsOf({ op: "rename_node", nodeId: "arg_1", name: "X" }), /connection id, not a node id/);
		assert.match(problemsOf({ op: "rename_node", name: "X" }), /nodeId is missing/);
		assert.match(problemsOf({ op: "edit_node", nodeId: "n_c", statement: "Uraemia statement" }), /already that/);
		assert.match(problemsOf({ op: "edit_node", nodeId: "n_c", statement: "Low GFR statement." }), /already has this statement on node n_a/);
	});
});

describe("set_tags", () => {
	it("replaces systems and fact type as the detail card does, and locks them against extraction", () => {
		const m = renal();
		const result = apply(m, [{ op: "set_tags", nodeId: "n_d", systems: ["cardiovascular", "renal"], factType: "management" }]);
		assert.ok(result.ok);
		const after = graphOf(m).nodes.find((n) => n.id === "n_d")!;
		assert.deepEqual(after.systems, ["cardiovascular", "renal"]);
		assert.equal(after.factType, "management");
		assert.deepEqual(result.entry.previews[0]!.rows.map((r) => [r.field, r.before, r.after]), [
			["Organ system", "none", "Cardiovascular, Renal/Urinary"],
			["Fact type", "none", "Management"],
		]);
		// An extraction link-append for the node must not fill over the edit.
		m.state.nodes.push(node("n_d", "Untagged fact", { systems: ["gi"], factType: "memorise" }));
		assert.deepEqual(graphOf(m).nodes.find((n) => n.id === "n_d")!.systems, ["cardiovascular", "renal"]);
	});

	it("changes one field and leaves the other; [] and none clear", () => {
		const m = renal();
		assert.ok(apply(m, [{ op: "set_tags", nodeId: "n_a", factType: "management" }]).ok);
		let after = graphOf(m).nodes.find((n) => n.id === "n_a")!;
		assert.deepEqual(after.systems, ["renal"]);
		assert.equal(after.factType, "management");
		assert.ok(apply(m, [{ op: "set_tags", nodeId: "n_a", systems: [], factType: "none" }]).ok);
		after = graphOf(m).nodes.find((n) => n.id === "n_a")!;
		assert.equal(after.systems, undefined);
		assert.equal(after.factType, undefined);
	});

	it("accepts a vocabulary label and rejects anything outside the vocabulary", () => {
		const m = renal();
		assert.ok(apply(m, [{ op: "set_tags", nodeId: "n_d", systems: ["Renal/Urinary"], factType: "Clinical feature" }]).ok);
		const after = graphOf(m).nodes.find((n) => n.id === "n_d")!;
		assert.deepEqual(after.systems, ["renal"]);
		assert.equal(after.factType, "clinical-feature");
		const bad = planOrganizerChanges(m.state.nodes, m.state.chains, [{ op: "set_tags", nodeId: "n_a", systems: ["nephrology"], factType: "treatment" }], opts);
		assert.ok(!bad.ok);
		assert.equal(bad.problems.length, 2);
	});

	it("rejects a change that sets nothing, and tags the node already has", () => {
		const m = renal();
		const cases: Array<[RawOrganizerChange, RegExp]> = [
			[{ op: "set_tags", nodeId: "n_a" }, /give systems and\/or factType/],
			[{ op: "set_tags", nodeId: "n_a", systems: ["renal"], factType: "mechanism" }, /already has those tags/],
		];
		for (const [change, pattern] of cases) {
			const plan = planOrganizerChanges(m.state.nodes, m.state.chains, [change], opts);
			assert.ok(!plan.ok);
			assert.match(plan.problems[0]!, pattern);
		}
	});
});

describe("connections", () => {
	it("adds a multi-premise connection", () => {
		const m = renal();
		const result = apply(m, [{ op: "add_connection", premises: ["n_a", "n_b"], conclusion: "n_c" }]);
		assert.ok(result.ok);
		const added = graphOf(m).chains.find((c) => c.conclusion === "n_c")!;
		assert.deepEqual([...added.premises].sort(), ["n_a", "n_b"]);
		assert.deepEqual(added.provenance, []);
		assert.equal(result.entry.previews[0]!.rows[0]!.after, "Low GFR + Retained urea ⟹ Uraemia");
	});

	it("removes a connection and leaves both nodes", () => {
		const m = renal();
		const result = apply(m, [{ op: "remove_connection", chainId: "arg_1" }]);
		assert.ok(result.ok);
		assert.equal(graphOf(m).chains.length, 0);
		assert.equal(graphOf(m).nodes.length, 4);
		assert.equal(result.entry.previews[0]!.rows[0]!.before, "Low GFR ⟹ Retained urea");
	});

	it("changes a connection in place: same id, new premises or conclusion", () => {
		const m = renal();
		assert.ok(apply(m, [{ op: "change_connection", chainId: "arg_1", conclusion: "n_c" }]).ok);
		const chains = graphOf(m).chains;
		assert.equal(chains.length, 1);
		assert.equal(chains[0]!.id, "arg_1");
		assert.deepEqual(chains[0]!.premises, ["n_a"]);
		assert.equal(chains[0]!.conclusion, "n_c");
		assert.deepEqual(chains[0]!.provenance, [{ chatId: "chat1", messageId: "" }], "the original provenance is kept");
	});

	it("rejects a duplicate, a self-reference, a loop, a missing end, and an unknown connection", () => {
		const m = renal();
		const problemsOf = (c: RawOrganizerChange) => {
			const plan = planOrganizerChanges(m.state.nodes, m.state.chains, [c], opts);
			assert.ok(!plan.ok);
			return plan.problems.join(" | ");
		};
		assert.match(problemsOf({ op: "add_connection", premises: ["n_a"], conclusion: "n_b" }), /already exists \(arg_1\)/);
		assert.match(problemsOf({ op: "add_connection", premises: ["n_a", "n_c"], conclusion: "n_c" }), /cannot be a premise of its own conclusion/);
		assert.match(problemsOf({ op: "add_connection", premises: ["n_b"], conclusion: "n_a" }), /would create a loop/);
		assert.match(problemsOf({ op: "add_connection", premises: ["n_zzz"], conclusion: "n_c" }), /is not a node in the graph/);
		assert.match(problemsOf({ op: "add_connection", premises: [], conclusion: "n_c" }), /at least one premise/);
		assert.match(problemsOf({ op: "remove_connection", chainId: "arg_nope" }), /is not a connection/);
		assert.match(problemsOf({ op: "change_connection", chainId: "arg_1" }), /give the new premises and\/or conclusion/);
		assert.match(problemsOf({ op: "change_connection", chainId: "arg_1", premises: ["n_a"] }), /already is Low GFR ⟹ Retained urea/);
	});

	it("rejects a connection the graph would drop as redundant", () => {
		// n_a ⟹ n_b and n_b ⟹ n_c exist, so [n_a, n_b] ⟹ n_c adds nothing.
		const m = memory(
			[node("n_a", "A"), node("n_b", "B"), node("n_c", "C")],
			[chain("arg_1", ["n_a"], "n_b"), chain("arg_2", ["n_b"], "n_c")],
		);
		const plan = planOrganizerChanges(m.state.nodes, m.state.chains, [{ op: "add_connection", premises: ["n_a", "n_b"], conclusion: "n_c" }], opts);
		assert.ok(!plan.ok);
		assert.match(plan.problems[0]!, /already implied by other connections/);
	});

	it("rejects using a new node's ref before it is created, and refs of nothing", () => {
		const m = renal();
		const plan = planOrganizerChanges(
			m.state.nodes,
			m.state.chains,
			[
				{ op: "add_connection", premises: ["n_a"], conclusion: "new1" },
				{ op: "create_node", ref: "new1", name: "Later", statement: "Created second." },
			],
			opts,
		);
		assert.ok(!plan.ok);
		assert.match(plan.problems[0]!, /created later in the set/);
	});
});

// ─── all or nothing ──────────────────────────────────────────────────────────

describe("an invalid set is rejected whole", () => {
	it("applies none of a set when one change is invalid, and reports every problem", () => {
		const m = renal();
		const result = apply(m, [
			{ op: "rename_node", nodeId: "n_c", name: "Fine rename" },
			{ op: "set_tags", nodeId: "n_a", systems: ["nephrology"] },
			{ op: "remove_connection", chainId: "arg_nope" },
		]);
		assert.ok(!result.ok);
		assert.equal(result.problems.length, 2);
		assert.match(result.problems[0]!, /^Change 2 \(set tags\)/);
		assert.match(result.problems[1]!, /^Change 3 \(remove connection\)/);
		assert.equal(m.state.rewrites, 0, "the ledgers were not touched");
		assert.equal(graphOf(m).nodes.find((n) => n.id === "n_c")!.name, "Uraemia");
		assert.equal(m.history.read().length, 0, "nothing is journalled");
	});

	it("a later change in the set sees the earlier ones (rename then duplicate-name statement check)", () => {
		const m = renal();
		const result = apply(m, [
			{ op: "edit_node", nodeId: "n_c", statement: "Uraemia is a syndrome." },
			{ op: "create_node", ref: "x", name: "Again", statement: "Uraemia is a syndrome." },
		]);
		assert.ok(!result.ok);
		assert.match(result.problems[0]!, /already has this statement on node n_c/);
	});

	it("re-checks against the graph as it is NOW: a node removed after the proposal fails the apply", () => {
		const m = renal();
		const changes: RawOrganizerChange[] = [{ op: "rename_node", nodeId: "n_c", name: "Renamed" }];
		assert.ok(planOrganizerChanges(m.state.nodes, m.state.chains, changes, opts).ok);
		m.state.nodes = m.state.nodes.filter((n) => n.id !== "n_c"); // the learner deleted it meanwhile
		const result = apply(m, changes);
		assert.ok(!result.ok);
		assert.match(result.problems[0]!, /not a node in the graph/);
	});

	it("an empty or oversize set is refused", () => {
		const m = renal();
		assert.ok(!apply(m, []).ok);
		assert.ok(!apply(m, Array.from({ length: 41 }, () => ({ op: "rename_node", nodeId: "n_c", name: "X" }))).ok);
	});
});

// ─── undo ────────────────────────────────────────────────────────────────────

describe("undo", () => {
	const SET: RawOrganizerChange[] = [
		{ op: "create_node", ref: "new1", name: "Hyperkalaemia", statement: "Potassium is raised.", systems: ["renal"] },
		{ op: "rename_node", nodeId: "n_c", name: "Uraemic syndrome" },
		{ op: "edit_node", nodeId: "n_b", statement: "Urea is retained when GFR falls." },
		{ op: "set_tags", nodeId: "n_d", systems: ["gi"], factType: "memorise" },
		{ op: "add_connection", premises: ["n_a"], conclusion: "new1" },
		{ op: "change_connection", chainId: "arg_1", conclusion: "n_c" },
	];

	it("restores both ledgers exactly, line for line", () => {
		const m = renal();
		const nodesBefore = JSON.stringify(m.state.nodes);
		const chainsBefore = JSON.stringify(m.state.chains);
		const applied = apply(m, SET);
		assert.ok(applied.ok);
		assert.notEqual(JSON.stringify(m.state.nodes), nodesBefore);
		const undone = undoOrganizerEntry(m.deps, applied.entry.id, { now: "2026-11-04T11:00:00.000Z" });
		assert.ok(undone.ok);
		assert.equal(JSON.stringify(m.state.nodes), nodesBefore);
		assert.equal(JSON.stringify(m.state.chains), chainsBefore);
		assert.equal(m.history.read()[0]!.undoneAt, "2026-11-04T11:00:00.000Z");
	});

	it("only the newest applied set can be undone, and only once", () => {
		const m = renal();
		const first = apply(m, [{ op: "rename_node", nodeId: "n_c", name: "One" }]);
		const second = apply(m, [{ op: "rename_node", nodeId: "n_c", name: "Two" }]);
		assert.ok(first.ok && second.ok);
		const items = organizerHistoryItems(m.history.read());
		assert.deepEqual(items.map((i) => [i.summary, i.canUndo]), [["test set", true], ["test set", false]]);

		const early = undoOrganizerEntry(m.deps, first.entry.id);
		assert.ok(!early.ok && early.code === "not_latest");
		assert.ok(undoOrganizerEntry(m.deps, second.entry.id).ok);
		const again = undoOrganizerEntry(m.deps, second.entry.id);
		assert.ok(!again.ok && again.code === "already_undone");
		// With the newest undone, the earlier one is now the newest live set.
		assert.ok(undoOrganizerEntry(m.deps, first.entry.id).ok);
		assert.equal(graphOf(m).nodes.find((n) => n.id === "n_c")!.name, "Uraemia");
		const missing = undoOrganizerEntry(m.deps, "org_nope");
		assert.ok(!missing.ok && missing.code === "not_found");
	});

	it("keeps work done since: a session's later nodes survive undoing an earlier organizer set", () => {
		const m = renal();
		const applied = apply(m, [{ op: "rename_node", nodeId: "n_c", name: "Uraemic syndrome" }]);
		assert.ok(applied.ok);
		m.state.nodes.push(node("n_late", "Late node")); // an extraction appended it afterwards
		assert.ok(undoOrganizerEntry(m.deps, applied.entry.id).ok);
		assert.ok(graphOf(m).nodes.some((n) => n.id === "n_late"));
		assert.equal(graphOf(m).nodes.find((n) => n.id === "n_c")!.name, "Uraemia");
	});

	it("refuses, changing nothing, when the lines were edited since", () => {
		const m = renal();
		const applied = apply(m, [{ op: "rename_node", nodeId: "n_c", name: "Uraemic syndrome" }]);
		assert.ok(applied.ok);
		m.state.nodes = m.state.nodes.map((n) => (n.id === "n_c" ? { ...n, name: "Changed by someone else" } : n));
		const snapshot = JSON.stringify(m.state.nodes);
		const rewrites = m.state.rewrites;
		const undone = undoOrganizerEntry(m.deps, applied.entry.id);
		assert.ok(!undone.ok && undone.code === "conflict");
		assert.equal(JSON.stringify(m.state.nodes), snapshot);
		assert.equal(m.state.rewrites, rewrites);
		assert.equal(m.history.read()[0]!.undoneAt, undefined, "still undoable later");
	});

	it("refuses when something now uses a node the set created", () => {
		const m = renal();
		const applied = apply(m, [{ op: "create_node", ref: "new1", name: "Hyperkalaemia", statement: "Potassium is raised." }]);
		assert.ok(applied.ok);
		const created = applied.entry.createdNodeIds[0]!;
		m.state.chains.push(chain("arg_later", [created], "n_c")); // a later session built on it
		const undone = undoOrganizerEntry(m.deps, applied.entry.id);
		assert.ok(!undone.ok && undone.code === "conflict");
		assert.match(undone.reason, /uses a node/);
		assert.ok(graphOf(m).nodes.some((n) => n.id === created));
	});

	it("refuses when putting a removed connection back would orphan it", () => {
		const m = renal();
		const applied = apply(m, [{ op: "remove_connection", chainId: "arg_1" }]);
		assert.ok(applied.ok);
		m.state.nodes = m.state.nodes.filter((n) => n.id !== "n_b"); // the learner deleted a node since
		const undone = undoOrganizerEntry(m.deps, applied.entry.id);
		assert.ok(!undone.ok && undone.code === "conflict");
		assert.match(undone.reason, /without one of its nodes/);
	});

	it("history is capped at 20 sets", () => {
		const m = renal();
		for (let i = 0; i < 22; i++) {
			assert.ok(apply(m, [{ op: "rename_node", nodeId: "n_c", name: `Name ${i}` }]).ok);
		}
		assert.equal(m.history.read().length, 20);
	});
});

// ─── the journal's file ──────────────────────────────────────────────────────

describe("the history file", () => {
	it("round-trips entries, reads a missing or damaged file as empty, and drops malformed entries", async () => {
		const fs = await import("node:fs");
		const os = await import("node:os");
		const path = await import("node:path");
		const { createOrganizerHistoryStore } = await import("../src/store/organizer-history.ts");
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "organizer-history-"));
		try {
			const file = path.join(dir, "nested", "organizer-history.json");
			const store = createOrganizerHistoryStore(file);
			assert.deepEqual(store.read(), []);
			const m = renal();
			const applied = apply(m, [{ op: "rename_node", nodeId: "n_c", name: "Uraemic syndrome" }]);
			assert.ok(applied.ok);
			store.write([applied.entry]);
			assert.deepEqual(store.read(), [applied.entry]);
			fs.writeFileSync(file, JSON.stringify([applied.entry, { id: "bad" }]));
			assert.deepEqual(store.read(), [applied.entry]);
			fs.writeFileSync(file, "{not json");
			assert.deepEqual(store.read(), []);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
