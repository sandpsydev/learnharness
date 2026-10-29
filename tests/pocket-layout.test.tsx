/**
 * Pocket mode, phone layout (Phase 8): the phone's home, quick practice and
 * the view-only Expert AI queue, plus proof that nothing the Mac keeps for
 * itself (graph, settings, Anki, imports, asking Expert AI) is offered on a
 * phone. Everything renders from fake state: no network, keys or accounts.
 *
 * Phone widths are a CSS matter (`max-sm:` / `sm:`), which a static render
 * can't evaluate, so these tests check the screens' contents and the classes
 * that hide or show them; the phone-width pixels were checked in a browser.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { PHONE_QUERY, PHONE_TABS, PhoneNavView, PhoneSetupNote, ResponsiveSwitch, showsPhoneNav } from "../components/phone.tsx";
import { PhoneHomeView, RECENT_SESSIONS, recentFirst } from "../components/phone-home.tsx";
import { QuickPracticeView } from "../components/phone-practice.tsx";
import { QueueView, type QueueRow } from "../components/phone-queue.tsx";
import { SidebarToggle } from "../components/sidebar.tsx";
import { DraftShell } from "../components/new-session.tsx";
import type { useCaptures } from "../components/captures.tsx";
import type { ChatListItem, GraphNode, OrganSystem } from "../src/core/index.ts";

const documentFor = (node: React.ReactNode) => parseHTML(`<html><body>${renderToStaticMarkup(node)}</body></html>`).document;
const noop = async () => {};

/** What a phone must never be offered: the Mac-only parts of the app. */
const MAC_ONLY = /settings|anki|import|slidescribe|library|graph|knowledge map|chain table|pick nodes|ask expert|send to learnharness/i;
const MAC_ONLY_HREF = /^\/(settings|graph|library|anki|import)/;

function assertNoMacOnlyActions(document: Document, where: string) {
	const text = document.body.textContent ?? "";
	assert.doesNotMatch(text, MAC_ONLY, `${where}: Mac-only wording on screen`);
	for (const a of document.querySelectorAll("a")) {
		assert.doesNotMatch(a.getAttribute("href") ?? "", MAC_ONLY_HREF, `${where}: link to a Mac-only page`);
	}
	assert.equal(document.querySelectorAll('input[type="file"]').length, 0, `${where}: no file control`);
}

const captureState = (captures: Array<{ id: string; text: string }> = []) => ({
	captures: captures.map((c) => ({ ...c, status: "open" as const, createdAt: "", updatedAt: "" })),
	error: null, busyId: null,
	add: async () => null, markDone: noop, remove: noop, start: noop, refresh: noop,
}) as unknown as ReturnType<typeof useCaptures>;

const chat = (id: string, overrides: Partial<ChatListItem> = {}): ChatListItem => ({
	id, title: `Session ${id}`, kind: "teach",
	createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
	messageCount: 2, phase: "teach", pendingQuestion: false, pendingProblem: false, busy: false, compacting: false,
	...overrides,
});

const node = (id: string, systems?: OrganSystem[]): GraphNode => ({
	id, name: id, statement: `${id} statement`, aliases: [], createdAt: "2026-10-01T00:00:00.000Z", provenance: [], systems,
});

describe("what counts as a phone", () => {
	it("is anything narrower than Tailwind's sm (640px), which the desktop window can never be", () => {
		assert.equal(PHONE_QUERY, "(max-width: 639.98px)");
		const main = fs.readFileSync(path.join(import.meta.dirname, "../electron/main.cjs"), "utf8");
		assert.match(main, /minWidth:\s*640/, "the desktop window floor is the phone boundary");
	});

	it("the responsive switch holds both screens for the first frame, each shown only at its own width", () => {
		const document = documentFor(<ResponsiveSwitch desktop={<p id="mac">mac</p>} phone={<p id="phone">phone</p>} />);
		assert.ok(document.querySelector(".max-sm\\:hidden #mac"), "the desktop screen is hidden below sm");
		assert.ok(document.querySelector(".sm\\:hidden #phone"), "the phone screen is hidden from sm up");
	});
});

describe("the phone's tab bar and sidebar", () => {
	it("has Home, Practice and Expert AI tabs and nothing for the Mac-only parts", () => {
		const document = documentFor(<PhoneNavView pathname="/" />);
		const nav = document.querySelector('[data-testid="phone-nav"]')!;
		assert.ok(nav.className.includes("sm:hidden"), "only shown below sm");
		assert.deepEqual([...nav.querySelectorAll("a")].map((a) => a.getAttribute("href")), ["/", "/practice", "/queue"]);
		assert.deepEqual(PHONE_TABS.map((t) => t.label), ["Home", "Practice", "Expert AI"]);
		assertNoMacOnlyActions(document, "tab bar");
	});

	it("marks the current tab, and treats /capture as Home", () => {
		const current = (pathname: string) =>
			[...documentFor(<PhoneNavView pathname={pathname} />).querySelectorAll('a[aria-current="page"]')].map((a) => a.getAttribute("href"));
		assert.deepEqual(current("/"), ["/"]);
		assert.deepEqual(current("/capture"), ["/"]);
		assert.deepEqual(current("/practice"), ["/practice"]);
		assert.deepEqual(current("/queue"), ["/queue"]);
	});

	it("steps aside inside a session, where the composer owns the bottom edge", () => {
		assert.equal(showsPhoneNav("/chat/chat_abc"), false);
		assert.equal(showsPhoneNav("/chat/new"), false);
		assert.equal(renderToStaticMarkup(<PhoneNavView pathname="/chat/chat_abc" />), "");
		assert.equal(showsPhoneNav("/"), true);
	});

	it("hides the sidebar toggle on a phone (the sidebar carries Settings and the Anki dialog)", () => {
		assert.ok(documentFor(<SidebarToggle />).querySelector("span")!.className.includes("max-sm:hidden"));
		const source = fs.readFileSync(path.join(import.meta.dirname, "../components/sidebar.tsx"), "utf8");
		assert.match(source, /<aside\s+(?:\/\/[^\n]*\n\s*)*className=\{cn\("sidebar-motion[^"]*max-sm:hidden/, "the sidebar itself is hidden below sm");
	});
});

describe("the phone home", () => {
	it("leads with the capture box and its patient-identifier reminder; text only", () => {
		const document = documentFor(<PhoneHomeView captures={captureState()} sessions={[]} />);
		assert.equal(document.querySelectorAll("textarea").length, 1);
		assert.ok(document.querySelector('[data-testid="capture-privacy"]')!.textContent!.includes("No patient identifiers"));
		assert.equal(document.querySelector("textarea")!.getAttribute("autofocus"), null, "no keyboard pops up on arrival");
		assert.ok(document.querySelector("textarea")!.className.includes("text-base"), "16px, so phones don't zoom");
		assert.equal(document.querySelector('[data-testid="tonights-questions"]'), null, "nothing waiting, no empty card");
	});

	it("lists tonight's questions with start, done and delete", () => {
		const document = documentFor(<PhoneHomeView captures={captureState([{ id: "cp_1", text: "Why is the QT long?" }])} sessions={[]} />);
		const card = document.querySelector('[data-testid="tonights-questions"]')!;
		assert.ok(card.textContent!.includes("Why is the QT long?"));
		for (const id of ["capture-start", "capture-done", "capture-delete"]) assert.ok(card.querySelector(`[data-testid="${id}"]`), id);
	});

	it("starts a teaching session or Explain my miss from two big links", () => {
		const document = documentFor(<PhoneHomeView captures={captureState()} sessions={[]} />);
		assert.equal(document.querySelector('[data-testid="phone-new-teaching"]')!.getAttribute("href"), "/chat/new");
		assert.equal(document.querySelector('[data-testid="phone-explain-miss"]')!.getAttribute("href"), "/chat/new?mode=miss");
	});

	it("continues a session: the newest first, practice marked, 'Show all' past six", () => {
		const sessions = recentFirst(Array.from({ length: 8 }, (_, i) =>
			chat(`s${i}`, { updatedAt: `2026-10-0${i + 1}T00:00:00.000Z`, kind: i === 7 ? "practice" : "teach" })));
		assert.equal(sessions[0]!.id, "s7");
		const document = documentFor(<PhoneHomeView captures={captureState()} sessions={sessions} />);
		const rows = [...document.querySelectorAll('[data-testid="phone-session-row"]')];
		assert.equal(rows.length, RECENT_SESSIONS);
		assert.equal(rows[0]!.getAttribute("href"), "/chat/s7");
		assert.ok(rows[0]!.querySelector('[aria-label="Practice session"]'));
		assert.match(document.body.textContent!, /Show all 8/);
	});

	it("offers nothing that stays on the Mac", () => {
		const sessions = [chat("a"), chat("b", { kind: "practice" })];
		assertNoMacOnlyActions(documentFor(<PhoneHomeView captures={captureState([{ id: "cp_1", text: "Q" }])} sessions={sessions} />), "phone home");
	});
});

describe("quick practice", () => {
	const view = (nodes: GraphNode[] | null, selected: OrganSystem[] = [], extra: Partial<React.ComponentProps<typeof QuickPracticeView>> = {}) =>
		documentFor(<QuickPracticeView nodes={nodes} selected={new Set(selected)} onToggle={() => {}} onClear={() => {}} onStart={() => {}} {...extra} />);

	it("offers every organ system as a tap-able chip, with how many notes each has", () => {
		const document = view([node("a", ["renal"]), node("b", ["renal", "cardiovascular"]), node("c")]);
		assert.equal(document.querySelectorAll('[data-testid^="system-chip-"]').length, 14, "13 systems + All");
		assert.match(document.querySelector('[data-testid="system-chip-renal"]')!.textContent!, /Renal\/Urinary\s*2/);
		assert.match(document.querySelector('[data-testid="system-chip-cardiovascular"]')!.textContent!, /Cardiovascular\s*1/);
		assert.equal(document.querySelector('[data-testid="system-chip-psychiatry"]')!.hasAttribute("disabled"), true, "no notes, nothing to pick");
		assert.equal(document.querySelector('[data-testid="system-chip-all"]')!.getAttribute("aria-pressed"), "true");
	});

	it("shows which chips are on, and how many notes the round can draw on", () => {
		const nodes = [node("a", ["renal"]), node("b", ["renal", "cardiovascular"]), node("c", ["endocrine"])];
		const document = view(nodes, ["renal"]);
		assert.equal(document.querySelector('[data-testid="system-chip-renal"]')!.getAttribute("aria-pressed"), "true");
		assert.equal(document.querySelector('[data-testid="system-chip-all"]')!.getAttribute("aria-pressed"), "false");
		assert.match(document.body.textContent!, /2 notes to draw from/);
		assert.equal(document.querySelector('[data-testid="practice-start"]')!.hasAttribute("disabled"), false);
		assert.match(document.querySelector('[data-testid="practice-start"]')!.textContent!, /Start a 5-question round/);
	});

	it("can't start with an empty graph, or a system with no notes", () => {
		for (const [nodes, selected] of [[[], []], [[node("a", ["renal"])], ["endocrine"]]] as const) {
			const document = view([...nodes], [...selected]);
			assert.ok(document.querySelector('[data-testid="practice-empty"]'));
			assert.equal(document.querySelector('[data-testid="practice-start"]')!.hasAttribute("disabled"), true);
		}
		assert.equal(view(null).querySelector('[data-testid="practice-start"]')!.hasAttribute("disabled"), true, "still loading");
	});

	it("says why a start failed", () => {
		assert.match(view([node("a")], [], { error: "Set up your models on the Mac first, then try again." }).querySelector('[role="alert"]')!.textContent!, /on the Mac/);
	});

	it("chips are comfortable to tap, and nothing Mac-only is offered", () => {
		const document = view([node("a", ["renal"])]);
		assert.ok(document.querySelector('[data-testid="system-chip-renal"]')!.className.includes("min-h-11"));
		assertNoMacOnlyActions(document, "quick practice");
	});
});

describe("the Expert AI queue on the phone is view only", () => {
	const queue: QueueRow[] = [
		{ id: "vq_1", chatId: "chat_a", chatTitle: "Furosemide and potassium", prompt: "What is the guideline basis for escalating IV furosemide?", status: "queued", createdAt: "2026-10-29T08:00:00.000Z" },
		{ id: "vq_2", chatId: "chat_a", chatTitle: "Furosemide and potassium", prompt: "First-line treatment for hyperkalaemia with ECG changes?", status: "asked", createdAt: "2026-10-29T08:01:00.000Z" },
	];

	it("shows the waiting questions and where each came from", () => {
		const document = documentFor(<QueueView queue={queue} now={new Date("2026-10-29T09:00:00.000Z")} />);
		const rows = [...document.querySelectorAll('[data-testid="queue-row"]')];
		assert.equal(rows.length, 2);
		assert.ok(rows[0]!.textContent!.includes("guideline basis for escalating IV furosemide"));
		assert.match(rows[0]!.querySelector('[data-testid="queue-status"]')!.textContent!, /Waiting to be asked/);
		assert.match(rows[1]!.querySelector('[data-testid="queue-status"]')!.textContent!, /Asked/);
		assert.equal(rows[0]!.querySelector("a")!.getAttribute("href"), "/chat/chat_a");
	});

	it("has no way to ask, answer or dismiss: no buttons, fields or forms; the only links open sessions", () => {
		for (const q of [queue, [], null]) {
			const document = documentFor(<QueueView queue={q} />);
			for (const selector of ["button", "input", "textarea", "select", "form", '[role="button"]', '[contenteditable]']) {
				assert.equal(document.querySelectorAll(selector).length, 0, `${selector} on the queue`);
			}
			for (const a of document.querySelectorAll("a")) assert.match(a.getAttribute("href") ?? "", /^\/chat\/[A-Za-z0-9_-]+$/);
		}
		assert.match(documentFor(<QueueView queue={queue} />).querySelector('[data-testid="queue-note"]')!.textContent!, /Asking happens on the Mac/);
	});

	it("says so when nothing is waiting", () => {
		assert.ok(documentFor(<QueueView queue={[]} />).querySelector('[data-testid="queue-empty"]'));
	});
});

describe("sessions on a phone", () => {
	const draft = (props: Partial<React.ComponentProps<typeof DraftShell>> = {}) =>
		documentFor(<DraftShell busy={false} text="" onChange={() => {}} onSend={() => {}} {...props} />);

	it("the new-session screen has a way back, and drops the stats bar and node picker below sm", () => {
		const document = draft({ mode: "practice", onOpenPicker: () => {}, onClearPicks: () => {} });
		const back = document.querySelector('[data-testid="phone-back"]')!;
		assert.equal(back.getAttribute("href"), "/");
		assert.ok(back.className.includes("sm:hidden"), "only shown below sm");
		assert.ok(document.querySelector('[data-testid="practice-props-chip"]')!.closest(".max-sm\\:hidden"), "the picker is the graph's chain table");
	});

	it("setup is a Mac job: the phone gets a note instead of the setup button", () => {
		const note = documentFor(<PhoneSetupNote />).querySelector('[data-testid="phone-setup-note"]')!;
		assert.ok(note.className.includes("sm:hidden"), "only shown below sm");
		assert.match(note.textContent!, /on the Mac/);
		const source = fs.readFileSync(path.join(import.meta.dirname, "../components/new-session.tsx"), "utf8");
		assert.match(source, /<span className="contents max-sm:hidden">\s*\{zeroKeys \? \(/, "the setup button is hidden below sm");
	});

	it("Explain my miss still starts from the phone's new-session screen", () => {
		const document = draft({ mode: "miss", onLeaveMiss: () => {} });
		assert.match(document.body.textContent!, /Explain my miss/);
		assert.ok(document.querySelector('[data-testid="explain-miss-leave"]'));
	});
});
