/**
 * The one-time drug back-fill (src/server/pharmacology-backfill.ts): existing
 * drug facts are upgraded to the pharmacology type (the one override of "first
 * assignment sticks"), a learner's own tag edit is never touched, the pass is
 * resumable and runs once, and a missing model or a failing batch just waits.
 * The model is a local fake; nothing here calls a provider.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { GraphNode } from "../src/core/contracts.ts";
import { ModelsNotConfiguredError } from "../src/core/settings.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-pharm-backfill-"));
process.env.LH_DATA_DIR = TMP_DATA;
const { getGraph, upgradeToPharmacology, editNodeTags, tagLine } = await import("../src/core/graph.ts");
const { createPharmacologyBackfill, newPharmacologyBackfillRuntime } = await import("../src/server/pharmacology-backfill.ts");
after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const T0 = "2026-11-08T10:00:00.000Z";
const node = (id: string, over: Partial<GraphNode> = {}): GraphNode => ({
	id,
	name: id,
	statement: `${id} is true.`,
	aliases: [],
	createdAt: T0,
	provenance: [{ chatId: "c1", messageId: "m1" }],
	...over,
});

function memoryGraph(initial: GraphNode[]) {
	const lines = [...initial];
	return {
		lines,
		readNodes: () => lines,
		readChains: () => [],
		appendNode: (n: GraphNode) => void lines.push(n),
	};
}

describe("upgradeToPharmacology (the sanctioned override)", () => {
	it("overrides an earlier fact type, only to pharmacology", () => {
		const g = memoryGraph([node("n_1", { factType: "mechanism", systems: ["gi"] }), node("n_2", { factType: "management" })]);
		assert.deepEqual(upgradeToPharmacology(g, ["n_1"]), ["n_1"]);
		const nodes = getGraph(g).nodes;
		assert.equal(nodes.find((n) => n.id === "n_1")!.factType, "pharmacology");
		assert.deepEqual(nodes.find((n) => n.id === "n_1")!.systems, ["gi"], "systems are left as they were");
		assert.equal(nodes.find((n) => n.id === "n_2")!.factType, "management");
	});

	it("an upgrade line for any other value is just a normal fill, never an override", () => {
		const g = memoryGraph([node("n_1", { factType: "mechanism" })]);
		g.appendNode(tagLine(getGraph(g).nodes[0]!, { factType: "management" }, false, { upgrade: true }));
		assert.equal(getGraph(g).nodes[0]!.factType, "mechanism");
	});

	it("never touches a node whose tags the learner edited, nor a later learner edit", () => {
		const g = memoryGraph([node("n_1", { factType: "management" })]);
		editNodeTags(g as never, "n_1", { systems: ["gi"], factType: "management" });
		assert.deepEqual(upgradeToPharmacology(g, ["n_1"]), []);
		assert.equal(getGraph(g).nodes[0]!.factType, "management");

		const h = memoryGraph([node("n_2", { factType: "mechanism" })]);
		upgradeToPharmacology(h, ["n_2"]);
		editNodeTags(h as never, "n_2", { factType: "mechanism" });
		assert.equal(getGraph(h).nodes[0]!.factType, "mechanism", "the learner's later edit wins");
	});

	it("skips unknown ids and facts that are already pharmacology (no duplicate lines)", () => {
		const g = memoryGraph([node("n_1", { factType: "pharmacology" })]);
		assert.deepEqual(upgradeToPharmacology(g, ["n_1", "n_missing"]), []);
		assert.equal(g.lines.length, 1);
	});
});

const ENGINE = { model: { provider: "chatgpt" } } as never;

function harness(initial: GraphNode[], opts: { batchSize?: number; engine?: unknown; drugs?: Set<string> } = {}) {
	const g = memoryGraph(initial);
	let progress: { checked: string[]; completedAt?: string } = { checked: [] };
	let clock = 1_000_000;
	let extracting = false;
	const asked: string[][] = [];
	let failNext: Error | null = null;
	const drugs = opts.drugs ?? new Set<string>();
	const svc = createPharmacologyBackfill({
		graphStore: g,
		progress: { read: () => ({ ...progress, checked: [...progress.checked] }), write: (p) => void (progress = { ...p, checked: [...p.checked] }) },
		engine: () => (opts.engine === undefined ? ENGINE : (opts.engine as never)),
		providerKeyMissing: () => false,
		extractionRunning: () => extracting,
		now: () => new Date(clock),
		classify: async ({ nodes }) => {
			asked.push(nodes.map((n) => n.id));
			if (failNext) {
				const e = failNext;
				failNext = null;
				throw e;
			}
			return nodes.filter((n) => drugs.has(n.id)).map((n) => n.id);
		},
		batchSize: opts.batchSize,
		state: newPharmacologyBackfillRuntime(),
	});
	return {
		svc,
		g,
		asked,
		progress: () => ({ ...progress, checked: [...progress.checked] }),
		writeProgress: (p: { checked: string[]; completedAt?: string }) => void (progress = { ...p, checked: [...p.checked] }),
		advance: (ms: number) => void (clock += ms),
		setExtracting: (v: boolean) => void (extracting = v),
		failOnce: (e: Error) => void (failNext = e),
	};
}

describe("the drug back-fill service", () => {
	it("upgrades only what the model calls a drug fact, in batches, then records completion", async () => {
		const h = harness(
			[node("n_1", { factType: "mechanism" }), node("n_2", { factType: "management" }), node("n_3", { factType: "clinical-feature" })],
			{ batchSize: 2, drugs: new Set(["n_1", "n_3"]) },
		);
		const out = await h.svc.run();
		assert.deepEqual(h.asked, [["n_1", "n_2"], ["n_3"]]);
		assert.deepEqual(out, { started: true, looked: 3, upgraded: 2, completed: true });
		const types = Object.fromEntries(getGraph(h.g).nodes.map((n) => [n.id, n.factType]));
		assert.deepEqual(types, { n_1: "pharmacology", n_2: "management", n_3: "pharmacology" });
		assert.ok(h.progress().completedAt);
	});

	it("is one-time: after completion it never asks again, even for new facts", async () => {
		const h = harness([node("n_1", { factType: "mechanism" })], { drugs: new Set(["n_1"]) });
		await h.svc.run();
		h.g.lines.push(node("n_9", { factType: "mechanism" }));
		assert.deepEqual(await h.svc.run(), { started: false, reason: "done" });
		assert.equal(h.asked.length, 1);
	});

	it("is resumable: a failed batch keeps what landed and the next pass asks only the rest", async () => {
		const h = harness([node("n_1", { factType: "mechanism" }), node("n_2", { factType: "mechanism" })], { batchSize: 1, drugs: new Set(["n_1", "n_2"]) });
		// The first batch (n_1) succeeds; the second call throws.
		let calls = 0;
		const svc = createPharmacologyBackfill({
			graphStore: h.g,
			progress: { read: () => h.progress(), write: (p) => h.writeProgress(p) },
			engine: () => ENGINE,
			providerKeyMissing: () => false,
			extractionRunning: () => false,
			now: () => new Date(1_000_000),
			classify: async ({ nodes }) => {
				calls++;
				if (calls === 2) throw new Error("boom");
				return nodes.map((n) => n.id);
			},
			batchSize: 1,
			state: newPharmacologyBackfillRuntime(),
		});
		const first = await svc.run();
		assert.ok(first.started && first.error === "boom");
		assert.deepEqual(h.progress().checked, ["n_1"], "the landed batch is recorded");
		assert.equal(h.progress().completedAt, undefined);
		assert.equal(getGraph(h.g).nodes.find((n) => n.id === "n_1")!.factType, "pharmacology");
		assert.equal(svc.state.failures, 1);
		assert.ok(svc.state.retryAt! > 1_000_000, "a failure backs off");
		svc.state.retryAt = undefined;
		const second = await svc.run();
		assert.ok(second.started && second.completed);
		assert.equal(calls, 3, "only the unchecked fact was asked again");
		assert.deepEqual(getGraph(h.g).nodes.map((n) => n.factType), ["pharmacology", "pharmacology"]);
	});

	it("never asks about, or changes, facts the learner tagged or that are already pharmacology", async () => {
		const g1 = node("n_1", { factType: "management" });
		const h = harness([g1, node("n_2", { factType: "pharmacology" }), node("n_3", { factType: "mechanism" })], { drugs: new Set(["n_1", "n_3"]) });
		editNodeTags(h.g as never, "n_1", { systems: ["gi"], factType: "management" });
		await h.svc.run();
		assert.deepEqual(h.asked, [["n_3"]], "only the untouched fact is asked");
		const types = Object.fromEntries(getGraph(h.g).nodes.map((n) => [n.id, n.factType]));
		assert.equal(types.n_1, "management");
		assert.equal(types.n_3, "pharmacology");
	});

	it("waits quietly with no model, and while extraction is running", async () => {
		const noModel = harness([node("n_1", { factType: "mechanism" })], { engine: null });
		assert.deepEqual(await noModel.svc.run(), { started: false, reason: "no-model" });
		assert.equal(noModel.progress().checked.length, 0);

		const busy = harness([node("n_1", { factType: "mechanism" })]);
		busy.setExtracting(true);
		busy.svc.tick();
		await new Promise((r) => setImmediate(r));
		assert.equal(busy.asked.length, 0, "no pass while an extraction run is in flight");
	});

	it("a model-not-configured error is a wait, not a failure", async () => {
		const h = harness([node("n_1", { factType: "mechanism" })]);
		h.failOnce(new ModelsNotConfiguredError(["cheap"] as never));
		const out = await h.svc.run();
		assert.ok(out.started && !out.error);
		assert.equal(h.svc.state.failures, 0);
	});
});

describe("the progress file and the classifier's brief", () => {
	it("round-trips progress through the real store and starts empty", async () => {
		const { createPharmacologyBackfillStore } = await import("../src/store/pharmacology-backfill.ts");
		const store = createPharmacologyBackfillStore(path.join(TMP_DATA, "graph", "pharm-test.json"));
		assert.deepEqual(store.read(), { checked: [] });
		store.write({ checked: ["n_1", "n_2"] });
		assert.deepEqual(store.read(), { checked: ["n_1", "n_2"] });
		store.write({ checked: ["n_1"], completedAt: T0 });
		assert.deepEqual(store.read(), { checked: ["n_1"], completedAt: T0 });
	});

	it("the classifier is told to include only facts clearly about a drug itself, and to leave doubtful ones out", async () => {
		const { DRUG_CLASSIFIER_INSTRUCTIONS } = await import("../src/agent/subagents/tagger.ts");
		assert.ok(DRUG_CLASSIFIER_INSTRUCTIONS.includes("CLEARLY about a drug itself"));
		assert.ok(DRUG_CLASSIFIER_INSTRUCTIONS.includes("When in doubt, leave the node out"));
		assert.ok(DRUG_CLASSIFIER_INSTRUCTIONS.includes("choice of\ntreatment") || DRUG_CLASSIFIER_INSTRUCTIONS.includes("choice of treatment"));
	});
});
