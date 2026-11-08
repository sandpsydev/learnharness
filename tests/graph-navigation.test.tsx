/**
 * The graph page's navigation aids (components/graph-navigation.ts and
 * components/graph-trail.tsx): focus-mode neighbourhoods, the topic-bubble view
 * (collapse / expand, edge aggregation, layout), breadcrumbs and recents.
 * Effects don't run under renderToStaticMarkup, so the presentational pieces are
 * pinned directly (the graph-outline.test.tsx pattern).
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
	BUBBLE_PREFIX,
	RECENT_LIMIT,
	UNPLACED_KEY,
	bubbleRadius,
	buildClusterView,
	displayIdsFor,
	factBreadcrumb,
	focusNeighbourhood,
	isTopicNodeId,
	layoutClusterView,
	openRadius,
	packCircles,
	parseRecents,
	pushRecent,
	resolveRecents,
	topicKeyOf,
	topicNodeId,
	type NavEdge,
	type NavImpLink,
} from "../components/graph-navigation.ts";
import { FactBreadcrumb, FocusChip, RecentFacts, ViewModeToggle } from "../components/graph-trail.tsx";
import { GraphOutlinePanel } from "../components/graph-outline.tsx";

const node = (id: string, name: string): GraphNode => ({
	id,
	name,
	statement: `${name} statement`,
	aliases: [],
	createdAt: "2026-11-01T00:00:00.000Z",
	provenance: [],
});

// GI: Small-bowel obstruction (a1 a2 a3), Acute pancreatitis (b1 b2). Cardio: Heart failure (c1).
// u1 has no place.
const nodes = ["a1", "a2", "a3", "b1", "b2", "c1", "u1"].map((id) => node(id, `Fact ${id}`));

const placement: PlacementView = {
	topics: [
		{ id: "t_sbo", name: "Small-bowel obstruction", system: "gi" },
		{ id: "t_ap", name: "Acute pancreatitis", system: "gi" },
		{ id: "t_hf", name: "Heart failure", system: "cardiovascular" },
	],
	byNode: {
		a1: { topicId: "t_sbo", aspect: "presentation", source: "placer", confidence: "high" },
		a2: { topicId: "t_sbo", aspect: "risk-factors", source: "placer", confidence: "high" },
		a3: { topicId: "t_sbo", aspect: "workup", source: "placer", confidence: "high" },
		b1: { topicId: "t_ap", aspect: "workup", source: "placer", confidence: "high" },
		b2: { topicId: "t_ap", aspect: "management", source: "learner", confidence: "high" },
		c1: { topicId: "t_hf", aspect: "other", source: "placer", confidence: "high" },
	},
	unplaced: 1,
	withdrawn: 0,
};

// Derived edges as the graph draws them:
//   a1 → a2                     inside one topic
//   a1 → b1, a2 → b1            two edges between the same two topics
//   a3, b2 ⇒ arg_1 → c1         a two-premise chain from GI into cardio
//   c1 → u1                     into the unplaced fact
const edges: NavEdge[] = [
	{ from: "a1", to: "a2" },
	{ from: "a1", to: "b1" },
	{ from: "a2", to: "b1" },
	{ from: "a3", to: "arg_1" },
	{ from: "b2", to: "arg_1" },
	{ from: "arg_1", to: "c1" },
	{ from: "c1", to: "u1" },
];
const impLinks: NavImpLink[] = [{ id: "arg_1", premises: ["a3", "b2"], conclusion: "c1" }];

const build = (over: Partial<Parameters<typeof buildClusterView>[0]> = {}) =>
	buildClusterView({ nodes, placement, edges, impLinks, expanded: new Set(), ...over });

describe("focusNeighbourhood", () => {
	it("keeps the fact and its direct neighbours, nothing two hops away", () => {
		const hood = focusNeighbourhood("a1", edges, impLinks);
		assert.deepEqual([...hood].sort(), ["a1", "a2", "b1"]);
	});

	it("brings the whole chain in when the edge runs through an implication node", () => {
		// a3 is one premise of arg_1: its neighbour is the junction, and with it the other premise and the conclusion.
		const fromPremise = focusNeighbourhood("a3", edges, impLinks);
		assert.deepEqual([...fromPremise].sort(), ["a3", "arg_1", "b2", "c1"]);
		// Focusing the conclusion shows the same chain, plus its other direct neighbour.
		const fromConclusion = focusNeighbourhood("c1", edges, impLinks);
		assert.deepEqual([...fromConclusion].sort(), ["a3", "arg_1", "b2", "c1", "u1"]);
	});

	it("covers both directions of a plain edge and leaves unrelated facts out", () => {
		assert.deepEqual([...focusNeighbourhood("b1", edges, impLinks)].sort(), ["a1", "a2", "b1"]);
		assert.deepEqual([...focusNeighbourhood("u1", edges, impLinks)].sort(), ["c1", "u1"]);
		assert.deepEqual([...focusNeighbourhood("loner", edges, impLinks)], ["loner"]);
	});
});

describe("buildClusterView — collapsed", () => {
	it("is one marker per topic, grouped under its organ system in the fixed order, Unplaced last", () => {
		const view = build();
		assert.deepEqual(
			view.groups.map((g) => [g.label, g.topics.map((t) => [t.name, t.facts.length])]),
			[
				["Cardiovascular", [["Heart failure", 1]]],
				["GI/Hepatobiliary", [["Acute pancreatitis", 2], ["Small-bowel obstruction", 3]]],
				["Unplaced", [["Unplaced", 1]]],
			],
		);
		assert.deepEqual(
			view.nodeIds.map((n) => n.kind),
			["topic", "topic", "topic", "topic"],
		);
		assert.ok(view.nodeIds.every((n) => isTopicNodeId(n.id)));
		assert.equal(topicKeyOf(topicNodeId("t_sbo")), "t_sbo");
		assert.ok(topicNodeId(UNPLACED_KEY).startsWith(BUBBLE_PREFIX));
		// Every fact is represented by its topic's bubble.
		assert.equal(view.displayOf.get("a1"), topicNodeId("t_sbo"));
		assert.equal(view.displayOf.get("u1"), topicNodeId(UNPLACED_KEY));
	});

	it("aggregates edges between collapsed topics and drops edges inside one", () => {
		const view = build();
		const sbo = topicNodeId("t_sbo");
		const ap = topicNodeId("t_ap");
		const hf = topicNodeId("t_hf");
		const un = topicNodeId(UNPLACED_KEY);
		const byPair = new Map(view.edges.map((e) => [`${e.from}>${e.to}`, e.count]));
		// a1→b1 and a2→b1 merge into one SBO → AP edge of weight 2; a1→a2 (inside SBO) vanishes.
		assert.equal(byPair.get(`${sbo}>${ap}`), 2);
		assert.ok(!byPair.has(`${sbo}>${sbo}`));
		// The chain is contracted: a3→c1 and b2→c1 become two bubble edges.
		assert.equal(byPair.get(`${sbo}>${hf}`), 1);
		assert.equal(byPair.get(`${ap}>${hf}`), 1);
		assert.equal(byPair.get(`${hf}>${un}`), 1);
		assert.equal(view.edges.length, 4);
		// No implication node appears while the chain is contracted.
		assert.deepEqual(view.impLinks, []);
		assert.ok(view.edges.every((e) => !e.from.startsWith("arg_") && !e.to.startsWith("arg_")));
	});
});

describe("buildClusterView — expanded", () => {
	it("opening a topic shows its facts (aspect order) in place of the bubble's facts, and nothing else", () => {
		const view = build({ expanded: new Set(["t_sbo"]) });
		const ids = view.nodeIds.map((n) => n.id);
		// Illness-script order: risk factors (a2), presentation (a1), workup (a3).
		assert.deepEqual(ids.filter((id) => !isTopicNodeId(id)), ["a2", "a1", "a3"]);
		assert.equal(view.displayOf.get("a1"), "a1");
		assert.equal(view.displayOf.get("b1"), topicNodeId("t_ap"));
		// The open topic still has its marker (its header) so it can be closed.
		assert.ok(ids.includes(topicNodeId("t_sbo")));
		assert.equal(view.topics.find((t) => t.key === "t_sbo")?.expanded, true);
		assert.equal(view.groups.find((g) => g.label === "GI/Hepatobiliary")?.members.includes("a1"), true);
	});

	it("edges follow: fact → bubble where only one side is open, plain edges stay inside an open topic", () => {
		const view = build({ expanded: new Set(["t_sbo"]) });
		const ap = topicNodeId("t_ap");
		const pairs = view.edges.map((e) => `${e.from}>${e.to}:${e.count}`);
		assert.ok(pairs.includes("a1>a2:1"), "inside the open topic");
		assert.ok(pairs.includes(`a1>${ap}:1`));
		assert.ok(pairs.includes(`a2>${ap}:1`));
		// Two edges that used to merge into one are now two separate ones.
		assert.ok(!pairs.some((p) => p.endsWith(":2")));
	});

	it("a chain is drawn in full — junction included — only when every member is open; otherwise contracted", () => {
		const all = build({ expanded: new Set(["t_sbo", "t_ap", "t_hf"]) });
		assert.deepEqual(all.impLinks.map((l) => l.id), ["arg_1"]);
		assert.ok(all.nodeIds.some((n) => n.id === "arg_1" && n.kind === "imp"));
		assert.ok(all.edges.some((e) => e.from === "a3" && e.to === "arg_1"));
		assert.ok(all.edges.some((e) => e.from === "arg_1" && e.to === "c1"));
		assert.ok(!all.edges.some((e) => e.from === "a3" && e.to === "c1"));
		const partly = build({ expanded: new Set(["t_sbo", "t_ap"]) });
		assert.deepEqual(partly.impLinks, []);
		assert.ok(partly.edges.some((e) => e.from === "a3" && e.to === topicNodeId("t_hf")));
		assert.ok(partly.edges.some((e) => e.from === "b2" && e.to === topicNodeId("t_hf")));
	});

	it("closing it again returns to the collapsed picture", () => {
		const open = build({ expanded: new Set(["t_sbo"]) });
		const closed = build({ expanded: new Set() });
		assert.notDeepEqual(open.nodeIds, closed.nodeIds);
		assert.deepEqual(closed.nodeIds, build().nodeIds);
		assert.deepEqual(closed.edges, build().edges);
	});
});

describe("buildClusterView — filters", () => {
	it("shows only the visible facts: topics with none drop out, counts shrink, edges to hidden facts go", () => {
		const view = build({ visibleIds: new Set(["a1", "a2", "b1"]) });
		assert.deepEqual(
			view.topics.map((t) => [t.name, t.facts.length]),
			[["Acute pancreatitis", 1], ["Small-bowel obstruction", 2]],
		);
		assert.deepEqual(view.edges.map((e) => [e.from, e.to, e.count]), [[topicNodeId("t_sbo"), topicNodeId("t_ap"), 2]]);
	});

	it("a chain with a hidden member contributes nothing", () => {
		const view = build({ visibleIds: new Set(["a3", "c1"]) });
		assert.deepEqual(view.edges, []);
	});

	it("displayIdsFor maps facts to what stands for them and skips facts that aren't shown", () => {
		const view = build({ expanded: new Set(["t_sbo"]) });
		assert.deepEqual([...displayIdsFor(view, ["a1", "b1", "b2", "nope"])].sort(), ["a1", topicNodeId("t_ap")].sort());
	});
});

describe("layoutClusterView", () => {
	const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

	it("packCircles never overlaps and is deterministic", () => {
		const radii = [20, 14, 14, 9, 9, 9, 6, 22, 5];
		const a = packCircles(radii, 8);
		assert.deepEqual(a, packCircles(radii, 8));
		for (let i = 0; i < radii.length; i++)
			for (let j = i + 1; j < radii.length; j++) assert.ok(dist(a[i]!, a[j]!) >= radii[i]! + radii[j]! + 8 - 1e-6, `${i},${j}`);
	});

	it("gives every drawn node a position; bubbles are sized by count and sit apart; each system has a frame round its topics", () => {
		const view = build();
		const layout = layoutClusterView(view);
		for (const n of view.nodeIds) assert.ok(layout.positions.has(n.id), n.id);
		const sbo = topicNodeId("t_sbo");
		const ap = topicNodeId("t_ap");
		assert.equal(layout.radius.get(sbo), bubbleRadius(3));
		assert.ok(layout.radius.get(sbo)! > layout.radius.get(ap)!);
		assert.ok(dist(layout.positions.get(sbo)!, layout.positions.get(ap)!) >= layout.radius.get(sbo)! + layout.radius.get(ap)!);
		const gi = layout.frames.get("system:gi")!;
		for (const id of [sbo, ap]) assert.ok(dist(gi, layout.centre.get(id)!) + layout.radius.get(id)! <= gi.r);
		// Systems are kept apart.
		const cardio = layout.frames.get("system:cardiovascular")!;
		assert.ok(dist(gi, cardio) >= gi.r + cardio.r);
		// The bounds hold every frame (the whole picture, whatever a filter leaves drawn).
		for (const f of layout.frames.values()) {
			assert.ok(f.x - f.r >= layout.bounds.minX && f.x + f.r <= layout.bounds.maxX);
			assert.ok(f.y - f.r >= layout.bounds.minY && f.y + f.r <= layout.bounds.maxY);
		}
	});

	it("an open topic spreads its facts inside its ring, with its header on top; the layout is repeatable", () => {
		const view = build({ expanded: new Set(["t_sbo"]) });
		const layout = layoutClusterView(view);
		const id = topicNodeId("t_sbo");
		const ring = layout.centre.get(id)!;
		const r = layout.radius.get(id)!;
		assert.equal(r, openRadius(3));
		for (const f of ["a1", "a2", "a3"]) assert.ok(dist(ring, layout.positions.get(f)!) <= r, f);
		assert.deepEqual(layout.positions.get(id), { x: ring.x, y: ring.y - r });
		assert.deepEqual(layoutClusterView(view).positions, layout.positions);
	});

	it("a fully open chain's junction sits at the mean of the facts it joins", () => {
		const view = build({ expanded: new Set(["t_sbo", "t_ap", "t_hf"]) });
		const layout = layoutClusterView(view);
		const pts = ["a3", "b2", "c1"].map((id) => layout.positions.get(id)!);
		const j = layout.positions.get("arg_1")!;
		assert.ok(Math.abs(j.x - (pts[0]!.x + pts[1]!.x + pts[2]!.x) / 3) < 1e-9);
		assert.ok(Math.abs(j.y - (pts[0]!.y + pts[1]!.y + pts[2]!.y) / 3) < 1e-9);
	});
});

describe("breadcrumb", () => {
	it("is System › Topic › Aspect, each part naming the branch it opens", () => {
		const parts = factBreadcrumb("a3", placement);
		assert.deepEqual(parts.map((p) => p.label), ["GI/Hepatobiliary", "Small-bowel obstruction", "Workup"]);
		assert.deepEqual(parts.map((p) => p.selection), [
			{ system: "gi" },
			{ system: "gi", topicId: "t_sbo" },
			{ system: "gi", topicId: "t_sbo", aspect: "workup" },
		]);
	});

	it("is empty for an unplaced fact, or when nothing is wired", () => {
		assert.deepEqual(factBreadcrumb("u1", placement), []);
		assert.deepEqual(factBreadcrumb("a1", undefined), []);
	});

	it("renders as buttons in order; clicking is wired to the branch; unplaced says so", () => {
		const picked: unknown[] = [];
		const html = renderToStaticMarkup(
			createElement(FactBreadcrumb, { parts: factBreadcrumb("a3", placement), onJump: (s) => picked.push(s) }),
		);
		assert.match(html, /aria-label="Where this fact sits"/);
		const order = ["fact-breadcrumb-system", "fact-breadcrumb-topic", "fact-breadcrumb-aspect"].map((t) => html.indexOf(`data-testid="${t}"`));
		assert.ok(order.every((i) => i > 0) && order[0]! < order[1]! && order[1]! < order[2]!);
		assert.match(html, />GI\/Hepatobiliary</);
		assert.match(html, />Small-bowel obstruction</);
		assert.match(html, />Workup</);
		assert.equal((html.match(/<button/g) ?? []).length, 3);
		// The element tree: each button's handler passes its own selection.
		const tree = FactBreadcrumb({ parts: factBreadcrumb("a3", placement), onJump: (s) => picked.push(s) }) as React.ReactElement<{ children: React.ReactElement }>;
		const items = (tree.props.children as React.ReactElement<{ children: React.ReactElement[] }>).props.children;
		const buttons = items.map((li) => (li.props as { children: unknown[] }).children.flat().find((c) => c && typeof c === "object" && (c as React.ReactElement).type === "button") as React.ReactElement<{ onClick: () => void }>);
		for (const b of buttons) b.props.onClick();
		assert.deepEqual(picked, [{ system: "gi" }, { system: "gi", topicId: "t_sbo" }, { system: "gi", topicId: "t_sbo", aspect: "workup" }]);

		const none = renderToStaticMarkup(createElement(FactBreadcrumb, { parts: [], onJump: () => {} }));
		assert.match(none, /data-testid="fact-breadcrumb-unplaced"/);
		assert.match(none, /Not placed yet/);
	});
});

describe("recents", () => {
	it("puts the newest first, with no repeats, capped", () => {
		assert.deepEqual(pushRecent(["a", "b", "c"], "b"), ["b", "a", "c"]);
		assert.deepEqual(pushRecent([], "a"), ["a"]);
		const many = Array.from({ length: RECENT_LIMIT + 3 }, (_, i) => `n${i}`).reduce<string[]>((acc, id) => pushRecent(acc, id), []);
		assert.equal(many.length, RECENT_LIMIT);
		assert.equal(many[0], `n${RECENT_LIMIT + 2}`);
	});

	it("drops facts that no longer exist and reads junk storage as empty", () => {
		assert.deepEqual(resolveRecents(["a1", "gone", "b1"], nodes).map((n) => n.id), ["a1", "b1"]);
		assert.deepEqual(parseRecents(null), []);
		assert.deepEqual(parseRecents("not json"), []);
		assert.deepEqual(parseRecents('{"a":1}'), []);
		assert.deepEqual(parseRecents('["a", 3, "b"]'), ["a", "b"]);
	});

	it("renders as a short list that jumps back; nothing when empty", () => {
		const html = renderToStaticMarkup(createElement(RecentFacts, { facts: resolveRecents(["b1", "a1"], nodes), currentId: "b1", onOpen: () => {} }));
		assert.match(html, /data-testid="recent-facts"/);
		assert.ok(html.indexOf("recent-fact-b1") < html.indexOf("recent-fact-a1"));
		assert.match(html, /aria-current="true"/);
		assert.equal(renderToStaticMarkup(createElement(RecentFacts, { facts: [], onOpen: () => {} })), "");
	});
});

describe("focus chip and view switch", () => {
	it("the chip names the fact and has an obvious way out", () => {
		const html = renderToStaticMarkup(createElement(FocusChip, { name: "Adhesions", onExit: () => {} }));
		assert.match(html, /Focused on/);
		assert.match(html, /Adhesions/);
		assert.match(html, /data-testid="focus-exit"/);
		assert.match(html, /Exit focus/);
	});

	it("the switch marks the current view and offers Collapse all only while topics are open", () => {
		const topics = renderToStaticMarkup(createElement(ViewModeToggle, { mode: "topics", onMode: () => {}, openTopics: 2, onCollapseAll: () => {} }));
		assert.match(topics, /data-testid="view-mode-topics"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-testid="view-mode-topics"/);
		assert.match(topics, /data-testid="collapse-all"/);
		const none = renderToStaticMarkup(createElement(ViewModeToggle, { mode: "topics", onMode: () => {}, openTopics: 0, onCollapseAll: () => {} }));
		assert.doesNotMatch(none, /collapse-all/);
		const all = renderToStaticMarkup(createElement(ViewModeToggle, { mode: "all", onMode: () => {}, openTopics: 3, onCollapseAll: () => {} }));
		assert.doesNotMatch(all, /collapse-all/);
	});

	it("the outline panel carries the switch and the recents when given them", () => {
		const html = renderToStaticMarkup(
			createElement(GraphOutlinePanel, {
				nodes,
				placement,
				selection: null,
				onSelect: () => {},
				onClear: () => {},
				onOpenFact: () => {},
				onClose: () => {},
				onChanged: () => {},
				view: { mode: "topics", onMode: () => {}, openTopics: 0, onCollapseAll: () => {} },
				recents: [nodes[0]!],
			}),
		);
		assert.match(html, /data-testid="view-mode-topics"/);
		assert.match(html, /data-testid="recent-fact-a1"/);
		const bare = renderToStaticMarkup(
			createElement(GraphOutlinePanel, { nodes, placement, selection: null, onSelect: () => {}, onClear: () => {}, onOpenFact: () => {}, onClose: () => {}, onChanged: () => {} }),
		);
		assert.doesNotMatch(bare, /view-mode|recent-facts/);
	});
});
