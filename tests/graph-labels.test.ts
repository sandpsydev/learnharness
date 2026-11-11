/**
 * Label placement for the topic-bubble view (components/graph-labels.ts):
 * greedy by priority, each label takes its first clear spot (below, then
 * above) or stays hidden. QA 2026-11-12: names piled up inside the GI frame.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { discHitsRect, placeLabels, rectsOverlap, type LabelCandidate, type Rect } from "../components/graph-labels.ts";

/** A bubble at (x, y) with radius r and a w×h name: below first, then above. */
function bubble(id: string, x: number, y: number, r: number, priority: number, w = 40, h = 10): LabelCandidate {
	return {
		id,
		priority,
		spots: [
			{ x: x - w / 2, y: y + r + 2, w, h },
			{ x: x - w / 2, y: y - r - 2 - h, w, h },
		],
	};
}

describe("rectsOverlap / discHitsRect", () => {
	test("overlap, touching, and the pad", () => {
		const a: Rect = { x: 0, y: 0, w: 10, h: 10 };
		assert.equal(rectsOverlap(a, { x: 5, y: 5, w: 10, h: 10 }), true);
		assert.equal(rectsOverlap(a, { x: 10, y: 0, w: 10, h: 10 }), false); // edges touch
		assert.equal(rectsOverlap(a, { x: 11, y: 0, w: 10, h: 10 }, 2), true); // inside the pad
		assert.equal(rectsOverlap(a, { x: 0, y: 20, w: 10, h: 10 }), false);
	});

	test("a disc reaching into a box, from the side and at a corner", () => {
		const box: Rect = { x: 0, y: 0, w: 10, h: 10 };
		assert.equal(discHitsRect({ x: 13, y: 5, r: 4 }, box), true);
		assert.equal(discHitsRect({ x: 15, y: 5, r: 4 }, box), false);
		assert.equal(discHitsRect({ x: 13, y: 13, r: 4 }, box), false); // corner: distance 4.24
		assert.equal(discHitsRect({ x: 12, y: 12, r: 4 }, box), true); // corner: distance 2.83
		assert.equal(discHitsRect({ x: 5, y: 5, r: 1 }, box), true); // centre inside
	});
});

describe("placeLabels", () => {
	test("labels with room all go below their bubbles", () => {
		const at = placeLabels([bubble("a", 0, 0, 5, 1), bubble("b", 100, 0, 5, 1)]);
		assert.deepEqual([...at.entries()].sort(), [["a", 0], ["b", 0]]);
	});

	test("a clash: the higher priority keeps below, the other moves above", () => {
		// Side by side, closer than one label width: the two below-spots overlap.
		const at = placeLabels([bubble("small", 30, 0, 5, 1), bubble("big", 0, 0, 5, 9)]);
		assert.equal(at.get("big"), 0);
		assert.equal(at.get("small"), 1);
	});

	test("no clear spot: the lower priority label is hidden", () => {
		// Same place: both of the second label's spots overlap the first's.
		const at = placeLabels([bubble("a", 0, 0, 5, 2), bubble("b", 2, 0, 5, 1), bubble("c", 4, 0, 5, 0)]);
		assert.equal(at.get("a"), 0);
		assert.equal(at.get("b"), 1);
		assert.equal(at.has("c"), false);
	});

	test("ties go by id, so the result never depends on input order", () => {
		const one = placeLabels([bubble("b", 2, 0, 5, 1), bubble("a", 0, 0, 5, 1)]);
		const two = placeLabels([bubble("a", 0, 0, 5, 1), bubble("b", 2, 0, 5, 1)]);
		assert.deepEqual([...one.entries()].sort(), [...two.entries()].sort());
		assert.equal(one.get("a"), 0);
	});

	test("labels keep clear of other discs but not their own", () => {
		const a = bubble("a", 0, 0, 5, 1);
		// A disc right under a's below-spot.
		const obstacles = [
			{ x: 0, y: 0, r: 5, owner: "a" },
			{ x: 0, y: 12, r: 4, owner: "x" },
		];
		assert.equal(placeLabels([a], { obstacles }).get("a"), 1);
		// Its own disc alone never blocks it.
		assert.equal(placeLabels([a], { obstacles: [obstacles[0]!] }).get("a"), 0);
	});

	test("fixed text (system names, open-topic headers) blocks and never moves", () => {
		const header: Rect = { x: -30, y: 5, w: 60, h: 14 };
		const at = placeLabels([bubble("a", 0, 0, 5, 1)], { fixed: [header] });
		assert.equal(at.get("a"), 1);
	});

	test("the pad keeps a gap between labels", () => {
		// Below-spots 1px apart horizontally: clear without a pad, a clash with one.
		const a = bubble("a", 0, 0, 5, 2);
		const b = bubble("b", 41, 0, 5, 1);
		assert.equal(placeLabels([a, b]).get("b"), 0);
		assert.equal(placeLabels([a, b], { pad: 2 }).get("b"), 1);
	});

	test("a crowded row: every placed label is clear of every other", () => {
		const row = Array.from({ length: 30 }, (_, i) => bubble(`t${String(i).padStart(2, "0")}`, i * 12, (i % 3) * 7, 4, i % 5));
		const at = placeLabels(row, { pad: 1 });
		const boxes = row.filter((c) => at.has(c.id)).map((c) => c.spots[at.get(c.id)!]!);
		for (let i = 0; i < boxes.length; i++)
			for (let j = i + 1; j < boxes.length; j++) assert.equal(rectsOverlap(boxes[i]!, boxes[j]!, 1), false);
		assert.ok(at.size > 0 && at.size < row.length);
	});
});
