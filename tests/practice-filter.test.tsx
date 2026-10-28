import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ChainTableBody, ChainTableOverlay } from "../components/chain-table.tsx";
import { EMPTY_TAG_FILTER, setTagFilter } from "../components/graph-tags.tsx";
import type { GraphNode } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
});
const node = (id: string, systems?: GraphNode["systems"], factType?: GraphNode["factType"]): GraphNode => ({
	id, name: id, statement: `${id} statement`, aliases: [], provenance: [],
	createdAt: "2026-10-01T00:00:00.000Z", systems, factType,
});
const nodes = [node("renal-next", ["renal", "endocrine"], "management"),
	node("renal-other", ["renal"], "management"), node("mechanism", ["renal"], "mechanism"),
	node("cardio", ["cardiovascular"], "management"), node("untagged")];
const filter = { systems: new Set<NonNullable<GraphNode["systems"]>[number]>(["renal"]),
	factTypes: new Set<NonNullable<GraphNode["factType"]>>(["management"]) };
const chains = [{ id: "arg_1", premises: ["renal-next"], conclusion: "renal-other", provenance: [], createdAt: "" }];
let root: Root | undefined;
let host: HTMLDivElement;
async function mount(element: React.ReactNode) {
	host = document.createElement("div"); document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(element));
}
function button() { return host.querySelector<HTMLButtonElement>('[data-testid="practice-select-all-shown"]')!; }
afterEach(async () => {
	await act(async () => { root?.unmount(); setTagFilter(EMPTY_TAG_FILTER); });
	root = undefined; host?.remove();
});

it("shared filters add every matching proposition while preserving picks hidden by filters", async () => {
	setTagFilter(filter);
	let selected: ReadonlySet<string> = new Set(["cardio"]);
	function Picker() {
		const [selection, update] = React.useState(selected);
		return <ChainTableOverlay open nodes={nodes} chains={chains} sessions={{}} fileSources={{}}
			onClose={() => {}} selectMode controlledSelection={selection}
			onSelectionChange={(next) => { selected = next; update(next); }} />;
	}
	await mount(<Picker />);
	assert.ok(button());
	assert.equal(button().disabled, false);
	await act(async () => button().click());
	assert.deepEqual([...selected].sort(), ["cardio", "renal-next", "renal-other"]);
	assert.equal(button().disabled, true, "repeating the action is an additive no-op");
	await act(async () => setTagFilter(EMPTY_TAG_FILTER));
	await act(async () => button().click());
	assert.deepEqual([...selected].sort(), nodes.map((n) => n.id).sort(), "no tags selected includes untagged nodes");
});

it("search narrows shown chains; all their tag-matching members are added, without unrelated nodes", async () => {
	let added: string[] = [];
	await mount(<ChainTableBody nodes={nodes} chains={chains} sessions={{}} fileSources={{}}
		query="renal-next" onQuery={() => {}} sort={{ col: "name", dir: 1 }} onSort={() => {}}
		selection={new Set()} expandedClusters={new Set()} expandedChains={new Set()}
		onToggleCluster={() => {}} onToggleChain={() => {}} onClear={() => {}} onDelete={() => {}}
		onClose={() => {}} selectMode tagFilter={filter}
		onToggleNodes={(ids, next) => { assert.equal(next, true); added = ids; }} />);
	await act(async () => button().click());
	assert.deepEqual(added.sort(), ["renal-next", "renal-other"], "search keeps a whole visible chain");
});

it("no matches disables the action, and ordinary chain management has no select-all action", async () => {
	setTagFilter({ systems: new Set(["psychiatry"]), factTypes: new Set() });
	const props = { open: true, nodes, chains, sessions: {}, fileSources: {}, onClose: () => {} };
	await mount(<ChainTableOverlay {...props} selectMode />);
	assert.equal(button().disabled, true);
	await act(async () => root!.render(<ChainTableOverlay {...props} />));
	assert.equal(button(), null);
	assert.ok(host.textContent?.includes("5 nodes"), "ordinary management ignores practice filters");
});
