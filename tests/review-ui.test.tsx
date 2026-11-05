/**
 * The Obsidian settings section and the Review panel: presentational markup
 * and the pure helpers. Effects and fetches don't run under
 * renderToStaticMarkup, so the views are pinned directly.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ObsidianView, reportLine, statusLine } from "../components/settings/obsidian-section.tsx";
import { ReviewPanelView, runLine, runPercent, scriptLine } from "../components/review-panel.tsx";
import type { ObsidianStatus, ReviewRunState, ReviewStatus, ScriptListItem } from "../src/core/index.ts";

const noop = () => {};

describe("the Obsidian settings section", () => {
	const view = (status: ObsidianStatus | null, over: Partial<Parameters<typeof ObsidianView>[0]> = {}) =>
		renderToStaticMarkup(createElement(ObsidianView, { status, draft: status?.vaultPath ?? "", onDraft: noop, onSave: noop, onClear: noop, onSyncNow: noop, busy: false, error: null, ...over }));

	it("starts off: an empty field, no status controls, and a suggestion that is offered but not applied", () => {
		const html = view({ vaultPath: null, appFolder: null, suggested: "/Users/me/SlideScribe/vault", state: "off" });
		assert.match(html, /data-testid="obsidian-path"[^>]*value=""/);
		assert.match(html, /Off — choose your vault folder to start\./);
		assert.match(html, /data-testid="obsidian-suggest"[^>]*>Use \/Users\/me\/SlideScribe\/vault</);
		assert.ok(!html.includes("obsidian-sync") && !html.includes("obsidian-clear"));
		assert.match(html, /obsidian-save"[^>]*disabled/);
	});

	it("says what it writes and where, and that nothing flows back", () => {
		const html = view({ vaultPath: "/v", appFolder: "/v/LearnHarness", suggested: null, state: "idle", lastSyncAt: "2026-11-05T08:00:00Z", lastReport: { written: 4, unchanged: 10, moved: 1, removed: 0, salvaged: 0, skipped: 0, assets: 0, notes: 14 } });
		assert.match(html, /Notes go in \/v\/LearnHarness/);
		assert.match(html, /nothing you change in Obsidian flows back/);
		assert.match(html, /Up to date\./);
		assert.match(html, /Last update: 14 notes · 4 written · 1 renamed/);
		assert.ok(html.includes("obsidian-sync") && html.includes("obsidian-clear"));
		assert.ok(!html.includes("obsidian-suggest"));
	});

	it("shows a problem as an alert", () => {
		const html = view({ vaultPath: "/gone", appFolder: "/gone/LearnHarness", suggested: null, state: "error", problem: "That folder doesn't exist." });
		assert.match(html, /role="alert">That folder doesn(&#x27;|')t exist\./);
	});

	it("describes each state plainly", () => {
		const base = { vaultPath: "/v", appFolder: "/v/LearnHarness", suggested: null };
		assert.match(statusLine({ ...base, state: "waiting" }), /updating in a moment/);
		assert.match(statusLine({ ...base, state: "syncing" }), /Updating your notes/);
		assert.match(statusLine({ ...base, state: "idle" }), /first update is on its way/);
		assert.equal(reportLine({ ...base, state: "idle" }), null);
		assert.match(reportLine({ ...base, state: "idle", lastReport: { written: 0, unchanged: 3, moved: 0, removed: 2, salvaged: 1, skipped: 1, assets: 0, notes: 3 } })!, /2 removed · 1 kept with your own text · 1 left alone/);
	});
});

describe("the Review panel", () => {
	const script = (over: Partial<ScriptListItem> = {}): ScriptListItem => ({
		slug: "acute-pancreatitis",
		title: "Acute pancreatitis",
		generatedAt: "2026-11-05T08:00:00Z",
		freshness: "current",
		reasons: [],
		claims: 40,
		gaps: 2,
		images: 3,
		...over,
	});
	const run = (over: Partial<ReviewRunState> = {}): ReviewRunState => ({ kind: "all", running: true, stopping: false, startedAt: "2026-11-05T08:00:00Z", total: 10, written: 2, skipped: 1, failed: [], current: "Cholecystitis", phase: "gathering", ...over });
	const status = (over: Partial<ReviewStatus> = {}): ReviewStatus => ({ vault: { configured: true }, scripts: [], catalogue: null, run: null, ...over });
	const view = (s: ReviewStatus | null, over: Partial<Parameters<typeof ReviewPanelView>[0]> = {}) =>
		renderToStaticMarkup(createElement(ReviewPanelView, { status: s, error: null, busy: false, onWriteAll: noop, onStop: noop, onDismiss: noop, onRefreshScript: noop, onOpenObsidianSettings: noop, ...over }));

	it("offers the do-all button and an empty list at the start", () => {
		const html = view(status());
		assert.match(html, /Write scripts for every illness/);
		assert.match(html, /No illness scripts yet\./);
		assert.ok(!html.includes('review-write-all" disabled'));
		assert.match(html, /Type an illness below/);
	});

	it("without a vault, points at Settings and blocks the buttons", () => {
		const html = view(status({ vault: { configured: false } }));
		assert.match(html, /data-testid="review-no-vault"/);
		assert.match(html, /Set your vault folder in Settings → Obsidian/);
		assert.match(html, /data-testid="review-write-all"[^>]*disabled/);
		assert.match(view(status({ vault: { configured: true, problem: "That folder doesn't exist." } })), /role="alert"[^>]*>That folder doesn(&#x27;|')t exist\./);
	});

	it("shows progress while a run goes: a bar, the current illness, counts, and Stop", () => {
		const html = view(status({ run: run() }));
		assert.match(html, /role="progressbar"[^>]*aria-valuenow="30"/);
		assert.match(html, /Reading your notes, library and Expert AI answers: Cholecystitis \(4 of 10\)/);
		assert.match(html, /2 written · 1 already up to date/);
		assert.ok(html.includes('data-testid="review-stop"'));
		assert.match(html, /data-testid="review-write-all"[^>]*disabled/);
		assert.match(view(status({ run: run({ stopping: true }) })), />Stopping…</);
	});

	it("a single script has no percentage; a finished run shows its result and failures with Dismiss", () => {
		assert.equal(runPercent(run({ kind: "one", total: 1 })), null);
		assert.equal(runLine(run({ kind: "one", total: 1, current: "Gout", phase: "drawing" })), "Preparing the images: Gout");
		const html = view(status({ run: run({ running: false, message: "Done: 2 written, 1 already up to date, 1 failed.", failed: [{ title: "Gout", error: "boom" }] }) }));
		assert.match(html, /Done: 2 written/);
		assert.match(html, /data-testid="review-run-failed"[^>]*>Gout: boom/);
		assert.ok(html.includes("review-dismiss") && !html.includes("review-stop"));
	});

	it("lists scripts; an out-of-date one says why and offers Refresh", () => {
		const html = view(status({ scripts: [script(), script({ slug: "gout", title: "Gout", freshness: "outdated", reasons: ["2 notes it was built from changed"] })] }));
		assert.match(html, /Up to date · 40 statements · 3 images · 2 gaps marked/);
		assert.match(html, /Out of date — 2 notes it was built from changed/);
		assert.ok(html.includes('data-testid="review-refresh-gout"'));
		assert.ok(!html.includes('data-testid="review-refresh-acute-pancreatitis"'));
		assert.match(scriptLine(script({ images: 1, gaps: 0 })), /1 image$/);
	});

	it("shows an error from the server", () => {
		assert.match(view(status(), { error: "Say which illness" }), /data-testid="review-error"[^>]*>Say which illness/);
	});
});
