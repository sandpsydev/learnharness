import React, { act } from "react";
(globalThis as { React?: typeof React }).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { PracticeDock } from "../components/practice-dock.tsx";
import { ConcludeCard, ProblemCard } from "../components/practice-cards.tsx";
import { problemInputObject, problemTool } from "../src/agent/tools/practice.ts";
import { inputAppends, parseChatInput } from "../src/core/input-events.ts";
import { activeProblemOf, type LhMessage } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";
import { sessionMarkdown } from "../src/core/session-markdown.ts";
import type { ArtifactPartProps } from "../src/core";

const MCQ = {
	statement: "Which mechanism best explains this vignette?",
	mode: "discrimination",
	options: { A: "Mechanism one", B: "Mechanism two", C: "Mechanism three", D: "Mechanism four", E: "Mechanism five" },
	correctOption: "B",
	optionRationale: { A: "Hidden rationale A", B: "Hidden rationale B", C: "Hidden rationale C", D: "Hidden rationale D", E: "Hidden rationale E" },
	modelSolution: "Hidden worked solution",
} as const;
const CONCLUDE = { outcome: "solved", verdict: "The separating feature was identified.", rung: null, missClass: null, retest: false };

function call(id: string, name: string, args: unknown): LhMessage {
	return { id: `m_${id}`, role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name, arguments: args }] } as LhMessage;
}
function ack(id: string, name: string, isError = false): LhMessage {
	return { id: `r_${id}`, role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "ok" }], details: null, isError } as LhMessage;
}
function posed(input: unknown = MCQ): LhMessage[] {
	return [call("p1", "problem", input), ack("p1", "problem")];
}
function toolPart(messages: LhMessage[], type: string): ArtifactPartProps["part"] {
	return projectView(messages).flatMap((m) => m.parts).find((p) => p.type === type)! as ArtifactPartProps["part"];
}

describe("practice MCQ schema and gate", () => {
	const validate = (input: unknown) => validateToolArguments({ name: "problem", parameters: problemInputObject } as never,
		{ id: "p1", type: "toolCall", name: "problem", arguments: input } as never);
	it("accepts an MCQ and preserves free-response compatibility", async () => {
		assert.deepEqual(validate(MCQ), MCQ);
		const { options: _options, correctOption: _correct, optionRationale: _rationale, ...free } = MCQ;
		assert.deepEqual(validate(free), free);
		const gate = { problemActive: false };
		const result = await problemTool(gate).execute("p1", MCQ);
		assert.equal(result.terminate, true);
		assert.equal(gate.problemActive, true);
	});
	it("requires exactly A–E texts and one valid answer letter", () => {
		const { E: _e, ...four } = MCQ.options;
		for (const invalid of [
			{ ...MCQ, options: four },
			{ ...MCQ, options: { ...MCQ.options, F: "sixth" } },
			{ ...MCQ, options: ["a", "b", "c", "d", "e"] },
			{ ...MCQ, correctOption: "F" },
			{ ...MCQ, optionRationale: { ...MCQ.optionRationale, E: "" } },
		]) assert.throws(() => validate(invalid));
	});
	it("rejects partial commitments and blank texts without occupying the problem slot", async () => {
		const { options: _options, correctOption: _correct, optionRationale: _rationale, ...free } = MCQ;
		for (const invalid of [
			{ ...free, options: MCQ.options },
			{ ...free, correctOption: "B" },
			{ ...free, optionRationale: MCQ.optionRationale },
			{ ...MCQ, options: { ...MCQ.options, A: "  " } },
			{ ...MCQ, optionRationale: { ...MCQ.optionRationale, D: "  " } },
		]) {
			const gate = { problemActive: false };
			const result = await problemTool(gate).execute("bad", invalid as never);
			assert.equal(result.isError, true);
			assert.equal(gate.problemActive, false);
		}
	});
});

describe("practice MCQ records and reveal", () => {
	it("shows options while keeping answers and rationales hidden until conclude", () => {
		const record: LhMessage[] = JSON.parse(JSON.stringify(posed()));
		const dock = renderToStaticMarkup(<PracticeDock problemCallId="p1" input={MCQ} expanded onExpand={() => {}} onSubmit={() => {}} />);
		const card = renderToStaticMarkup(<ProblemCard part={toolPart(record, "tool-problem")} />);
		const markdown = sessionMarkdown(record);
		for (const visible of [dock, card, markdown]) {
			for (const option of Object.values(MCQ.options)) assert.ok(visible.includes(option));
			assert.doesNotMatch(visible, /Hidden|Correct option|Distractor/);
		}
		const next = [...record, call("c1", "conclude", CONCLUDE), ack("c1", "conclude")];
		const conclusion = toolPart(next, "tool-conclude");
		assert.deepEqual(conclusion.problemInput, MCQ, "saved commitment is joined without re-authoring");
		for (const reveal of [renderToStaticMarkup(<ConcludeCard part={conclusion} />), sessionMarkdown(next)]) {
			assert.match(reveal, /Correct option: B/);
			assert.ok(reveal.includes(MCQ.modelSolution));
			for (const rationale of Object.values(MCQ.optionRationale)) assert.ok(reveal.includes(rationale));
		}
	});
	it("joins the matching problem after multiple MCQs and hides dismissed commitments", () => {
		const record = [...posed(), call("c1", "conclude", CONCLUDE), ack("c1", "conclude"),
			call("p2", "problem", { ...MCQ, correctOption: "D" }), ack("p2", "problem"),
			call("c2", "conclude", { ...CONCLUDE, outcome: "surrendered" }), ack("c2", "conclude")];
		assert.match(renderToStaticMarkup(<ConcludeCard part={toolPart(record, "tool-conclude")} />), /Correct option: B/);
		const last = projectView(record).flatMap((m) => m.parts).filter((p) => p.type === "tool-conclude").at(-1)!;
		assert.match(renderToStaticMarkup(<ConcludeCard part={last as ArtifactPartProps["part"]} />), /Correct option: D/);
		const dismissed = [...posed(), call("c3", "conclude", { outcome: "dismissed" }), ack("c3", "conclude")];
		for (const rendered of [renderToStaticMarkup(<ConcludeCard part={toolPart(dismissed, "tool-conclude")} />), sessionMarkdown(dismissed)]) {
			assert.doesNotMatch(rendered, /Hidden|Correct option/);
		}
	});
});

const dom = parseHTML("<html><body></body></html>");
Object.assign(dom.document, { oninput: null });
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });

describe("practice MCQ selection and submission", () => {
	it("selects, changes, submits the final choice plus thinking, and preserves agent grading", async () => {
		const { createRoot } = await import("react-dom/client");
		const host = document.createElement("div"); document.body.append(host);
		const root = createRoot(host);
		const sent: string[] = [];
		const render = (expanded = true, compactionRunning = false) => root.render(<PracticeDock
			problemCallId="p1" input={MCQ} expanded={expanded} compactionRunning={compactionRunning}
			onExpand={() => {}} onSubmit={(text) => sent.push(text)} />);
		const choice = (letter: string) => host.querySelector<HTMLButtonElement>(`[data-option="${letter}"]`)!;
		const submit = () => host.querySelector<HTMLButtonElement>('[data-testid="practice-send"]')!;
		try {
			await act(async () => render());
			assert.equal(submit().disabled, true);
			await act(async () => choice("A").click());
			await act(async () => choice("D").click());
			assert.equal(choice("A").getAttribute("aria-pressed"), "false");
			assert.equal(choice("D").getAttribute("aria-pressed"), "true");
			assert.deepEqual(sent, [], "selection alone sends nothing");
			await act(async () => render(false));
			await act(async () => render());
			assert.equal(choice("D").getAttribute("aria-pressed"), "true", "collapse preserves selection");
			// Bypass React's value tracker to simulate real typing in linkedom.
			const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
			await act(async () => {
				Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "The clinical cue supports this mechanism.");
				textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
			});
			assert.equal(textarea.value, "The clinical cue supports this mechanism.");
			await act(async () => render(true, true));
			assert.equal(submit().disabled, true, "compaction gates answer submission");
			await act(async () => render());
			await act(async () => submit().click());
			assert.equal(sent.length, 1);
			assert.match(sent[0]!, /^Claimed answer: D\. Mechanism four/);
			assert.match(sent[0]!, /Your thinking:\nThe clinical cue supports this mechanism\.$/);
			const event = parseChatInput({ type: "thinking", problemCallId: "p1", text: sent[0] });
			const record = posed();
			const appends = inputAppends({ messages: record, kind: "practice" }, event);
			assert.equal(appends.length, 1);
			assert.ok(JSON.stringify(appends[0]).includes("Claimed answer: D."));
			assert.equal(activeProblemOf([...record, ...appends])?.toolCallId, "p1", "a wrong claim does not auto-grade or conclude");
			assert.equal(submit().disabled, true, "choice and thinking clear for the next attempt");
			await act(async () => choice("B").click());
			await act(async () => submit().click());
			assert.equal(sent[1], "Claimed answer: B. Mechanism two", "thinking is optional");
			const correctAppends = inputAppends({ messages: [...record, ...appends], kind: "practice" },
				parseChatInput({ type: "thinking", problemCallId: "p1", text: sent[1] }));
			assert.equal(activeProblemOf([...record, ...appends, ...correctAppends])?.toolCallId, "p1", "even a correct choice waits for the agent to conclude");
			await act(async () => choice("C").click());
			await act(async () => choice("C").click());
			assert.equal(choice("C").getAttribute("aria-pressed"), "false", "click again clears a selection for hint-only thinking");
			await act(async () => {
				Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "I am stuck on the separating feature.");
				textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
			});
			await act(async () => submit().click());
			assert.equal(sent[2], "I am stuck on the separating feature.", "thinking without a choice remains a hint request");
		} finally { await act(async () => root.unmount()); host.remove(); }
	});
});
