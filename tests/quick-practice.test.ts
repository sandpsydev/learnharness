/** Quick practice's pure helpers (Pocket mode): the round's material and wording. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	QUICK_ROUND_NOTES, nodesForSystems, quickPracticeOpening, quickPracticeTitle, sampleNodes, systemCounts,
} from "../src/core/index.ts";
import type { GraphNodeTags, OrganSystem } from "../src/core/index.ts";

const n = (id: string, systems?: OrganSystem[]) => ({ id, systems }) satisfies GraphNodeTags & { id: string };
const nodes = [n("a", ["renal"]), n("b", ["renal", "cardiovascular"]), n("c", ["endocrine"]), n("d")];

describe("quick practice helpers", () => {
	it("counts notes per system in the spec's order, keeping empty systems", () => {
		const counts = systemCounts(nodes);
		assert.equal(counts.length, 13);
		assert.equal(counts[0]!.id, "cardiovascular");
		assert.deepEqual(counts.filter((c) => c.count > 0).map((c) => [c.id, c.count]), [["cardiovascular", 1], ["renal", 2], ["endocrine", 1]]);
	});

	it("any chosen system matches (like the graph chips); none chosen means everything", () => {
		assert.deepEqual(nodesForSystems(nodes, new Set()).map((x) => x.id), ["a", "b", "c", "d"]);
		assert.deepEqual(nodesForSystems(nodes, new Set<OrganSystem>(["renal"])).map((x) => x.id), ["a", "b"]);
		assert.deepEqual(nodesForSystems(nodes, new Set<OrganSystem>(["renal", "endocrine"])).map((x) => x.id), ["a", "b", "c"]);
		assert.deepEqual(nodesForSystems(nodes, new Set<OrganSystem>(["psychiatry"])), []);
	});

	it("samples at most the limit, without repeats, and is repeatable with a fixed random source", () => {
		const many = Array.from({ length: 40 }, (_, i) => i);
		let seed = 1;
		const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
		const picked = sampleNodes(many, QUICK_ROUND_NOTES, random);
		assert.equal(picked.length, QUICK_ROUND_NOTES);
		assert.equal(new Set(picked).size, QUICK_ROUND_NOTES);
		seed = 1;
		assert.deepEqual(sampleNodes(many, QUICK_ROUND_NOTES, random), picked);
		assert.deepEqual(sampleNodes([1, 2], 12).sort(), [1, 2], "fewer notes than the limit: all of them");
		assert.deepEqual(sampleNodes(many, 0), []);
	});

	it("names the round after its systems, and asks for a short A–E round", () => {
		assert.equal(quickPracticeTitle(new Set()), "Quick practice");
		assert.equal(quickPracticeTitle(new Set<OrganSystem>(["renal", "cardiovascular"])), "Quick practice · Cardiovascular, Renal/Urinary");
		const opening = quickPracticeOpening(new Set<OrganSystem>(["renal"]));
		assert.match(opening, /5 single-best-answer questions/);
		assert.match(opening, /options A to E/);
		assert.match(opening, /Stay within Renal\/Urinary/);
		assert.doesNotMatch(quickPracticeOpening(new Set()), /Stay within/);
	});
});
