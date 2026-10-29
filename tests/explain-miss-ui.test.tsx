/**
 * Explain my miss (Phase 7) — the screens: the "Explain my miss" entry on the
 * new-session screen, the miss draft, how the session is started (the pasted
 * question must never become the title), and the twin question rendering as
 * clickable lettered A–E rows in a teaching session.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { DraftShell, startDraftSession } from "../components/new-session.tsx";
import { ExplainMissAction, ExplainMissActive } from "../components/composer-actions.tsx";
import { QuestionDock } from "../components/question-dock.tsx";
import { readOpeningPrompt } from "../components/opening-prompt.ts";
import { isLetteredChoice, normalizeOptions, type QuizToolInput } from "../src/core/question-core.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
beforeEach(() => {
	const data = new Map<string, string>();
	Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => { data.set(key, value); },
		removeItem: (key: string) => { data.delete(key); },
	} });
});
afterEach(() => {
	if (originalStorage) Object.defineProperty(globalThis, "sessionStorage", originalStorage);
	else Reflect.deleteProperty(globalThis, "sessionStorage");
});

const markup = (node: React.ReactNode) => parseHTML(`<html><body>${renderToStaticMarkup(node)}</body></html>`).document;
const draft = (props: Partial<React.ComponentProps<typeof DraftShell>> = {}) =>
	<DraftShell busy={false} text="" onChange={() => {}} onSend={() => {}} {...props} />;

describe("the new-session screen", () => {
	it("offers an Explain my miss action on the teaching draft only", () => {
		assert.ok(markup(draft({ onExplainMiss: () => {} })).querySelector('[data-testid="explain-miss-action"]'));
		assert.equal(markup(draft({ onExplainMiss: () => {}, mode: "practice" })).querySelector('[data-testid="explain-miss-action"]'), null);
		assert.equal(markup(draft()).querySelector('[data-testid="explain-miss-action"]'), null, "no handler, no action");
	});

	it("clicking the action calls the entry handler; the leave button calls the way back", async () => {
		const host = document.createElement("div"); document.body.append(host);
		const root = createRoot(host);
		let opened = 0;
		let left = 0;
		try {
			await act(async () => root.render(<><ExplainMissAction onOpen={() => { opened++; }} /><ExplainMissActive onLeave={() => { left++; }} /></>));
			await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="explain-miss-action"]')!.click(); });
			await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="explain-miss-leave"]')!.click(); });
			assert.deepEqual([opened, left], [1, 1]);
		} finally { await act(async () => root.unmount()); host.remove(); }
	});

	it("the miss draft says what to bring, shows where you are, and offers a way back", () => {
		const document = markup(draft({ mode: "miss", onLeaveMiss: () => {} }));
		assert.match(document.body.textContent!, /Explain my miss/);
		assert.match(document.body.textContent!, /Paste a question you got wrong, or a screenshot with ⌘V, and say which option you chose/);
		assert.match(document.body.textContent!, /correct answer and the bank’s explanation are optional/);
		assert.ok(document.querySelector('[data-testid="explain-miss-active"]'));
		assert.ok(document.querySelector('[data-testid="explain-miss-leave"]'));
		assert.equal(document.querySelector('[data-testid="explain-miss-action"]'), null);
		const placeholder = document.querySelector("[data-placeholder]")!.getAttribute("data-placeholder");
		assert.match(placeholder!, /Paste the question or a screenshot/);
	});
});

describe("starting a miss session", () => {
	const QUESTION = "A 58-year-old man presents with crushing chest pain and ST elevation. I chose option C.";
	function fakeFetch() {
		const calls: { url: string; body: Record<string, unknown> }[] = [];
		const f = (async (url: string, init?: RequestInit) => {
			calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
			return new Response(JSON.stringify({ id: "c_miss" }), { status: 200 });
		}) as typeof fetch;
		return { f, calls };
	}

	it("creates the session with the miss flow and a fixed title: the pasted question is NOT sent as a title", async () => {
		const { f, calls } = fakeFetch();
		const target = await startDraftSession(QUESTION, f, "miss");
		assert.equal(target, "/chat/c_miss");
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.url, "/api/chats");
		assert.deepEqual(calls[0]!.body, { title: "Explain my miss", flow: "miss" });
		assert.equal(JSON.stringify(calls[0]!.body).includes("58-year-old"), false);
	});

	it("the pasted question travels only as the first message, handed to the chat page", async () => {
		const { f } = fakeFetch();
		await startDraftSession(QUESTION, f, "miss");
		assert.equal(readOpeningPrompt("c_miss"), QUESTION);
	});

	it("an ordinary draft is unchanged: the first message is still the title", async () => {
		const { f, calls } = fakeFetch();
		await startDraftSession("teach me orbital mechanics", f);
		assert.deepEqual(calls[0]!.body, { title: "teach me orbital mechanics" });
	});
});

describe("the twin question — lettered A–E in a teaching session", () => {
	const options = ["A", "B", "C", "D", "E"].map((value, i) => ({ label: `Option text ${i + 1}`, value }));
	const quiz = (over: Partial<QuizToolInput> = {}): QuizToolInput => ({
		question: "Which of the following is the most likely diagnosis?",
		options, correctAnswer: "C", explanation: "C because…", type: "check", nodeId: "twin",
		...over,
	} as QuizToolInput);

	it("recognizes only five single-select options valued A–E in order", () => {
		assert.equal(isLetteredChoice(normalizeOptions(options), false), true);
		assert.equal(isLetteredChoice(normalizeOptions(options), true), false, "multi-select is never lettered");
		assert.equal(isLetteredChoice(normalizeOptions(options.slice(0, 4)), false), false);
		assert.equal(isLetteredChoice(normalizeOptions([...options].reverse()), false), false);
		assert.equal(isLetteredChoice(normalizeOptions(options.map((o) => ({ label: o.label }))), false), false);
	});

	async function render(input: QuizToolInput, callId: string) {
		const host = document.createElement("div"); document.body.append(host);
		const root = createRoot(host);
		await act(async () => root.render(<QuestionDock toolName="quiz" toolCallId={callId} input={input}
			expanded onExpand={() => {}} onSubmit={() => {}} dictationClaim={false} />));
		return { host, done: async () => { await act(async () => root.unmount()); host.remove(); } };
	}

	it("shows five clickable rows in A–E order with letter badges, never shuffled", async () => {
		// Several call ids: an ordinary quiz would shuffle differently per id; a lettered one never does.
		for (const callId of ["call-1", "call-2", "call-3"]) {
			const { host, done } = await render(quiz(), callId);
			try {
				const rows = [...host.querySelectorAll<HTMLElement>('[role="radio"]')];
				assert.equal(rows.length, 5);
				assert.deepEqual(rows.map((r) => r.querySelector("[data-letter]")?.getAttribute("data-letter")), ["A", "B", "C", "D", "E"]);
				assert.deepEqual(rows.map((r) => r.textContent!.replace(/^[A-E]/, "").trim()), options.map((o) => o.label));
			} finally { await done(); }
		}
	});

	it("clicking a row selects it, and picking another changes the choice", async () => {
		const { host, done } = await render(quiz(), "call-pick");
		try {
			const rows = () => [...host.querySelectorAll<HTMLElement>('[role="radio"]')];
			await act(async () => { rows()[2]!.click(); });
			assert.deepEqual(rows().map((r) => r.getAttribute("aria-checked")), ["false", "false", "true", "false", "false"]);
			await act(async () => { rows()[4]!.click(); });
			assert.deepEqual(rows().map((r) => r.getAttribute("aria-checked")), ["false", "false", "false", "false", "true"]);
		} finally { await done(); }
	});

	it("an ordinary five-option quiz keeps its dot rows and its shuffle", async () => {
		const plain = quiz({ options: options.map((o) => ({ label: o.label, value: o.label })), correctAnswer: "Option text 3" });
		const { host, done } = await render(plain, "call-plain");
		try {
			assert.equal(host.querySelector("[data-letter]"), null);
			assert.equal(host.querySelectorAll('[role="radio"]').length, 5);
		} finally { await done(); }
	});
});
