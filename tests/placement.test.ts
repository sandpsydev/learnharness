/**
 * Placement core (src/core/placement.ts, store/placements.ts): canonical topic
 * reuse, derivation, applying a placer's answers, reverting a run — over
 * in-memory lines and a temp ledger file. No model.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { PLACEMENT_ASPECTS, sanitizePlacementAspect, type PlacementLine, type PlacementTopic } from "../src/core/contracts/placement.ts";
import {
	applyPlacerProposals,
	derivePlacements,
	fallbackProposal,
	findTopic,
	placementView,
	revertRunLines,
	topicInitials,
	topicKey,
	unplacedNodes,
} from "../src/core/placement.ts";

// The data seam, BEFORE any config-loading import: the stores stamp the graph format dir.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-placement-data-"));
process.env.LH_DATA_DIR = TMP_DATA;
const { createPlacementStore, createPlacerJournalStore, isPlacementLine } = await import("../src/store/placements.ts");
after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const T = "2026-11-08T10:00:00.000Z";
let seq = 0;
const mint = () => `t_${(++seq).toString(16).padStart(12, "0")}`;

const topicLine = (id: string, name: string, system: PlacementTopic["system"]): PlacementLine => ({ kind: "topic", id, name, system, createdAt: T });
const placeLine = (nodeId: string, topicId: string, aspect = "presentation", extra: Partial<PlacementLine> = {}): PlacementLine =>
	({ kind: "place", nodeId, topicId, aspect, source: "placer", confidence: "high", at: T, ...extra }) as PlacementLine;

const SBO = topicLine("t_sbo", "Small-bowel obstruction", "gi");
const AP = topicLine("t_ap", "Acute pancreatitis", "gi");

describe("canonical topics", () => {
	it("treats spelling variants as one topic", () => {
		assert.equal(topicKey("Small-bowel obstruction"), topicKey("small bowel  OBSTRUCTION"));
		assert.equal(topicKey("Café"), topicKey("Cafe"));
		assert.notEqual(topicKey("Ileus"), topicKey("Small-bowel obstruction"));
	});

	it("finds a topic by id, by name in any spelling, and by an unambiguous acronym in the same system", () => {
		const topics: PlacementTopic[] = [
			{ id: "t_sbo", name: "Small-bowel obstruction", system: "gi" },
			{ id: "t_ap", name: "Acute pancreatitis", system: "gi" },
			{ id: "t_mi", name: "Myocardial infarction", system: "cardiovascular" },
			{ id: "t_mr", name: "Mitral regurgitation", system: "cardiovascular" },
		];
		assert.equal(findTopic(topics, "t_sbo")?.id, "t_sbo");
		assert.equal(findTopic(topics, "small bowel obstruction")?.id, "t_sbo");
		assert.equal(findTopic(topics, "SBO", "gi")?.id, "t_sbo");
		assert.equal(findTopic(topics, "SBO")?.id, "t_sbo");
		assert.equal(topicInitials("Small-bowel obstruction"), "sbo");
		// An acronym that two topics share is not guessed at.
		const twin = [...topics, { id: "t_mi2", name: "Mitral insufficiency", system: "cardiovascular" as const }];
		assert.equal(findTopic(twin, "MI", "cardiovascular"), undefined);
		assert.equal(findTopic(topics, "Ileus"), undefined);
		assert.equal(findTopic(topics, "   "), undefined);
	});

	it("maps aspects from ids, labels and the natural phrasings", () => {
		assert.equal(sanitizePlacementAspect("How it develops"), "how-it-develops");
		assert.equal(sanitizePlacementAspect("risk_factors"), "risk-factors");
		assert.equal(sanitizePlacementAspect("Pathophysiology"), "how-it-develops");
		assert.equal(sanitizePlacementAspect("investigations"), "workup");
		assert.equal(sanitizePlacementAspect("nonsense"), undefined);
		assert.equal(PLACEMENT_ASPECTS.length, 7);
	});
});

describe("derivePlacements / placementView", () => {
	it("the latest line for a node wins, a clear withdraws, and unknown topics are ignored", () => {
		const lines = [SBO, AP, placeLine("n1", "t_sbo"), placeLine("n1", "t_ap", "workup"), placeLine("n2", "t_sbo"), { kind: "clear", nodeId: "n2", at: T } as PlacementLine, placeLine("n3", "t_missing")];
		const d = derivePlacements(lines);
		assert.equal(d.byNode.get("n1")?.topicId, "t_ap");
		assert.equal(d.byNode.get("n1")?.aspect, "workup");
		assert.equal(d.byNode.has("n2"), false);
		assert.ok(d.cleared.has("n2"));
		assert.equal(d.byNode.has("n3"), false);
	});

	it("the view carries live nodes only, topics in use only, and counts unplaced and withdrawn", () => {
		const lines = [SBO, AP, placeLine("n1", "t_sbo"), placeLine("gone", "t_ap"), placeLine("n2", "t_sbo"), { kind: "clear", nodeId: "n2", at: T } as PlacementLine];
		const view = placementView(lines, ["n1", "n2", "n3"]);
		assert.deepEqual(Object.keys(view.byNode), ["n1"]);
		assert.deepEqual(view.topics.map((t) => t.id), ["t_sbo"]);
		assert.equal(view.unplaced, 1);
		assert.equal(view.withdrawn, 1);
	});

	it("unplacedNodes leaves withdrawn nodes alone unless asked", () => {
		const nodes = [{ id: "n1" }, { id: "n2" }, { id: "n3" }];
		const lines = [SBO, placeLine("n1", "t_sbo"), { kind: "clear", nodeId: "n2", at: T } as PlacementLine];
		assert.deepEqual(unplacedNodes(nodes, lines).map((n) => n.id), ["n3"]);
		assert.deepEqual(unplacedNodes(nodes, lines, { retryCleared: true }).map((n) => n.id), ["n2", "n3"]);
	});
});

describe("applyPlacerProposals", () => {
	const opts = { runId: "run1", now: T, mintTopicId: mint };

	it("reuses a topic by id, by spelling and by acronym — and mints only a genuinely new one", () => {
		const result = applyPlacerProposals(
			[SBO],
			[
				{ nodeId: "n1", topicId: "t_sbo", system: "gi", aspect: "presentation" },
				{ nodeId: "n2", newTopic: "small bowel obstruction", system: "gi", aspect: "workup" },
				{ nodeId: "n3", newTopic: "SBO", system: "gi", aspect: "management" },
				{ nodeId: "n4", newTopic: "Paralytic ileus", system: "gi", aspect: "how-it-develops" },
				{ nodeId: "n5", newTopic: "Paralytic Ileus", system: "gi", aspect: "complications" },
			],
			opts,
		);
		assert.equal(result.topicsCreated, 1, "only Paralytic ileus is new");
		const lines = [SBO, ...result.lines];
		const d = derivePlacements(lines);
		assert.equal(d.byNode.get("n1")?.topicId, "t_sbo");
		assert.equal(d.byNode.get("n2")?.topicId, "t_sbo");
		assert.equal(d.byNode.get("n3")?.topicId, "t_sbo");
		assert.equal(d.byNode.get("n4")?.topicId, d.byNode.get("n5")?.topicId, "the same new topic within one batch is minted once");
		assert.equal(d.topics.size, 2);
		assert.deepEqual(result.unresolved, []);
	});

	it("ignores the model's system when it names an existing topic", () => {
		const result = applyPlacerProposals([SBO], [{ nodeId: "n1", topicId: "t_sbo", system: "renal" }], opts);
		const d = derivePlacements([SBO, ...result.lines]);
		assert.equal(d.topics.get(d.byNode.get("n1")!.topicId)?.system, "gi");
		assert.equal(result.topicsCreated, 0);
	});

	it("uses the node's own tag as the system when the model's is unusable, and 'general' last", () => {
		const hinted = applyPlacerProposals([], [{ nodeId: "n1", newTopic: "Nephrotic syndrome", system: "kidneys" }], { ...opts, systemHint: () => "renal" });
		assert.equal((hinted.lines[0] as { system: string }).system, "renal");
		const bare = applyPlacerProposals([], [{ nodeId: "n1", newTopic: "Nephrotic syndrome" }], opts);
		assert.equal((bare.lines[0] as { system: string }).system, "general");
	});

	it("an unusable aspect becomes 'other', confidence is kept, and an answer without a topic is unresolved", () => {
		const result = applyPlacerProposals(
			[SBO],
			[
				{ nodeId: "n1", topicId: "t_sbo", aspect: "???", confidence: "low" },
				{ nodeId: "n2", system: "gi", aspect: "workup" },
				{ nodeId: "n3", topicId: "t_nope" },
			],
			opts,
		);
		const d = derivePlacements([SBO, ...result.lines]);
		assert.equal(d.byNode.get("n1")?.aspect, "other");
		assert.equal(d.byNode.get("n1")?.confidence, "low");
		assert.deepEqual(result.unresolved, ["n2", "n3"]);
	});

	it("never overrides an existing placement (the learner's stands) and takes the first answer for a node", () => {
		const existing = [SBO, AP, placeLine("n1", "t_ap", "workup", { source: "learner" })];
		const result = applyPlacerProposals(
			existing,
			[
				{ nodeId: "n1", topicId: "t_sbo" },
				{ nodeId: "n2", topicId: "t_sbo", aspect: "presentation" },
				{ nodeId: "n2", topicId: "t_ap", aspect: "workup" },
			],
			opts,
		);
		assert.deepEqual(result.alreadyPlaced, ["n1"]);
		assert.deepEqual(result.placed, ["n2"]);
		assert.equal(derivePlacements([...existing, ...result.lines]).byNode.get("n2")?.topicId, "t_sbo");
	});

	it("parks a stubborn node in an Unsorted topic of its best-guess system, marked low", () => {
		const result = applyPlacerProposals([], [fallbackProposal({ id: "n9", systems: ["renal"] })], opts);
		const d = derivePlacements(result.lines);
		const p = d.byNode.get("n9")!;
		assert.equal(p.confidence, "low");
		assert.equal(p.aspect, "other");
		assert.equal(d.topics.get(p.topicId)?.system, "renal");
		assert.match(d.topics.get(p.topicId)!.name, /^Unsorted/);
	});
});

describe("revertRunLines", () => {
	it("restores what each fact had before the run, withdraws the rest, and leaves facts the learner moved since", () => {
		const lines: PlacementLine[] = [
			SBO,
			AP,
			placeLine("n1", "t_sbo", "presentation", { runId: "early", source: "learner" }),
			placeLine("n1", "t_ap", "workup", { runId: "r1" }),
			placeLine("n2", "t_ap", "management", { runId: "r1" }),
			placeLine("n3", "t_ap", "other", { runId: "r1" }),
			placeLine("n3", "t_sbo", "other", { source: "learner" }),
		];
		const back = revertRunLines(lines, "r1", T);
		const d = derivePlacements([...lines, ...back]);
		assert.equal(d.byNode.get("n1")?.topicId, "t_sbo", "n1 goes back to its earlier place");
		assert.equal(d.byNode.get("n1")?.source, "learner");
		assert.equal(d.byNode.has("n2"), false, "n2 had nothing before, so it is withdrawn");
		assert.ok(d.cleared.has("n2"));
		assert.equal(d.byNode.get("n3")?.topicId, "t_sbo", "n3 was moved by the learner afterwards and is left alone");
		assert.equal(back.length, 2);
		// Append-only: the original lines are untouched.
		assert.equal(lines.length, 7);
	});
});

describe("the placement stores", () => {
	it("round-trips lines, skips corrupt and invalid lines, and rewrites atomically", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-placement-"));
		try {
			const file = path.join(dir, "placements.jsonl");
			const store = createPlacementStore(file);
			assert.deepEqual(store.read(), []);
			store.append([SBO, placeLine("n1", "t_sbo")]);
			store.append([]);
			fs.appendFileSync(file, "{torn\n" + JSON.stringify({ kind: "place", nodeId: "n2", topicId: "t", aspect: "bogus", source: "placer", confidence: "high", at: T }) + "\n");
			store.append([placeLine("n3", "t_sbo", "workup")]);
			assert.deepEqual(store.read().map((l) => l.kind), ["topic", "place", "place"]);
			store.rewrite([SBO]);
			assert.equal(store.read().length, 1);
			assert.ok(isPlacementLine(SBO));
			assert.ok(!isPlacementLine({ kind: "topic", id: "x", name: "", system: "gi", createdAt: T }));
			assert.ok(!isPlacementLine({ kind: "topic", id: "x", name: "A", system: "not-a-system", createdAt: T }));
			assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes(".tmp-")), []);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps the run journal, and reads a missing or damaged file as empty", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-placer-journal-"));
		try {
			const file = path.join(dir, "placer-runs.json");
			const journal = createPlacerJournalStore(file);
			assert.deepEqual(journal.read(), []);
			journal.write([{ id: "r1", startedAt: T, kind: "backfill", placed: 3, topicsCreated: 1 }]);
			assert.equal(journal.read()[0]?.id, "r1");
			fs.writeFileSync(file, "not json");
			assert.deepEqual(journal.read(), []);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
