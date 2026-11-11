/**
 * The visible-viewport maths (components/graph-viewport.ts): which canvas
 * edges the floating panels take, and the fit/centre cameras that frame
 * into what is left. QA 2026-11-12: the focused topic sat behind Tonight's
 * questions and the top system name sat under the toolbar.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	centreTransform,
	fitTransform,
	NO_INSETS,
	occlusionInsets,
	sameInsets,
	type Box,
} from "../components/graph-viewport.ts";

// The QA screen: a 1440x900 window, the graph canvas right of the 288px sidebar.
const canvas: Box = { left: 288, top: 0, right: 1440, bottom: 900 };
const toolbar: Box = { left: 650, top: 8, right: 1432, bottom: 44 };
const dock: Box = { left: 512, top: 445, right: 1216, bottom: 880 }; // Tonight's questions + composer
const outline: Box = { left: 300, top: 56, right: 620, bottom: 888 };

describe("occlusionInsets", () => {
	test("no panels take nothing", () => {
		assert.deepEqual(occlusionInsets(canvas, []), NO_INSETS);
	});

	test("the toolbar takes the top, the dock the bottom, the outline the left", () => {
		const i = occlusionInsets(canvas, [toolbar, dock, outline]);
		assert.equal(i.top, 44);
		assert.equal(i.bottom, 900 - 445);
		assert.equal(i.left, 620 - 288);
		assert.equal(i.right, 0);
	});

	test("each side keeps its largest claim", () => {
		const chip: Box = { left: 1200, top: 50, right: 1432, bottom: 80 }; // the focus chip under the toolbar
		assert.equal(occlusionInsets(canvas, [toolbar, chip]).top, 80);
	});

	test("a panel pushes out where that costs the least area", () => {
		// Tall and narrow at the right edge: the right, not the top or bottom.
		const side: Box = { left: 1000, top: 60, right: 1430, bottom: 700 };
		const i = occlusionInsets(canvas, [side]);
		assert.equal(i.right, 440);
		assert.equal(i.top + i.bottom + i.left, 0);
	});

	test("panels outside the canvas or not rendered (zero size) take nothing", () => {
		const sidebar: Box = { left: 0, top: 0, right: 288, bottom: 900 };
		const hidden: Box = { left: 0, top: 0, right: 0, bottom: 0 };
		assert.deepEqual(occlusionInsets(canvas, [sidebar, hidden]), NO_INSETS);
	});

	test("only the part inside the canvas counts", () => {
		const overhang: Box = { left: 600, top: 800, right: 900, bottom: 1200 };
		assert.equal(occlusionInsets(canvas, [overhang]).bottom, 100);
	});

	test("the visible part never drops below the minimum share: insets give way proportionally", () => {
		// A narrow window (the phone-width end of the graph home): the dock is
		// most of the height, the outline sheet sits at the bottom too.
		const narrow: Box = { left: 0, top: 0, right: 660, bottom: 700 };
		const bigDock: Box = { left: 0, top: 150, right: 660, bottom: 700 };
		const bar: Box = { left: 60, top: 8, right: 652, bottom: 44 };
		const i = occlusionInsets(narrow, [bigDock, bar], 0.4);
		assert.ok(Math.abs(700 - i.top - i.bottom - 0.4 * 700) < 1e-9);
		// Proportional: the ratio of the two claims survives.
		assert.ok(Math.abs(i.bottom / i.top - 550 / 44) < 1e-9);
	});

	test("a degenerate canvas takes nothing", () => {
		assert.deepEqual(occlusionInsets({ left: 0, top: 0, right: 0, bottom: 0 }, [dock]), NO_INSETS);
	});
});

describe("sameInsets", () => {
	test("sub-pixel jitter is not a change; a real move is", () => {
		const a = { top: 44, right: 0, bottom: 455, left: 0 };
		assert.equal(sameInsets(a, { ...a, bottom: 455.3 }), true);
		assert.equal(sameInsets(a, { ...a, bottom: 400 }), false);
	});
});

describe("fitTransform / centreTransform with insets", () => {
	const bbox = { minX: -100, maxX: 100, minY: -50, maxY: 50 };

	test("without insets it is the old whole-canvas fit", () => {
		const t = fitTransform(bbox, 1000, 600, 40);
		assert.equal(t.k, Math.min(920 / 200, 520 / 100));
		assert.equal(t.x, 500);
		assert.equal(t.y, 300);
	});

	test("the bbox centre lands at the centre of the visible part", () => {
		const insets = { top: 44, right: 0, bottom: 455, left: 332 };
		const w = 1152;
		const h = 900;
		const t = fitTransform(bbox, w, h, 40, insets);
		const vw = w - 332;
		const vh = h - 44 - 455;
		assert.equal(t.k, Math.min((vw - 80) / 200, (vh - 80) / 100));
		// World (0,0) = bbox centre → screen centre of the visible rect.
		assert.equal(t.x, 332 + vw / 2);
		assert.equal(t.y, 44 + vh / 2);
		// The whole bbox (plus padding) stays inside the visible rect.
		assert.ok(bbox.minY * t.k + t.y >= 44 + 40 - 1e-9);
		assert.ok(bbox.maxY * t.k + t.y <= h - 455 - 40 + 1e-9);
		assert.ok(bbox.minX * t.k + t.x >= 332 + 40 - 1e-9);
	});

	test("the top of the picture clears the toolbar", () => {
		// The bubble view's bounds are the system frames; a frame's name sits just above its top.
		const t = fitTransform(bbox, 1152, 900, 40, { top: 44, right: 0, bottom: 0, left: 0 });
		assert.ok(bbox.minY * t.k + t.y >= 44 + 40 - 1e-9);
	});

	test("a padding wider than the visible side gives way instead of flipping the zoom", () => {
		const t = fitTransform(bbox, 200, 200, 80, { top: 0, right: 0, bottom: 100, left: 0 });
		assert.ok(t.k > 0);
		// Padding never takes more than half a side: 100 of 200 across, 50 of the 100 visible down.
		assert.equal(t.k, Math.min(100 / 200, 50 / 100));
	});

	test("centreTransform puts a world point at the visible centre", () => {
		const c = centreTransform(10, 20, 2, 1000, 800, { top: 100, right: 0, bottom: 300, left: 200 });
		assert.equal(10 * c.k + c.x, 200 + 800 / 2);
		assert.equal(20 * c.k + c.y, 100 + 400 / 2);
	});
});
