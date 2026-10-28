/**
 * The graph view's medical-tag surfaces (docs/medical-spec.md Phase 4): the
 * pure filter predicate, the filter chips panel, and the detail card's tag
 * editor. Effects and fetches don't run under renderToStaticMarkup, so the
 * presentational bodies are pinned directly (the GraphChromeRow pattern).
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GraphNode } from "../src/core/contracts.ts";
import {
	EMPTY_TAG_FILTER,
	GraphTagsPanel,
	NodeTagsEditor,
	getTagFilter,
	isNodeTagVisible,
	isTagFilterActive,
	setTagFilter,
	tagVisibleIds,
	type TagFilter,
} from "../components/graph-tags.tsx";
import { GraphChromeRow } from "../components/graph-view.tsx";
import type { GraphRenderSettings } from "../components/graph-canvas.ts";

const node = (id: string, over: Partial<GraphNode> = {}): GraphNode => ({
	id,
	name: id,
	statement: `${id} statement`,
	aliases: [],
	createdAt: "2026-10-01T00:00:00.000Z",
	provenance: [],
	...over,
});
const filter = (systems: string[] = [], factTypes: string[] = []): TagFilter =>
	({ systems: new Set(systems), factTypes: new Set(factTypes) }) as TagFilter;

describe("isNodeTagVisible", () => {
	const nephropathy = node("a", { systems: ["endocrine", "renal"], factType: "clinical-feature" });
	const untagged = node("b");

	it("an empty filter shows everything, tagged or not", () => {
		assert.equal(isTagFilterActive(EMPTY_TAG_FILTER), false);
		assert.equal(isNodeTagVisible(nephropathy, EMPTY_TAG_FILTER), true);
		assert.equal(isNodeTagVisible(untagged, EMPTY_TAG_FILTER), true);
	});

	it("system chips OR within the group: a multi-system fact matches either system", () => {
		assert.equal(isNodeTagVisible(nephropathy, filter(["renal"])), true);
		assert.equal(isNodeTagVisible(nephropathy, filter(["endocrine"])), true);
		assert.equal(isNodeTagVisible(nephropathy, filter(["cardiovascular", "renal"])), true);
		assert.equal(isNodeTagVisible(nephropathy, filter(["cardiovascular"])), false);
	});

	it("the two groups AND, and a node lacking the filtered tag is hidden", () => {
		assert.equal(isNodeTagVisible(nephropathy, filter(["renal"], ["clinical-feature"])), true);
		assert.equal(isNodeTagVisible(nephropathy, filter(["renal"], ["management"])), false);
		assert.equal(isNodeTagVisible(untagged, filter(["renal"])), false);
		assert.equal(isNodeTagVisible(untagged, filter([], ["management"])), false);
	});
});

describe("tagVisibleIds", () => {
	it("an implication junction is visible only when its conclusion and every premise are", () => {
		const nodes = [
			node("p1", { systems: ["renal"] }),
			node("p2", { systems: ["renal"] }),
			node("p3", { systems: ["gi"] }),
			node("c1", { systems: ["renal"] }),
			node("arg_1"),
			node("arg_2"),
		];
		const impLinks = [
			{ id: "arg_1", premises: ["p1", "p2"], conclusion: "c1" },
			{ id: "arg_2", premises: ["p1", "p3"], conclusion: "c1" },
		];
		const visible = tagVisibleIds(nodes, impLinks, filter(["renal"]));
		assert.deepEqual([...visible].sort(), ["arg_1", "c1", "p1", "p2"]);
	});
});

describe("the shared active-filter store (the seam for practice-select)", () => {
	it("holds what the chips set, so another surface can read it and filter ids the same way", () => {
		assert.equal(getTagFilter(), EMPTY_TAG_FILTER);
		setTagFilter(filter(["renal"]));
		try {
			const shown = tagVisibleIds([node("a", { systems: ["renal"] }), node("b")], [], getTagFilter());
			assert.deepEqual([...shown], ["a"]);
		} finally {
			setTagFilter(EMPTY_TAG_FILTER);
		}
		assert.equal(getTagFilter(), EMPTY_TAG_FILTER);
	});
});

describe("GraphTagsPanel", () => {
	const nodes = [
		node("a", { systems: ["renal", "endocrine"], factType: "management" }),
		node("b", { systems: ["renal"], factType: "mechanism" }),
		node("c"),
	];
	const props = { nodes, filter: EMPTY_TAG_FILTER, onFilter: () => {}, onBackfilled: () => {} };

	it("closed: just the Tags button", () => {
		const html = renderToStaticMarkup(createElement(GraphTagsPanel, props));
		assert.ok(html.includes('data-testid="open-tag-filters"'));
		assert.ok(!html.includes('data-testid="tag-filter-panel"'));
	});

	it("open: chips only for values some node carries, with counts, plus the back-fill while any node is untagged", () => {
		const html = renderToStaticMarkup(createElement(GraphTagsPanel, { ...props, initiallyOpen: true }));
		assert.ok(html.includes('data-testid="tag-chip-system-renal"'));
		assert.ok(html.includes('data-testid="tag-chip-system-endocrine"'));
		assert.ok(!html.includes('data-testid="tag-chip-system-psychiatry"'), "an unused system gets no chip");
		assert.ok(html.includes('data-testid="tag-chip-type-management"'));
		assert.ok(!html.includes('data-testid="tag-chip-type-diagnosis"'));
		assert.ok(html.includes('data-testid="tag-backfill"'));
		assert.ok(html.includes("Tag existing nodes (1)"), "one node (c) lacks tags");
	});

	it("an active chip is pressed, the active count shows, and Clear appears", () => {
		const html = renderToStaticMarkup(
			createElement(GraphTagsPanel, { ...props, filter: filter(["renal"], ["management"]), initiallyOpen: true }),
		);
		assert.ok(/aria-pressed="true"[^>]*data-testid="tag-chip-system-renal"/.test(html));
		assert.ok(/aria-pressed="false"[^>]*data-testid="tag-chip-system-endocrine"/.test(html));
		assert.ok(html.includes('data-testid="tag-filter-clear"'));
	});

	it("no back-fill button once every node is fully tagged", () => {
		const html = renderToStaticMarkup(
			createElement(GraphTagsPanel, { ...props, nodes: [nodes[0]!, nodes[1]!], initiallyOpen: true }),
		);
		assert.ok(!html.includes('data-testid="tag-backfill"'));
	});
});

describe("GraphChromeRow carries the Tags control only when supplied and the graph is not empty", () => {
	const ref = { current: null };
	const base = {
		query: "",
		onQuery: () => {},
		noMatch: false,
		importing: false,
		searchInputRef: ref,
		fileInputRef: ref,
		onImportFiles: () => {},
		settings: {} as GraphRenderSettings,
		changeSettings: () => {},
		onOpenChains: () => {},
	};
	const tags = { nodes: [], filter: EMPTY_TAG_FILTER, onFilter: () => {}, onBackfilled: () => {} };

	it("populated + tags: the control renders; without tags or on an empty graph it does not", () => {
		assert.ok(renderToStaticMarkup(createElement(GraphChromeRow, { ...base, isEmpty: false, tags })).includes("open-tag-filters"));
		assert.ok(!renderToStaticMarkup(createElement(GraphChromeRow, { ...base, isEmpty: false })).includes("open-tag-filters"));
		assert.ok(!renderToStaticMarkup(createElement(GraphChromeRow, { ...base, isEmpty: true, tags })).includes("open-tag-filters"));
	});
});

describe("NodeTagsEditor", () => {
	const noop = () => {};

	it("shows the current tags read-only, with an Edit button", () => {
		const html = renderToStaticMarkup(
			createElement(NodeTagsEditor, { nodeId: "n_1", systems: ["renal", "endocrine"], factType: "management", onSaved: noop }),
		);
		assert.ok(html.includes("Renal/Urinary") && html.includes("Endocrine") && html.includes("Management"));
		assert.ok(html.includes('data-testid="node-tags-edit"'));
		assert.ok(!html.includes('data-testid="node-tags-save"'));
	});

	it("an untagged node says so", () => {
		const html = renderToStaticMarkup(
			createElement(NodeTagsEditor, { nodeId: "n_1", systems: undefined, factType: undefined, onSaved: noop }),
		);
		assert.ok(html.includes("Untagged."));
	});

	it("editing lists all 13 systems and 5 fact types, pre-selected from the node, with Save", () => {
		const html = renderToStaticMarkup(
			createElement(NodeTagsEditor, {
				nodeId: "n_1",
				systems: ["renal"],
				factType: "mechanism",
				onSaved: noop,
				initiallyEditing: true,
			}),
		);
		assert.equal(html.match(/data-testid="node-tag-system-/g)?.length, 13);
		assert.equal(html.match(/data-testid="node-tag-type-/g)?.length, 5);
		assert.ok(/aria-pressed="true"[^>]*data-testid="node-tag-system-renal"/.test(html));
		assert.ok(/aria-pressed="true"[^>]*data-testid="node-tag-type-mechanism"/.test(html));
		assert.ok(/aria-pressed="false"[^>]*data-testid="node-tag-system-gi"/.test(html));
		assert.ok(html.includes('data-testid="node-tags-save"'));
	});
});
