/**
 * The organizer panel's pure/presentational parts (components/graph-organizer.tsx):
 * the before → after cards, Accept/Reject/Undo states, the conversation sent to
 * the agent, and the Organize control's place in the graph chrome. Effects and
 * fetches don't run under renderToStaticMarkup, so the bodies are pinned directly.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	GraphOrganizerControl,
	OrganizerChangeCard,
	OrganizerPanelBody,
	OrganizerProposalCard,
	toAgentMessages,
	type OrganizerItem,
} from "../components/graph-organizer.tsx";
import { GraphChromeRow } from "../components/graph-view.tsx";
import { EMPTY_TAG_FILTER } from "../components/graph-tags.tsx";
import type { GraphRenderSettings } from "../components/graph-canvas.ts";
import type { OrganizerHistoryItem, OrganizerProposal } from "../src/core/index.ts";

const noop = () => {};
const proposal: OrganizerProposal = {
	id: "prop_1",
	summary: "Rename and retag",
	createdAt: "2026-11-04T10:00:00.000Z",
	changes: [],
	previews: [
		{ op: "rename_node", title: "Rename “Uraemia” → “Uraemic syndrome”", rows: [{ field: "Name", before: "Uraemia", after: "Uraemic syndrome" }] },
		{ op: "create_node", title: "Create node “Hyperkalaemia”", rows: [{ field: "Name", after: "Hyperkalaemia" }] },
	],
};
const card = (decision: Parameters<typeof OrganizerProposalCard>[0]["decision"], over: Partial<Parameters<typeof OrganizerProposalCard>[0]> = {}) =>
	renderToStaticMarkup(
		createElement(OrganizerProposalCard, { proposal, decision, canUndo: false, onAccept: noop, onReject: noop, onUndo: noop, ...over }),
	);

describe("a change card shows what changes", () => {
	it("before (struck through) and after for an edit; only after for a creation", () => {
		const edit = renderToStaticMarkup(createElement(OrganizerChangeCard, { preview: proposal.previews[0]! }));
		assert.match(edit, /Rename “Uraemia” → “Uraemic syndrome”/);
		assert.match(edit, /data-testid="organizer-before"[^>]*>Uraemia</);
		assert.match(edit, /data-testid="organizer-after"[^>]*>Uraemic syndrome</);
		const create = renderToStaticMarkup(createElement(OrganizerChangeCard, { preview: proposal.previews[1]! }));
		assert.ok(!create.includes("organizer-before"));
		assert.match(create, /Hyperkalaemia/);
	});
});

describe("a proposal waits for the learner", () => {
	it("pending: every change is listed with Accept and Reject; no Undo", () => {
		const html = card("pending");
		assert.equal((html.match(/data-testid="organizer-change"/g) ?? []).length, 2);
		assert.ok(html.includes('data-testid="organizer-accept"') && html.includes('data-testid="organizer-reject"'));
		assert.ok(!html.includes("organizer-undo"));
	});

	it("while applying, both buttons are disabled", () => {
		const html = card("applying");
		assert.equal((html.match(/disabled=""/g) ?? []).length, 2);
	});

	it("applied: no longer decidable; Undo only on the newest set", () => {
		const newest = card("applied", { canUndo: true });
		assert.ok(!newest.includes("organizer-accept"));
		assert.match(newest, /Applied/);
		assert.ok(newest.includes('data-testid="organizer-undo"'));
		assert.ok(!card("applied", { canUndo: false }).includes("organizer-undo"));
	});

	it("rejected, undone and failed say nothing was left changed, and failed lists the reasons", () => {
		assert.match(card("rejected"), /Rejected — nothing changed/);
		assert.match(card("undone"), /back as it was/);
		const failed = card("failed", { problems: ["Change 1 (rename node): “n_x” is not a node in the graph."], error: "nothing was applied" });
		assert.match(failed, /Not applied — nothing changed/);
		assert.match(failed, /is not a node in the graph/);
		assert.ok(!failed.includes("organizer-accept"));
	});
});

describe("the conversation sent to the agent", () => {
	it("tells it what the learner decided about each proposal", () => {
		const items: OrganizerItem[] = [
			{ kind: "user", text: "retag Uraemia" },
			{ kind: "assistant", text: "Proposed.", proposal, decision: "rejected" },
			{ kind: "error", text: "network" },
			{ kind: "user", text: "no, add Hyperkalaemia instead" },
		];
		const sent = toAgentMessages(items);
		assert.deepEqual(sent.map((m) => m.role), ["user", "assistant", "user"], "errors are not part of the conversation");
		assert.match(sent[1]!.text, /Proposed\.\n\n\[The learner rejected this proposal; nothing was changed\.\]/);
		assert.match(toAgentMessages([{ kind: "assistant", text: "x", proposal, decision: "applied" }])[0]!.text, /accepted this proposal and it was applied/);
		assert.match(toAgentMessages([{ kind: "assistant", text: "x", proposal }])[0]!.text, /not decided on this proposal yet/);
		assert.equal(toAgentMessages([{ kind: "assistant", text: "Which node?" }])[0]!.text, "Which node?", "plain replies get no note");
	});
});

describe("the panel", () => {
	const history: OrganizerHistoryItem[] = [{ id: "org_1", appliedAt: "2026-11-04T10:00:00.000Z", summary: "s", changeCount: 2, undone: false, canUndo: true }];
	const panel = (items: OrganizerItem[], busy = false) =>
		renderToStaticMarkup(
			createElement(OrganizerPanelBody, { items, history, busy, input: "", onInput: noop, onSend: noop, onClose: noop, onAccept: noop, onReject: noop, onUndo: noop }),
		);

	it("opens with a plain statement of what it can and cannot do", () => {
		const html = panel([]);
		assert.match(html, /nothing happens until you accept/);
		assert.match(html, /can&#x27;t delete or merge nodes|can&apos;t delete or merge nodes/);
	});

	it("shows Undo only on the proposal whose set is the newest applied one", () => {
		const items: OrganizerItem[] = [
			{ kind: "user", text: "do it" },
			{ kind: "assistant", text: "Proposed.", proposal, decision: "applied", entryId: "org_1" },
			{ kind: "assistant", text: "Earlier.", proposal, decision: "applied", entryId: "org_0" },
		];
		const html = panel(items);
		assert.equal((html.match(/data-testid="organizer-undo"/g) ?? []).length, 1);
	});

	it("shows a working line and a disabled Send while the agent runs", () => {
		const html = panel([{ kind: "user", text: "hi" }], true);
		assert.match(html, /Looking at your graph/);
		assert.match(html, /data-testid="organizer-send"[^>]*disabled=""|disabled=""[^>]*data-testid="organizer-send"/);
	});
});

describe("the Organize control in the graph chrome", () => {
	const ref = { current: null };
	const base = {
		query: "",
		onQuery: noop,
		noMatch: false,
		importing: false,
		searchInputRef: ref,
		fileInputRef: ref,
		onImportFiles: noop,
		settings: {} as GraphRenderSettings,
		changeSettings: noop,
		onOpenChains: noop,
		tags: { nodes: [], filter: EMPTY_TAG_FILTER, onFilter: noop, onBackfilled: noop },
	};
	const organizer = { onGraphChanged: noop };

	it("renders only when supplied and the graph is not empty", () => {
		assert.ok(renderToStaticMarkup(createElement(GraphChromeRow, { ...base, isEmpty: false, organizer })).includes("open-organizer"));
		assert.ok(!renderToStaticMarkup(createElement(GraphChromeRow, { ...base, isEmpty: false })).includes("open-organizer"));
		assert.ok(!renderToStaticMarkup(createElement(GraphChromeRow, { ...base, isEmpty: true, organizer })).includes("open-organizer"));
	});

	it("starts closed", () => {
		assert.ok(!renderToStaticMarkup(createElement(GraphOrganizerControl, { onGraphChanged: noop })).includes("organizer-panel"));
		assert.ok(renderToStaticMarkup(createElement(GraphOrganizerControl, { onGraphChanged: noop, initiallyOpen: true })).includes("organizer-panel"));
	});
});
