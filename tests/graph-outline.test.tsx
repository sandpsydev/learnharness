/**
 * The graph page's outline (components/graph-outline.tsx): the tree, search,
 * branch filtering, and the static render of the panel pieces. Effects and
 * fetches don't run under renderToStaticMarkup, so the presentational bodies
 * are pinned directly (the GraphChromeRow pattern).
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GraphNode } from "../src/core/contracts.ts";
import type { PlacementView } from "../src/core/contracts/placement.ts";
import {
	GraphOutlineButton,
	OutlineTreeView,
	PlacementFooter,
	buildOutline,
	getOutlineSelection,
	isNodeInSelection,
	outlineVisibleIds,
	sameSelection,
	selectionLabel,
	setOutlineSelection,
	type OutlineSelection,
} from "../components/graph-outline.tsx";

const node = (id: string, name: string, over: Partial<GraphNode> = {}): GraphNode => ({
	id,
	name,
	statement: `${name} statement`,
	aliases: [],
	createdAt: "2026-11-01T00:00:00.000Z",
	provenance: [],
	...over,
});

const nodes = [
	node("n1", "Adhesions are the commonest cause"),
	node("n2", "Vomiting is bilious when the obstruction is high"),
	node("n3", "Ileus has no mechanical blockage"),
	node("n4", "Amylase rises in pancreatitis"),
	node("n5", "Unplaced fact"),
];

const placement: PlacementView = {
	topics: [
		{ id: "t_sbo", name: "Small-bowel obstruction", system: "gi" },
		{ id: "t_ap", name: "Acute pancreatitis", system: "gi" },
		{ id: "t_hf", name: "Heart failure", system: "cardiovascular" },
	],
	byNode: {
		n1: { topicId: "t_sbo", aspect: "risk-factors", source: "placer", confidence: "high" },
		n2: { topicId: "t_sbo", aspect: "presentation", source: "placer", confidence: "low" },
		n3: { topicId: "t_sbo", aspect: "how-it-develops", source: "placer", confidence: "high" },
		n4: { topicId: "t_ap", aspect: "workup", source: "learner", confidence: "high" },
	},
	unplaced: 1,
	withdrawn: 0,
};

describe("buildOutline", () => {
	it("lays the facts out system → topic → aspect with counts, in the fixed orders", () => {
		const tree = buildOutline(nodes, placement);
		assert.deepEqual(tree.systems.map((s) => s.label), ["GI/Hepatobiliary"]);
		const gi = tree.systems[0]!;
		assert.equal(gi.count, 4);
		assert.deepEqual(gi.topics.map((t) => [t.topic.name, t.count]), [["Acute pancreatitis", 1], ["Small-bowel obstruction", 3]]);
		// Aspects follow the illness-script order, not the alphabet.
		assert.deepEqual(gi.topics[1]!.aspects.map((a) => a.id), ["risk-factors", "how-it-develops", "presentation"]);
		assert.deepEqual(tree.unplaced.map((n) => n.id), ["n5"]);
		assert.equal(tree.total, 5);
	});

	it("search keeps matching facts and everything under a matching topic or system; empty branches drop out", () => {
		const byFact = buildOutline(nodes, placement, "bilious");
		assert.deepEqual(byFact.systems[0]!.topics.map((t) => [t.topic.name, t.count]), [["Small-bowel obstruction", 1]]);
		assert.equal(byFact.unplaced.length, 0);

		const byTopic = buildOutline(nodes, placement, "pancreatitis");
		assert.deepEqual(byTopic.systems[0]!.topics.map((t) => t.topic.name), ["Acute pancreatitis"]);

		const bySystem = buildOutline(nodes, placement, "gi/hepato");
		assert.equal(bySystem.systems[0]!.count, 4);

		const none = buildOutline(nodes, placement, "zzz");
		assert.equal(none.total, 0);
		assert.equal(none.systems.length, 0);
	});

	it("without placement data every fact is simply not placed yet", () => {
		const tree = buildOutline(nodes, undefined);
		assert.equal(tree.systems.length, 0);
		assert.equal(tree.unplaced.length, 5);
	});
});

describe("selection → visible nodes", () => {
	const sel = (s: OutlineSelection) => s;

	it("a system, a topic, an aspect and 'not placed yet' each select just their facts", () => {
		const ids = (s: OutlineSelection) => nodes.filter((n) => isNodeInSelection(n.id, placement, s)).map((n) => n.id);
		assert.deepEqual(ids(sel({ system: "gi" })), ["n1", "n2", "n3", "n4"]);
		assert.deepEqual(ids(sel({ system: "cardiovascular" })), []);
		assert.deepEqual(ids(sel({ system: "gi", topicId: "t_sbo" })), ["n1", "n2", "n3"]);
		assert.deepEqual(ids(sel({ system: "gi", topicId: "t_sbo", aspect: "presentation" })), ["n2"]);
		assert.deepEqual(ids(sel({ unplaced: true })), ["n5"]);
	});

	it("derived implication nodes show only when their conclusion and every premise do", () => {
		const imp = [
			{ id: "arg_in", premises: ["n1", "n2"], conclusion: "n3" },
			{ id: "arg_out", premises: ["n1", "n4"], conclusion: "n3" },
		];
		const all = [...nodes, node("arg_in", "imp"), node("arg_out", "imp")];
		const visible = outlineVisibleIds(all, imp, placement, { system: "gi", topicId: "t_sbo" });
		assert.ok(visible.has("arg_in"));
		assert.ok(!visible.has("arg_out"), "n4 is outside the topic, so the chain is hidden");
		assert.ok(!visible.has("n4"));
	});

	it("labels the filter like a path and compares selections", () => {
		assert.equal(selectionLabel({ system: "gi", topicId: "t_sbo", aspect: "presentation" }, placement), "GI/Hepatobiliary › Small-bowel obstruction › Presentation");
		assert.equal(selectionLabel({ unplaced: true }, placement), "Not placed yet");
		assert.ok(sameSelection({ system: "gi" }, { system: "gi" }));
		assert.ok(!sameSelection({ system: "gi" }, null));
	});

	it("the shared store holds the selection", () => {
		setOutlineSelection({ system: "gi", topicId: "t_ap" });
		assert.deepEqual(getOutlineSelection(), { system: "gi", topicId: "t_ap" });
		setOutlineSelection(null);
		assert.equal(getOutlineSelection(), null);
	});
});

describe("OutlineTreeView (static render)", () => {
	const render = (props: Partial<React.ComponentProps<typeof OutlineTreeView>> = {}) =>
		renderToStaticMarkup(
			createElement(OutlineTreeView, {
				tree: buildOutline(nodes, placement, props.forceOpen ? "o" : ""),
				selection: null,
				open: new Set<string>(),
				forceOpen: false,
				onToggle: () => {},
				onSelect: () => {},
				onOpenFact: () => {},
				...props,
			}),
		);

	it("shows systems with counts, collapsed", () => {
		const html = render();
		assert.match(html, /data-testid="outline-system-gi"/);
		assert.match(html, /GI\/Hepatobiliary/);
		assert.doesNotMatch(html, /outline-topic-t_sbo/);
		assert.match(html, /data-testid="outline-unplaced"/);
	});

	it("opens down to the facts, marks a best guess subtly and the selected branch as pressed", () => {
		const html = render({
			open: new Set(["s:gi", "t:t_sbo", "a:t_sbo:presentation"]),
			selection: { system: "gi", topicId: "t_sbo" },
		});
		assert.match(html, /outline-topic-t_sbo"[^>]*aria-pressed="true"/);
		assert.match(html, /outline-aspect-t_sbo-presentation/);
		assert.match(html, /data-testid="outline-fact-n2"/);
		assert.match(html, /data-testid="outline-low"/);
		assert.doesNotMatch(html, /outline-fact-n1"/, "a collapsed aspect hides its facts");
	});

	it("a search opens everything; no match says so", () => {
		const html = render({ forceOpen: true });
		assert.match(html, /outline-fact-/);
		const empty = renderToStaticMarkup(
			createElement(OutlineTreeView, { tree: buildOutline(nodes, placement, "zzz"), selection: null, open: new Set<string>(), forceOpen: true, onToggle: () => {}, onSelect: () => {}, onOpenFact: () => {} }),
		);
		assert.match(empty, /Nothing matches/);
	});

	it("each row is at least a thumb tall for phone width", () => {
		assert.match(render(), /min-h-8/);
	});
});

describe("the chrome button and the quiet footer", () => {
	it("the Outline button reports whether a branch filter is on", () => {
		const off = renderToStaticMarkup(createElement(GraphOutlineButton, { open: false, onToggle: () => {}, filtered: false }));
		const on = renderToStaticMarkup(createElement(GraphOutlineButton, { open: true, onToggle: () => {}, filtered: true }));
		assert.match(off, /Outline/);
		assert.doesNotMatch(off, /bg-primary/);
		assert.match(on, /bg-primary/);
	});

	it("the footer says what the placer is doing and offers undo — never a task", () => {
		const html = renderToStaticMarkup(
			createElement(PlacementFooter, {
				status: { running: true, unplaced: 12, total: 40, lastRun: { id: "r1", startedAt: "x", kind: "backfill", placed: 28, topicsCreated: 5 } },
				withdrawn: 0,
				busy: false,
				onUndo: () => {},
				onPlaceAgain: () => {},
			}),
		);
		assert.match(html, /Placing 12 facts/);
		assert.match(html, /Last automatic placement: 28 facts/);
		assert.match(html, /data-testid="outline-undo"/);
		assert.doesNotMatch(html, /outline-place-again/);

		const waiting = renderToStaticMarkup(
			createElement(PlacementFooter, { status: { running: false, unplaced: 3, total: 3, problem: "no-model" }, withdrawn: 2, busy: false, onUndo: () => {}, onPlaceAgain: () => {} }),
		);
		assert.match(waiting, /will be placed once a model is available/);
		assert.match(waiting, /outline-place-again/);

		assert.equal(renderToStaticMarkup(createElement(PlacementFooter, { status: null, withdrawn: 0, busy: false, onUndo: () => {}, onPlaceAgain: () => {} })), "");
	});
});
