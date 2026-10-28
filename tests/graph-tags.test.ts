/**
 * Medical tags on graph nodes (docs/medical-spec.md Phase 4): the shared value
 * lists and sanitizers, the ledger semantics (first assignment sticks, the
 * learner's edit overrides, back-fill only fills), backward compatibility with
 * an untagged ledger, and the PATCH / back-fill routes against a throwaway
 * copy of the golden data dir.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// The routes below read the stores through the LH_DATA_DIR seam — set it
// BEFORE any config-loading import (every app-module import is dynamic).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-graph-tags-"));
fs.cpSync(path.join(HERE, "fixtures", "golden-data"), TMP, { recursive: true });
process.env.LH_DATA_DIR = TMP;

const contracts = await import("../src/core/contracts.ts");
const {
	FACT_TYPES,
	ORGAN_SYSTEMS,
	isUntagged,
	sanitizeFactType,
	sanitizeSystems,
} = contracts;
type GraphNode = import("../src/core/contracts.ts").GraphNode;
const { editNodeTags, fillNodeTags, getGraph, mergeFindings, graphSnapshot } = await import("../src/core/graph.ts");
const { deleteChatTraces } = await import("../src/core/graph-deletion.ts");
const { graphStore } = await import("../src/store/graph.ts");
const { chatStore } = await import("../src/store/chats.ts");
type GraphStore = import("../src/core/ports.ts").GraphStore;

/** An in-memory GraphStore: just the node/chain/coverage ledgers. */
function memoryStore(initial: GraphNode[] = []) {
	const nodes: GraphNode[] = [...initial];
	const chains: import("../src/core/contracts.ts").GraphChain[] = [];
	const coverage: import("../src/core/contracts.ts").CoverageEntry[] = [];
	const checkpoints: import("../src/core/contracts.ts").SessionCheckpoint[] = [];
	return {
		appendNode: (n) => void nodes.push(n),
		readNodes: () => nodes.map((n) => ({ ...n })),
		appendChain: (c) => void chains.push(c),
		readChains: () => chains.map((c) => ({ ...c })),
		appendCheckpoint: (c) => void checkpoints.push(c),
		readCheckpoints: () => [...checkpoints],
		appendCoverage: (e) => void coverage.push(e),
		readCoverage: () => [...coverage],
		upsertSource: () => {},
		readSources: () => [],
		appendSourceUsage: () => {},
		readPositions: () => ({}),
		writePositions: () => {},
		rewriteLedgers: (next) => {
			if (next.nodes) nodes.splice(0, nodes.length, ...next.nodes);
			if (next.chains) chains.splice(0, chains.length, ...next.chains);
			if (next.coverage) coverage.splice(0, coverage.length, ...next.coverage);
			if (next.checkpoints) checkpoints.splice(0, checkpoints.length, ...next.checkpoints);
		},
	} satisfies GraphStore;
}

const line = (over: Partial<GraphNode> & { id: string }): GraphNode => ({
	name: "Node",
	statement: "A true statement.",
	aliases: [],
	createdAt: "2026-10-01T00:00:00.000Z",
	provenance: [{ chatId: "chat_a", messageId: "m1" }],
	...over,
});

describe("the shared value lists", () => {
	it("hold the spec's 13 organ systems and 5 fact types, with unique ids", () => {
		assert.equal(ORGAN_SYSTEMS.length, 13);
		assert.equal(FACT_TYPES.length, 5);
		assert.equal(new Set(ORGAN_SYSTEMS.map((s) => s.id)).size, 13);
		assert.equal(new Set(FACT_TYPES.map((t) => t.id)).size, 5);
	});

	it("sanitizeSystems maps ids and labels in any case, dedupes, orders by the list, drops unknowns", () => {
		assert.deepEqual(sanitizeSystems(["endocrine", "Renal/Urinary", "ENDOCRINE", "nonsense", 7]), ["renal", "endocrine"]);
		assert.deepEqual(sanitizeSystems(["GI/Hepatobiliary", "Haematology/Oncology"]), ["gi", "haem-onc"]);
		assert.deepEqual(sanitizeSystems("cardiovascular"), [], "a non-array is no systems");
		assert.deepEqual(sanitizeSystems(undefined), []);
	});

	it("sanitizeFactType maps ids and labels, and drops unknowns", () => {
		assert.equal(sanitizeFactType("management"), "management");
		assert.equal(sanitizeFactType("Clinical feature"), "clinical-feature");
		assert.equal(sanitizeFactType("Diagnosis/investigation"), "diagnosis");
		assert.equal(sanitizeFactType("treatment"), undefined);
		assert.equal(sanitizeFactType(3), undefined);
	});

	it("isUntagged is true while either tag is missing", () => {
		assert.equal(isUntagged({}), true);
		assert.equal(isUntagged({ systems: ["renal"] }), true);
		assert.equal(isUntagged({ factType: "mechanism" }), true);
		assert.equal(isUntagged({ systems: ["renal"], factType: "mechanism" }), false);
	});
});

describe("getGraph — tag semantics over the append-only node lines", () => {
	it("a legacy untagged ledger reads exactly as before: no tag keys appear", () => {
		const store = memoryStore([line({ id: "n_1" }), line({ id: "n_1", statement: "Another phrasing." })]);
		const [node] = getGraph(store).nodes;
		assert.ok(!("systems" in node!) && !("factType" in node!) && !("tagsEdited" in node!));
		assert.deepEqual(node!.aliases, ["Another phrasing."]);
	});

	it("FIRST ASSIGNMENT STICKS: a later link-append never replaces a tag, but fills a missing one", () => {
		const store = memoryStore([
			line({ id: "n_1", systems: ["renal"] }),
			line({ id: "n_1", systems: ["cardiovascular"], factType: "management", statement: "again" }),
		]);
		const [node] = getGraph(store).nodes;
		assert.deepEqual(node!.systems, ["renal"], "the first systems stand");
		assert.equal(node!.factType, "management", "the missing fact type was filled by the later line");
	});

	it("the learner's edit REPLACES both tags, the latest edit wins, and later extraction lines cannot fill over it", () => {
		const store = memoryStore([
			line({ id: "n_1", systems: ["renal"], factType: "mechanism" }),
			line({ id: "n_1", name: "", statement: "", provenance: [], systems: ["endocrine", "renal"], tagsEdited: true }),
		]);
		let [node] = getGraph(store).nodes;
		assert.deepEqual(node!.systems, ["renal", "endocrine"], "read back in list order");
		assert.equal(node!.factType, undefined, "an edit that left the type out cleared it");
		assert.ok(!("tagsEdited" in node!), "the edit marker never reaches the merged node");
		store.appendNode(line({ id: "n_1", factType: "management" }));
		[node] = getGraph(store).nodes;
		assert.equal(node!.factType, undefined, "a later extraction line must not refill an edited node");
		store.appendNode(line({ id: "n_1", name: "", statement: "", provenance: [], factType: "diagnosis", tagsEdited: true }));
		[node] = getGraph(store).nodes;
		assert.equal(node!.factType, "diagnosis");
		assert.equal(node!.systems, undefined, "the second edit replaced the systems too (cleared)");
	});

	it("unknown stored tag values are dropped, never fatal", () => {
		const store = memoryStore([line({ id: "n_1", systems: ["cardio", "renal"] as never, factType: "bogus" as never })]);
		const [node] = getGraph(store).nodes;
		assert.deepEqual(node!.systems, ["renal"]);
		assert.equal(node!.factType, undefined);
	});

	it("an edit line adds no alias and no provenance (it names the node only)", () => {
		const store = memoryStore([line({ id: "n_1" })]);
		const tags = editNodeTags(store, "n_1", { systems: ["renal"], factType: "management" });
		assert.deepEqual(tags, { systems: ["renal"], factType: "management" });
		const [node] = getGraph(store).nodes;
		assert.deepEqual(node!.aliases, []);
		assert.deepEqual(node!.provenance, [{ chatId: "chat_a", messageId: "m1" }]);
		assert.equal(editNodeTags(store, "n_missing", { systems: [] }), null);
	});
});

describe("mergeFindings — the extractor's tags reach the ledger", () => {
	const deps = (store: GraphStore) => ({ graphStore: store, chatStore: {} as never });
	const source = { foldedAt: "2026-10-01T00:00:00.000Z" };

	it("stamps tags on a created node, omits the keys when there are none", () => {
		const store = memoryStore();
		mergeFindings(
			"chat_a",
			{
				propositions: [
					{ id: "p1", name: "ACE inhibitors", statement: "ACE inhibitors reduce proteinuria.", aliases: [], systems: ["renal", "cardiovascular"], factType: "management" },
					{ id: "p2", name: "Plain", statement: "No tags here.", aliases: [] },
				],
				chains: [],
			},
			{ links: [] },
			deps(store),
			source,
		);
		const [tagged, plain] = store.readNodes();
		assert.deepEqual(tagged!.systems, ["cardiovascular", "renal"], "stored in list order");
		assert.equal(tagged!.factType, "management");
		assert.ok(!("systems" in plain!) && !("factType" in plain!));
	});

	it("a link-append carries its tags, but only fills what the node lacks", () => {
		const store = memoryStore();
		mergeFindings("chat_a", { propositions: [{ id: "p1", name: "X", statement: "X is true.", aliases: [], systems: ["renal"] }], chains: [] }, { links: [] }, deps(store), source);
		const id = store.readNodes()[0]!.id;
		mergeFindings(
			"chat_b",
			{ propositions: [{ id: "p1", name: "X2", statement: "X holds.", aliases: [], systems: ["gi"], factType: "mechanism" }], chains: [] },
			{ links: [{ id: "p1", linkTo: id }] },
			deps(store),
			source,
		);
		const [node] = getGraph(store).nodes;
		assert.deepEqual(node!.systems, ["renal"], "first assignment stuck");
		assert.equal(node!.factType, "mechanism", "the missing fact type was filled");
		assert.equal(node!.name, "X");
	});
});

describe("fillNodeTags — the back-fill write", () => {
	it("fills only missing tags, skips unknown ids and empty answers, counts nodes that gained a tag", () => {
		const store = memoryStore([
			line({ id: "n_1" }),
			line({ id: "n_2", systems: ["renal"], factType: "mechanism" }),
			line({ id: "n_3", systems: ["renal"] }),
		]);
		const tagged = fillNodeTags(store, [
			{ id: "n_1", systems: ["Cardiovascular"], factType: "Management" },
			{ id: "n_2", systems: ["gi"], factType: "diagnosis" }, // already fully tagged — untouched
			{ id: "n_3", systems: ["gi"], factType: "diagnosis" }, // keeps systems, gains the type
			{ id: "n_ghost", systems: ["gi"] },
			{ id: "n_1", systems: [] },
		]);
		assert.equal(tagged, 2);
		const byId = new Map(getGraph(store).nodes.map((n) => [n.id, n]));
		assert.deepEqual(byId.get("n_1")!.systems, ["cardiovascular"]);
		assert.equal(byId.get("n_1")!.factType, "management");
		assert.deepEqual(byId.get("n_2")!.systems, ["renal"]);
		assert.equal(byId.get("n_2")!.factType, "mechanism");
		assert.deepEqual(byId.get("n_3")!.systems, ["renal"]);
		assert.equal(byId.get("n_3")!.factType, "diagnosis");
	});

	it("is a no-op the second time (idempotent)", () => {
		const store = memoryStore([line({ id: "n_1" })]);
		fillNodeTags(store, [{ id: "n_1", systems: ["renal"], factType: "mechanism" }]);
		const before = store.readNodes().length;
		assert.equal(fillNodeTags(store, [{ id: "n_1", systems: ["gi"], factType: "diagnosis" }]), 0);
		assert.equal(store.readNodes().length, before, "nothing appended");
	});
});

describe("chat deletion keeps a surviving node's tag edit", () => {
	it("the edit line has no provenance of its own and rides through delete-nodes untouched", () => {
		const store = memoryStore([
			line({ id: "n_1", provenance: [{ chatId: "chat_a", messageId: "" }, { chatId: "chat_b", messageId: "" }] }),
		]);
		editNodeTags(store, "n_1", { systems: ["renal"], factType: "management" });
		deleteChatTraces(store, "chat_a", "delete-nodes");
		const [node] = getGraph(store).nodes;
		assert.deepEqual(node!.systems, ["renal"]);
		assert.equal(node!.factType, "management");
		assert.deepEqual(node!.provenance, [{ chatId: "chat_b", messageId: "" }]);
	});
});

describe("backward compatibility with the owner's stored graph (golden data)", () => {
	const nodesFile = path.join(TMP, "graph", "nodes.jsonl");

	it("the golden graph loads unchanged: no node gains a tag or marker, every node counts as untagged", () => {
		const graph = getGraph(graphStore);
		assert.ok(graph.nodes.length > 100);
		for (const node of graph.nodes) {
			assert.ok(!("systems" in node) && !("factType" in node) && !("tagsEdited" in node));
			assert.equal(isUntagged(node), true);
		}
		const snap = graphSnapshot({ graphStore, chatStore });
		assert.equal(snap.propositions.length, graph.nodes.length);
	});

	it("PATCH appends one line and leaves every existing byte of the ledger as it was", async () => {
		const { PATCH } = await import("../app/api/graph/nodes/[id]/route.ts");
		const before = fs.readFileSync(nodesFile, "utf-8");
		const id = getGraph(graphStore).nodes[0]!.id;
		const patch = (body: unknown) =>
			PATCH(new Request("http://localhost/api/graph/nodes/x", { method: "PATCH", body: JSON.stringify(body) }), {
				params: Promise.resolve({ id }),
			});

		const ok = await patch({ systems: ["Renal/Urinary", "endocrine"], factType: "management" });
		assert.equal(ok.status, 200);
		const payload = (await ok.json()) as { tags: { systems: string[]; factType: string } };
		assert.deepEqual(payload.tags, { systems: ["renal", "endocrine"], factType: "management" });

		const after = fs.readFileSync(nodesFile, "utf-8");
		assert.ok(after.startsWith(before), "the old ledger content is a byte-for-byte prefix");
		assert.equal(after.slice(before.length).trim().split("\n").length, 1, "exactly one line was appended");
		const node = getGraph(graphStore).nodes.find((n) => n.id === id)!;
		assert.deepEqual(node.systems, ["renal", "endocrine"]);
		assert.equal(node.factType, "management");

		// Clearing: empty list + null.
		const cleared = await patch({ systems: [], factType: null });
		assert.equal(cleared.status, 200);
		const again = getGraph(graphStore).nodes.find((n) => n.id === id)!;
		assert.ok(isUntagged(again));
		assert.equal(again.systems, undefined);
	});

	it("PATCH is strict at the door: unknown tags and shapes are 400, an unknown node is 404", async () => {
		const { PATCH } = await import("../app/api/graph/nodes/[id]/route.ts");
		const id = getGraph(graphStore).nodes[1]!.id;
		const call = (nodeId: string, raw: string) =>
			PATCH(new Request("http://localhost/x", { method: "PATCH", body: raw }), { params: Promise.resolve({ id: nodeId }) });
		const sizeBefore = fs.statSync(nodesFile).size;
		assert.equal((await call(id, "not json")).status, 400);
		assert.equal((await call(id, JSON.stringify({ systems: "renal" }))).status, 400);
		assert.equal((await call(id, JSON.stringify({ systems: ["heart"], factType: null }))).status, 400);
		assert.equal((await call(id, JSON.stringify({ systems: [], factType: "treatment" }))).status, 400);
		assert.equal((await call("n_nope", JSON.stringify({ systems: [], factType: null }))).status, 404);
		assert.equal(fs.statSync(nodesFile).size, sizeBefore, "rejected edits write nothing");
	});
});

process.on("exit", () => fs.rmSync(TMP, { recursive: true, force: true }));
