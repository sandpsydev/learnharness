/**
 * The Session recap button's panel: presentational markup and the pure
 * helpers. Effects and fetches don't run under renderToStaticMarkup, so the
 * view is pinned directly.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionRecapView, movedOnLine, recapRunLine } from "../components/session-recap.tsx";
import type { RecapStatus } from "../src/core/index.ts";

const noop = () => {};
const status = (over: Partial<RecapStatus> = {}): RecapStatus => ({ vault: { configured: true }, busy: false, run: null, recap: null, ...over });
const view = (s: RecapStatus | null, over: Partial<Parameters<typeof SessionRecapView>[0]> = {}) =>
	renderToStaticMarkup(createElement(SessionRecapView, { status: s, error: null, posting: false, onWrite: noop, onStop: noop, onDismiss: noop, onOpenObsidianSettings: noop, ...over }));

describe("the Session recap panel", () => {
	it("starts with a Write recap button and says it only runs on a click", () => {
		const html = view(status());
		assert.match(html, /data-testid="session-recap-write"[^>]*>Write recap</);
		assert.ok(!html.includes('session-recap-write" disabled'));
		assert.match(html, /so it only runs when you click\./);
	});

	it("points at Settings → Obsidian and disables the button when no vault folder is set", () => {
		const html = view(status({ vault: { configured: false } }));
		assert.match(html, /data-testid="session-recap-no-vault"/);
		assert.match(html, /Set your vault folder in Settings → Obsidian/);
		assert.match(html, /session-recap-write"[^>]*disabled/);
	});

	it("shows a vault problem as an alert and disables the button", () => {
		const html = view(status({ vault: { configured: true, problem: "That folder doesn't exist." } }));
		assert.match(html, /role="alert"[^>]*>That folder doesn(&#x27;|')t exist\./);
		assert.match(html, /session-recap-write"[^>]*disabled/);
	});

	it("shows progress with a Stop button while it runs, and no write button", () => {
		const html = view(status({ busy: true, run: { chatId: "c", running: true, startedAt: "2026-11-12T08:00:00Z", phase: "writing" } }));
		assert.match(html, /data-testid="session-recap-run-line"/);
		assert.match(html, /Writing the recap from what the session covered…/);
		assert.match(html, /data-testid="session-recap-stop"/);
		assert.ok(!html.includes("session-recap-write"));
	});

	it("shows a plain error from the run, with a way to dismiss it and to try again", () => {
		const html = view(status({ run: { chatId: "c", running: false, startedAt: "2026-11-12T08:00:00Z", error: "Couldn't write the recap: not signed in." } }));
		assert.match(html, /data-testid="session-recap-run-error"[^>]*>Couldn(&#x27;|')t write the recap: not signed in\./);
		assert.match(html, /data-testid="session-recap-dismiss"/);
		assert.match(html, /data-testid="session-recap-write"[^>]*>Write recap</);
	});

	it("shows a request error from the click itself", () => {
		const html = view(status(), { error: "This session hasn't covered anything yet — there is nothing to recap." });
		assert.match(html, /data-testid="session-recap-error"[^>]*>This session hasn(&#x27;|')t covered anything yet/);
	});

	it("offers to open the note in Obsidian and shows its path once written", () => {
		const html = view(
			status({ recap: { generatedAt: new Date().toISOString(), notePath: "Session recaps/2026-11-10 Loop diuretics.md", absolutePath: "/v/LearnHarness/Session recaps/2026-11-10 Loop diuretics.md", obsidianUrl: "obsidian://open?path=%2Fv%2FLearnHarness%2FSession%20recaps%2F2026-11-10%20Loop%20diuretics.md", newMessages: 0, topics: 3 } }),
		);
		assert.match(html, /<a href="obsidian:\/\/open\?path=%2Fv%2FLearnHarness[^"]*" data-testid="session-recap-open"/);
		assert.match(html, />Open in Obsidian</);
		assert.match(html, /data-testid="session-recap-path"[^>]*>\/v\/LearnHarness\/Session recaps\/2026-11-10 Loop diuretics\.md</);
		assert.match(html, /3 topics/);
		assert.match(html, /data-testid="session-recap-write"[^>]*>Refresh recap</);
		assert.match(html, /What you wrote under “My notes” in Obsidian is kept\./);
		assert.ok(!html.includes("session-recap-moved"));
	});

	it("shows progress for each picture while they are found, and says what was left out when done", () => {
		const running = view(status({ busy: true, run: { chatId: "c", running: true, startedAt: "2026-11-12T08:00:00Z", phase: "pictures", current: "Finding a picture: calcium oxalate stones (2 of 3)" } }));
		assert.match(running, /Finding a picture: calcium oxalate stones \(2 of 3\)/);
		const done = view(status({ run: { chatId: "c", running: false, startedAt: "x", message: "2 of 3 new pictures added; 1 couldn't be found, so it was left out." }, recap: { generatedAt: new Date().toISOString(), notePath: "x.md", absolutePath: "/v/x.md", obsidianUrl: "obsidian://open?path=x", newMessages: 0, topics: 2 } }));
		assert.match(done, /data-testid="session-recap-message"[^>]*>2 of 3 new pictures added; 1 couldn(&#x27;|')t be found/);
	});

	it("says when the session has moved on since the recap", () => {
		const html = view(status({ recap: { generatedAt: new Date().toISOString(), notePath: "Session recaps/x.md", absolutePath: "/v/x.md", obsidianUrl: "obsidian://open?path=x", newMessages: 4, topics: 1 } }));
		assert.match(html, /The session has 4 new messages since this recap\. Refresh it to include them\./);
		assert.match(html, /1 topic</);
	});

	it("holds the button while another session's recap is being written", () => {
		const html = view(status({ busy: true }));
		assert.match(html, /Another session(&#x27;|')s recap is being written/);
		assert.match(html, /session-recap-write"[^>]*disabled/);
	});
});

describe("the Session recap helpers", () => {
	it("describes each phase", () => {
		assert.equal(recapRunLine("reading"), "Reading the session…");
		assert.equal(recapRunLine("saving"), "Saving it into Obsidian…");
		assert.equal(recapRunLine("pictures"), "Finding pictures for the visual points…");
		assert.equal(recapRunLine("pictures", "Finding a picture: renal stones (2 of 3)"), "Finding a picture: renal stones (2 of 3)");
		assert.equal(recapRunLine(undefined), "Working…");
	});

	it("says nothing about new messages when there are none", () => {
		assert.equal(movedOnLine(0), null);
		assert.match(movedOnLine(1)!, /1 new message since/);
	});
});
