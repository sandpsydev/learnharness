/**
 * The placement service (src/server/placement.ts): automatic placement of new
 * facts and the one-time back-fill — batching, resumability, idempotence, the
 * learner's placement never overridden, revert, and the quiet waiting states.
 * The model is a local fake; nothing here calls a provider.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { GraphNode, PlacerRun } from "../src/core/contracts.ts";
import type { PlacementLine } from "../src/core/contracts/placement.ts";
import { derivePlacements, type PlacerProposal } from "../src/core/placement.ts";
import type { PlacementStore, PlacerJournalStore } from "../src/core/ports.ts";
import { ModelsNotConfiguredError } from "../src/core/settings.ts";

// The data seam, BEFORE any config-loading import.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-placement-service-"));
process.env.LH_DATA_DIR = TMP_DATA;
const { createPlacementService, newPlacementState, PLACER_MAX_ATTEMPTS } = await import("../src/server/placement.ts");
after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const T0 = "2026-11-08T10:00:00.000Z";
const node = (id: string, name: string, over: Partial<GraphNode> = {}): GraphNode => ({
	id,
	name,
	statement: `${name} is true.`,
	aliases: [],
	createdAt: T0,
	provenance: [{ chatId: "c1", messageId: "m1" }],
	...over,
});

const ENGINE = { model: { provider: "chatgpt" } } as never;

function harness(initial: GraphNode[], opts: { batchSize?: number; engine?: unknown } = {}) {
	let nodes = [...initial];
	let lines: PlacementLine[] = [];
	let runs: PlacerRun[] = [];
	let revision = 1;
	let clock = 1_000_000;
	let extracting = false;
	const placements: PlacementStore = {
		read: () => [...lines],
		append: (more) => void (lines = [...lines, ...more], revision++),
		rewrite: (next) => void (lines = [...next], revision++),
	};
	const journal: PlacerJournalStore = { read: () => runs.map((r) => ({ ...r })), write: (r) => void (runs = r.map((x) => ({ ...x }))) };
	const asked: string[][] = [];
	let answer: (batch: GraphNode[], topics: { id: string; name: string }[]) => PlacerProposal[] = (batch) =>
		batch.map((n) => ({ nodeId: n.id, system: "gi", newTopic: "Small-bowel obstruction", aspect: "presentation" }));
	let failNext: Error | null = null;
	let beforeAnswer: (() => void) | null = null;
	const service = createPlacementService({
		graphStore: { readNodes: () => nodes, readChains: () => [] },
		placements,
		journal,
		engine: () => (opts.engine === undefined ? ENGINE : (opts.engine as never)),
		providerKeyMissing: () => false,
		extractionRunning: () => extracting,
		revision: () => revision,
		now: () => new Date(clock),
		batchSize: opts.batchSize ?? 2,
		newRunId: (() => {
			let n = 0;
			return () => `run${++n}`;
		})(),
		place: (async ({ nodes: batch, topics }: { nodes: GraphNode[]; topics: { id: string; name: string }[] }) => {
			asked.push(batch.map((n) => n.id));
			beforeAnswer?.();
			if (failNext) {
				const err = failNext;
				failNext = null;
				throw err;
			}
			return answer(batch, topics);
		}) as never,
		state: newPlacementState(),
	});
	return {
		service,
		asked,
		get lines() {
			return lines;
		},
		get runs() {
			return runs;
		},
		derived: () => derivePlacements(lines),
		addNodes: (more: GraphNode[]) => void (nodes = [...nodes, ...more], revision++),
		advance: (ms: number) => void (clock += ms),
		setAnswer: (fn: typeof answer) => void (answer = fn),
		failOnce: (err: Error) => void (failNext = err),
		beforeAnswer: (fn: () => void) => void (beforeAnswer = fn),
		setExtracting: (on: boolean) => void (extracting = on),
		placements,
	};
}

const five = () => ["a", "b", "c", "d", "e"].map((c) => node(`n_${c}`, `Fact ${c}`));

describe("the back-fill", () => {
	it("places every existing fact in batches, reusing one canonical topic across batches", async () => {
		const h = harness(five());
		const out = await h.service.runPass();
		assert.deepEqual(h.asked, [["n_a", "n_b"], ["n_c", "n_d"], ["n_e"]]);
		assert.ok(out.started && out.placed === 5);
		const d = h.derived();
		assert.equal(d.byNode.size, 5);
		// The fake keeps naming "Small-bowel obstruction": one topic, not three.
		assert.equal(d.topics.size, 1);
		assert.equal(h.service.status().unplaced, 0);
		assert.equal(h.runs.length, 1);
		assert.equal(h.runs[0]!.kind, "backfill");
		assert.equal(h.runs[0]!.placed, 5);
	});

	it("shows the model the topics minted by earlier batches", async () => {
		const h = harness(five());
		const seen: string[][] = [];
		h.setAnswer((batch, topics) => {
			seen.push(topics.map((t) => t.name));
			return batch.map((n) => ({ nodeId: n.id, system: "gi", newTopic: "Acute pancreatitis", aspect: "workup" }));
		});
		await h.service.runPass();
		assert.deepEqual(seen, [[], ["Acute pancreatitis"], ["Acute pancreatitis"]]);
	});

	it("is resumable: a failed batch stops the pass, what landed stays, and the next pass continues from there", async () => {
		const h = harness(five());
		let calls = 0;
		h.setAnswer((batch) => {
			calls++;
			return batch.map((n) => ({ nodeId: n.id, system: "gi", newTopic: "Ileus", aspect: "other" }));
		});
		// Batch 1 succeeds; batch 2 fails.
		h.beforeAnswer(() => {
			if (calls === 1) h.failOnce(new Error("provider hiccup"));
		});
		const first = await h.service.runPass();
		assert.ok(first.started && first.error === "provider hiccup");
		assert.equal(h.derived().byNode.size, 2, "the first batch stays placed");
		assert.equal(h.service.status().problem, "failed");

		h.beforeAnswer(() => {});
		const second = await h.service.runPass();
		assert.ok(second.started && second.placed === 3);
		// The already-placed pair was not sent again.
		assert.ok(!h.asked.slice(2).flat().some((id) => id === "n_a" || id === "n_b"));
		assert.equal(h.derived().byNode.size, 5);
	});

	it("is idempotent: a finished back-fill asks the model nothing more", async () => {
		const h = harness(five());
		await h.service.runPass();
		const asked = h.asked.length;
		const again = await h.service.runPass();
		assert.ok(again.started && again.placed === 0);
		assert.equal(h.asked.length, asked);
		assert.equal(h.lines.length, new Set(h.lines.map((l) => JSON.stringify(l))).size, "no duplicate ledger lines");
	});

	it("never overrides a placement the learner made while the model was thinking", async () => {
		const h = harness(five().slice(0, 2));
		h.beforeAnswer(() => {
			// The learner moves n_a under their own topic mid-call.
			h.placements.append([
				{ kind: "topic", id: "t_mine", name: "My topic", system: "renal", createdAt: T0 },
				{ kind: "place", nodeId: "n_a", topicId: "t_mine", aspect: "workup", source: "learner", confidence: "high", at: T0 },
			]);
		});
		await h.service.runPass();
		const d = h.derived();
		assert.equal(d.byNode.get("n_a")?.topicId, "t_mine");
		assert.equal(d.byNode.get("n_a")?.source, "learner");
		assert.equal(d.byNode.get("n_b")?.source, "placer");
	});
});

describe("new facts after an extraction run", () => {
	it("are placed by the next look, with the topics already in the outline offered to the model", async () => {
		const h = harness(five().slice(0, 2));
		await h.service.runPass();
		h.addNodes([node("n_new", "A new fact")]);
		h.setAnswer((batch, topics) => {
			assert.deepEqual(topics.map((t) => t.name), ["Small-bowel obstruction"]);
			const reuse = topics[0]!.id;
			return batch.map((n) => ({ nodeId: n.id, topicId: reuse, aspect: "management" }));
		});
		h.service.tick();
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(h.derived().byNode.get("n_new")?.aspect, "management");
		assert.equal(h.derived().topics.size, 1, "the existing topic was reused, not duplicated");
		assert.equal(h.runs[h.runs.length - 1]!.kind, "new");
	});

	it("waits while an extraction run is in flight, and looks only when the graph has moved", async () => {
		const h = harness(five().slice(0, 2));
		h.setExtracting(true);
		h.service.tick();
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(h.asked.length, 0);
		h.setExtracting(false);
		h.service.tick();
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(h.asked.length, 1);
		h.service.tick(); // nothing moved since: no further call
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(h.asked.length, 1);
	});
});

describe("when the model will not place a fact", () => {
	it("tries again, then parks it in an Unsorted topic marked low — the pass always converges", async () => {
		const h = harness([node("n_x", "Odd fact", { systems: ["renal"] })], { batchSize: 5 });
		h.setAnswer(() => []); // the model skips it every time
		const out = await h.service.runPass();
		assert.ok(out.started);
		assert.equal(h.asked.length, PLACER_MAX_ATTEMPTS, "asked a limited number of times");
		const p = h.derived().byNode.get("n_x")!;
		assert.equal(p.confidence, "low");
		assert.match(h.derived().topics.get(p.topicId)!.name, /^Unsorted/);
		assert.equal(h.derived().topics.get(p.topicId)!.system, "renal");
	});
});

describe("revert", () => {
	it("takes a run back (facts without an earlier place are withdrawn) and keeps them out of the automatic pass", async () => {
		const h = harness(five().slice(0, 3));
		await h.service.runPass();
		const run = h.runs[0]!;
		const out = h.service.revert(run.id);
		assert.ok(out.ok && out.reverted === 3);
		assert.equal(h.derived().byNode.size, 0);
		assert.ok(h.runs[0]!.revertedAt);
		assert.equal(h.service.revert(run.id).ok, false, "a run is reverted once");
		assert.equal(h.service.status().lastRun, undefined);

		// The automatic pass leaves withdrawn facts alone…
		const asked = h.asked.length;
		h.service.tick();
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(h.asked.length, asked);
		// …and an explicit "place again" does them.
		const again = await h.service.runPass({ retryCleared: true });
		assert.ok(again.started && again.placed === 3);
		assert.equal(h.derived().byNode.size, 3);
	});

	it("refuses an unknown run", () => {
		const h = harness([]);
		const out = h.service.revert("nope");
		assert.ok(!out.ok && out.status === 404);
	});
});

describe("waiting quietly", () => {
	it("a missing model or a missing sign-in is a quiet state, not an error", async () => {
		const none = harness(five(), { engine: null });
		const out = await none.service.runPass();
		assert.deepEqual(out, { started: false, reason: "no-model" });
		assert.equal(none.service.status().problem, "no-model");
		assert.equal(none.service.status().unplaced, 5);

		const h = harness(five());
		h.beforeAnswer(() => h.failOnce(new ModelsNotConfiguredError(["cheap"])));
		await h.service.runPass();
		assert.equal(h.service.status().problem, "no-model");
		assert.equal(h.service.status().error, undefined);
	});

	it("a failing model backs off instead of retrying on every look", async () => {
		const h = harness(five().slice(0, 2));
		h.failOnce(new Error("boom"));
		await h.service.runPass();
		const asked = h.asked.length;
		h.service.tick(); // inside the back-off window
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(h.asked.length, asked);
		h.advance(10 * 60_000);
		h.service.tick();
		await new Promise((r) => setTimeout(r, 10));
		assert.ok(h.asked.length > asked);
		assert.equal(h.derived().byNode.size, 2);
	});
});
