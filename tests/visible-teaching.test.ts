/**
 * Visible-teaching guard (medical fork): the teacher may not CHECK a step the
 * learner has not been taught. Refused: (a) a check right after the learner
 * answered a predict, and (b) a check on a different node than the previous
 * question, when nothing VISIBLE (a non-empty text block or send_to_user
 * message — never thinking) was taught since that answer.
 *
 * Fakes only — a scripted pi engine and a scripted fake Claude Code CLI; no
 * model, no web, no owner data.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it, type TestContext } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-visible-teaching-"));
process.env.LH_DATA_DIR = TMP_DATA;
after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const { GUARDED_QUESTION_TOOLS, REFUSED_QUESTION_TYPE, UNSEEN_STEP_NOTE, unseenStepNote } = await import("../src/agent/visible-teaching.ts");
const { createTeacherAgent, createProberAgent } = await import("../src/agent/teacher-agent.ts");
const { createClaudeCodeStreamFunction } = await import("../src/agent/claude-code/stream.ts");
const { CLAUDE_CODE_MODELS } = await import("../src/agent/claude-code/provider.ts");
const { createFauxCore, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } = await import("@earendil-works/pi-ai");

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import type { RunClaude } from "../src/agent/claude-code/stream.ts";
import type { PiEngine } from "../src/agent/models.ts";

// ─── transcript builders ─────────────────────────────────────────────────────

type Type = "predict" | "check";
const quizInput = (type: Type, nodeId: string) => ({
	question: `Which option fits ${nodeId}?`,
	options: [{ label: "A" }, { label: "B" }, { label: "C" }],
	correctAnswer: "A",
	explanation: "Because A.",
	type,
	nodeId,
});

const user = (text: string): AgentMessage => ({ id: `u_${text}`, role: "user", content: text, timestamp: 1 }) as never;
const assistant = (...content: unknown[]): AgentMessage => ({ role: "assistant", content, timestamp: 2 }) as never;
const thinking = (text = "the whole step, taught to myself") => ({ type: "thinking", thinking: text });
const text = (t: string) => ({ type: "text", text: t });
const call = (id: string, name: string, args: unknown) => ({ type: "toolCall", id, name, arguments: args });
const quiz = (id: string, type: Type, nodeId: string) => call(id, "quiz", quizInput(type, nodeId));
const sendToUser = (id: string, message: string) => call(id, "send_to_user", { message });
const answer = (id: string, toolName = "quiz"): AgentMessage =>
	({
		role: "toolResult",
		toolCallId: id,
		toolName,
		content: [{ type: "text", text: "answered" }],
		details: { kind: "quiz", questionText: "Which?", dontKnow: true, answers: [], answeredAt: "2026-11-23T00:00:00.000Z" },
		isError: false,
		timestamp: 3,
	}) as never;
const sent = (id: string, isError = false): AgentMessage =>
	({ role: "toolResult", toolCallId: id, toolName: "send_to_user", content: [{ type: "text", text: "ok" }], details: "ok", isError, timestamp: 3 }) as never;

/** The pure decision for a check/predict call carried by `next`, after `history`. */
function decide(history: AgentMessage[], ...next: unknown[]): string | null {
	const message = { content: next } as { content: Array<{ type: string; id?: string }> };
	const id = (next.findLast((b) => (b as { type: string }).type === "toolCall") as { id: string }).id;
	return unseenStepNote(history, message as never, id);
}

// ─── the rule, as a pure decision ────────────────────────────────────────────

describe("the rule's limits", () => {
	it("watches the quiz and its free-recall twin, and refuses only checks", () => {
		assert.deepEqual([...GUARDED_QUESTION_TOOLS], ["quiz", "explain"]);
		assert.equal(REFUSED_QUESTION_TYPE, "check");
	});

	it("the refusal tells the teacher the learner has not seen the step, to teach visibly, then check", () => {
		assert.match(UNSEEN_STEP_NOTE, /learner has not seen this step/);
		assert.match(UNSEEN_STEP_NOTE, /never your thinking/);
		assert.match(UNSEEN_STEP_NOTE, /Nothing was shown to the learner/);
		assert.match(UNSEEN_STEP_NOTE, /Teach this step now in a visible message/);
	});
});

describe("refused", () => {
	it("(a) a check right after the learner answered a predict, with only thinking since", () => {
		const history = [user("teach me"), assistant(quiz("p1", "predict", "thyroid")), answer("p1")];
		assert.equal(decide(history, thinking(), call("f1", "figure", {}), quiz("c1", "check", "thyroid")), UNSEEN_STEP_NOTE);
	});

	it("(b) a check on a new node, with only thinking since the previous check's answer", () => {
		const history = [user("teach me"), assistant(quiz("c0", "check", "invasion")), answer("c0")];
		assert.equal(decide(history, thinking(), quiz("c1", "check", "grade")), UNSEEN_STEP_NOTE);
	});

	it("(b) also after a predict on another node", () => {
		const history = [assistant(quiz("p1", "predict", "invasion")), answer("p1")];
		assert.equal(decide(history, thinking(), quiz("c1", "check", "grade")), UNSEEN_STEP_NOTE);
	});

	it("empty or whitespace-only text is not teaching", () => {
		const history = [assistant(quiz("c0", "check", "a")), answer("c0"), assistant(text("   "), text(""), thinking())];
		assert.equal(decide(history, quiz("c1", "check", "b")), UNSEEN_STEP_NOTE);
	});

	it("an empty send_to_user message, or one whose call failed, is not teaching", () => {
		const failed = [assistant(quiz("c0", "check", "a")), answer("c0"), assistant(sendToUser("s1", "A real explanation")), sent("s1", true)];
		assert.equal(decide(failed, quiz("c1", "check", "b")), UNSEEN_STEP_NOTE);
		const empty = [assistant(quiz("c0", "check", "a")), answer("c0")];
		assert.equal(decide(empty, call("s2", "send_to_user", { message: "  " }), quiz("c1", "check", "b")), UNSEEN_STEP_NOTE);
	});

	it("teaching from BEFORE the previous answer does not count", () => {
		const history = [assistant(text("The step, taught."), quiz("c0", "check", "a")), answer("c0")];
		assert.equal(decide(history, quiz("c1", "check", "b")), UNSEEN_STEP_NOTE);
	});

	it("text that only comes AFTER the check call does not make it taught", () => {
		const history = [assistant(quiz("c0", "check", "a")), answer("c0")];
		assert.equal(decide(history, quiz("c1", "check", "b"), text("teaching written after the question")), UNSEEN_STEP_NOTE);
	});

	it("the free-recall twin (explain) is guarded the same way", () => {
		const history = [assistant(call("p1", "explain", { ...quizInput("predict", "a") })), answer("p1", "explain")];
		assert.equal(decide(history, call("e1", "explain", quizInput("check", "a"))), UNSEEN_STEP_NOTE);
	});

	it("a refused earlier attempt (error result) is not an answer and not teaching: the retry is judged on the real last answer", () => {
		const refused = { ...answer("c1"), isError: true, details: {} } as AgentMessage;
		const history = [assistant(quiz("c0", "check", "a")), answer("c0"), assistant(thinking(), quiz("c1", "check", "b")), refused];
		assert.equal(decide(history, thinking(), quiz("c2", "check", "b")), UNSEEN_STEP_NOTE);
	});
});

describe("allowed", () => {
	it("the follow-up questions of a check set on the same node, with no text between", () => {
		const history = [
			assistant(text("The step."), quiz("c1", "check", "stage")),
			answer("c1"),
			assistant(quiz("c2", "check", "stage")),
			answer("c2"),
		];
		assert.equal(decide(history, quiz("c3", "check", "stage")), null);
	});

	it("a predict question that opens a step, with no text since the last answer", () => {
		const history = [assistant(quiz("c0", "check", "a")), answer("c0")];
		assert.equal(decide(history, thinking(), quiz("p1", "predict", "b")), null);
	});

	it("a predict after a predict", () => {
		const history = [assistant(quiz("p0", "predict", "a")), answer("p0")];
		assert.equal(decide(history, quiz("p1", "predict", "b")), null);
	});

	it("the first question of the chat, and a check when nothing was answered yet", () => {
		assert.equal(decide([user("teach me")], thinking(), quiz("c1", "check", "a")), null);
	});

	it("a check once ordinary text was taught since the predict's answer", () => {
		const history = [assistant(quiz("p1", "predict", "a")), answer("p1"), assistant(text("Here is the step."))];
		assert.equal(decide(history, quiz("c1", "check", "a")), null);
	});

	it("a check on a new node once text was taught since the previous answer", () => {
		const history = [assistant(quiz("c0", "check", "a")), answer("c0"), assistant(text("Next step."))];
		assert.equal(decide(history, quiz("c1", "check", "b")), null);
	});

	it("a check whose step is in the same message, before the call (text block)", () => {
		const history = [assistant(quiz("c0", "check", "a")), answer("c0")];
		assert.equal(decide(history, thinking(), text("The next step."), quiz("c1", "check", "b")), null);
	});

	it("a check whose step was sent through send_to_user, in an earlier message or earlier in the same one", () => {
		const earlier = [assistant(quiz("c0", "check", "a")), answer("c0"), assistant(sendToUser("s1", "The next step."))];
		assert.equal(decide(earlier, quiz("c1", "check", "b")), null);
		const sameMessage = [assistant(quiz("c0", "check", "a")), answer("c0")];
		assert.equal(decide(sameMessage, thinking(), sendToUser("s1", "The next step."), quiz("c1", "check", "b")), null);
	});

	it("a check right after a predict answer when the reveal was sent first", () => {
		const history = [assistant(quiz("p1", "predict", "a")), answer("p1")];
		assert.equal(decide(history, sendToUser("s1", "Here is why."), quiz("c1", "check", "a")), null);
	});

	it("a call with no type or no nodeId (nothing to judge) and tools that are not questions", () => {
		const history = [assistant(quiz("c0", "check", "a")), answer("c0")];
		assert.equal(decide(history, call("c1", "quiz", { ...quizInput("check", "b"), type: undefined })), null);
		assert.equal(decide(history, call("c1", "quiz", { ...quizInput("check", "b"), nodeId: undefined })), null);
		assert.equal(decide(history, call("c1", "ask_user_question", { question: "?" })), null);
		assert.equal(decide(history, call("c1", "probe", { ...quizInput("check", "b") })), null);
	});
});

// ─── the real turn: a scripted teacher, what the learner is shown ────────────

type Faux = ReturnType<typeof createFauxCore>;

/** Run the teacher agent over `history` with scripted model responses. */
async function runScripted(history: AgentMessage[], steps: FauxResponseStep[]) {
	const faux: Faux = createFauxCore({});
	faux.setResponses(steps);
	const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
	const agent = createTeacherAgent(undefined, { engine, messages: history });
	await agent.continue();
	return { messages: agent.state.messages as AgentMessage[], remaining: faux.getPendingResponseCount() };
}

type Result = { role: "toolResult"; toolCallId: string; toolName: string; isError?: boolean; content: Array<{ text?: string }> };
const resultFor = (messages: AgentMessage[], id: string) => messages.find((m) => m.role === "toolResult" && m.toolCallId === id) as Result | undefined;
/** "Shown to the learner" = a clean question pose: the call has a non-error result (the dock mounts on it). */
const shownToLearner = (messages: AgentMessage[], id: string) => {
	const r = resultFor(messages, id);
	return r !== undefined && !r.isError;
};

const toolUse = { stopReason: "toolUse" } as const;

describe("a scripted teacher turn (pi engine)", () => {
	it("(a) answers a predict, then calls a check with no visible text: the check is refused, the teacher is told, and it can teach then check", async () => {
		const history = [user("teach me thyroid"), assistant(quiz("p1", "predict", "thyroid")), answer("p1")];
		const { messages, remaining } = await runScripted(history, [
			fauxAssistantMessage([fauxThinking("the step, in my head"), fauxToolCall("quiz", quizInput("check", "thyroid"), { id: "c1" })], toolUse),
			fauxAssistantMessage([fauxText("Here is the step, out loud."), fauxToolCall("quiz", quizInput("check", "thyroid"), { id: "c2" })], toolUse),
		]);
		assert.equal(shownToLearner(messages, "c1"), false, "the unseen-step check is not shown");
		assert.equal(resultFor(messages, "c1")?.isError, true);
		assert.equal(resultFor(messages, "c1")?.content[0]?.text, UNSEEN_STEP_NOTE);
		assert.equal(shownToLearner(messages, "c2"), true, "after teaching visibly, the check is shown");
		assert.equal(remaining, 0, "the teacher went on to its second attempt in the same turn");
	});

	it("(b) calls a check on a NEW node with no visible text since the previous quiz's answer: refused", async () => {
		const history = [user("teach me"), assistant(text("Invasion."), quiz("c0", "check", "invasion")), answer("c0")];
		const { messages, remaining } = await runScripted(history, [
			fauxAssistantMessage([fauxThinking("grade comes next"), fauxToolCall("quiz", quizInput("check", "grade"), { id: "c1" })], toolUse),
			fauxAssistantMessage([fauxText("Grade measures how abnormal the cells look."), fauxToolCall("quiz", quizInput("check", "grade"), { id: "c2" })], toolUse),
		]);
		assert.equal(shownToLearner(messages, "c1"), false);
		assert.equal(resultFor(messages, "c1")?.content[0]?.text, UNSEEN_STEP_NOTE);
		assert.equal(remaining, 0);
		assert.equal(shownToLearner(messages, "c2"), true);
	});

	it("the legitimate no-text quizzes still reach the learner: a check set's follow-up, and a predict that opens a step", async () => {
		const setHistory = [user("teach me"), assistant(text("The step."), quiz("c1", "check", "stage")), answer("c1")];
		const followUp = await runScripted(setHistory, [fauxAssistantMessage([fauxToolCall("quiz", quizInput("check", "stage"), { id: "c2" })], toolUse)]);
		assert.equal(shownToLearner(followUp.messages, "c2"), true);

		const predictHistory = [user("teach me"), assistant(text("The step."), quiz("c1", "check", "stage")), answer("c1")];
		const predict = await runScripted(predictHistory, [fauxAssistantMessage([fauxThinking("next"), fauxToolCall("quiz", quizInput("predict", "next-node"), { id: "p2" })], toolUse)]);
		assert.equal(shownToLearner(predict.messages, "p2"), true);
	});

	it("a check preceded by a text block in the same message is shown", async () => {
		const history = [user("teach me"), assistant(quiz("c0", "check", "a")), answer("c0")];
		const { messages } = await runScripted(history, [
			fauxAssistantMessage([fauxText("The next step, taught."), fauxToolCall("quiz", quizInput("check", "b"), { id: "c1" })], toolUse),
		]);
		assert.equal(shownToLearner(messages, "c1"), true);
	});

	it("the prober (probe quiz, no nodeId) is never guarded", () => {
		const agent = createProberAgent(
			{ chatId: "c", chatStore: { getChat: () => null } as never, jobStore: {} as never, spawn: () => {} } as never,
			{ engine: { model: createFauxCore({}).getModel(), streamFn: createFauxCore({}).streamSimple } },
		);
		assert.ok(agent.state.tools.some((t) => t.name === "probe"));
	});
});

// ─── the same turn through the Claude Code engine (fake CLI) ─────────────────

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/claude-code/fake-claude.mjs", import.meta.url));
const streamEvent = (event: object) => JSON.stringify({ type: "stream_event", event });

function toolUseEvents(index: number, id: string, name: string, input: object): string[] {
	return [
		streamEvent({ type: "content_block_start", index, content_block: { type: "tool_use", id, name: `mcp__learnharness__${name}`, input: {} } }),
		streamEvent({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }),
		streamEvent({ type: "content_block_stop", index }),
	];
}

/** One CLI response: optional visible text block, then tool calls (in order). */
function cliScenario(calls: Array<{ id: string; name: string; input: object }>, visibleText?: string): string[] {
	const lines = [streamEvent({ type: "message_start", message: { usage: {} } })];
	let index = 0;
	if (visibleText) {
		lines.push(
			streamEvent({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
			streamEvent({ type: "content_block_delta", index, delta: { type: "text_delta", text: visibleText } }),
			streamEvent({ type: "content_block_stop", index }),
		);
		index++;
	}
	for (const c of calls) lines.push(...toolUseEvents(index++, c.id, c.name, c.input));
	lines.push(streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }), streamEvent({ type: "message_stop" }));
	for (const c of calls) lines.push(JSON.stringify({ fake: "call", id: c.id, name: c.name, arguments: c.input }));
	lines.push(JSON.stringify({ fake: "reply" }));
	return lines;
}

function fakeRun(t: TestContext, scenarios: string[][]): { runClaude: RunClaude; spawned: number } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-visible-teaching-cli-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const run = { spawned: 0, runClaude: undefined as unknown as RunClaude };
	run.runClaude = (args, options) => {
		const scenario = scenarios[run.spawned];
		assert.ok(scenario, `unexpected spawn #${run.spawned + 1}`);
		const file = path.join(dir, `scenario-${run.spawned}.jsonl`);
		fs.writeFileSync(file, `${scenario.join("\n")}\n`);
		run.spawned++;
		const child = spawn(process.execPath, [FAKE_CLAUDE, ...args], {
			cwd: options.cwd,
			env: { ...options.env, FAKE_CLAUDE_SCENARIO: file, FAKE_CLAUDE_STDIN: path.join(dir, `stdin-${run.spawned}.jsonl`) },
			stdio: ["pipe", "pipe", "pipe", "ipc"],
		}) as ChildProcessWithoutNullStreams;
		t.after(() => child.kill("SIGKILL"));
		return child;
	};
	return run;
}

async function runClaudeCode(t: TestContext, history: AgentMessage[], scenarios: string[][]) {
	const run = fakeRun(t, scenarios);
	const model = CLAUDE_CODE_MODELS.find((m) => m.id === "sonnet");
	assert.ok(model);
	const engine: PiEngine = { model, streamFn: createClaudeCodeStreamFunction(run.runClaude) };
	const agent = createTeacherAgent(undefined, { engine, messages: history });
	await agent.continue();
	return agent.state.messages as AgentMessage[];
}

describe("the same turn through the Claude Code engine (fake CLI)", () => {
	it("(a) a check straight after a predict answer, no visible text: refused, not shown", async (t) => {
		const history = [user("teach me"), assistant(quiz("p1", "predict", "thyroid")), answer("p1")];
		const messages = await runClaudeCode(t, history, [
			cliScenario([{ id: "toolu_c1", name: "quiz", input: quizInput("check", "thyroid") }]),
			cliScenario([{ id: "toolu_c2", name: "quiz", input: quizInput("check", "thyroid") }], "Here is the step, out loud."),
		]);
		assert.equal(shownToLearner(messages, "toolu_c1"), false);
		assert.equal(resultFor(messages, "toolu_c1")?.content[0]?.text, UNSEEN_STEP_NOTE);
		assert.equal(shownToLearner(messages, "toolu_c2"), true, "after teaching visibly, the check is shown");
	});

	it("(b) a check on a new node, no visible text: refused, not shown", async (t) => {
		const history = [user("teach me"), assistant(text("Invasion."), quiz("c0", "check", "invasion")), answer("c0")];
		const messages = await runClaudeCode(t, history, [
			cliScenario([{ id: "toolu_c1", name: "quiz", input: quizInput("check", "grade") }]),
			cliScenario([{ id: "toolu_c2", name: "quiz", input: quizInput("check", "grade") }], "Grade measures how abnormal the cells look."),
		]);
		assert.equal(shownToLearner(messages, "toolu_c1"), false);
		assert.equal(shownToLearner(messages, "toolu_c2"), true);
	});

	it("a check whose step is in a visible text block of the same response is shown", async (t) => {
		const history = [user("teach me"), assistant(text("Invasion."), quiz("c0", "check", "invasion")), answer("c0")];
		const messages = await runClaudeCode(t, history, [cliScenario([{ id: "toolu_c1", name: "quiz", input: quizInput("check", "grade") }], "Grade measures how abnormal the cells look.")]);
		assert.equal(shownToLearner(messages, "toolu_c1"), true);
	});

	it("a check whose step went through send_to_user just before it is shown (the CLI makes one message per call)", async (t) => {
		const history = [user("teach me"), assistant(text("Invasion."), quiz("c0", "check", "invasion")), answer("c0")];
		const messages = await runClaudeCode(t, history, [
			cliScenario([{ id: "toolu_s1", name: "send_to_user", input: { message: "Grade measures how abnormal the cells look." } }]),
			cliScenario([{ id: "toolu_c1", name: "quiz", input: quizInput("check", "grade") }]),
		]);
		assert.equal(shownToLearner(messages, "toolu_c1"), true);
	});

	it("a follow-up check on the same node with no text is shown", async (t) => {
		const history = [user("teach me"), assistant(text("Staging."), quiz("c0", "check", "stage")), answer("c0")];
		const messages = await runClaudeCode(t, history, [cliScenario([{ id: "toolu_c1", name: "quiz", input: quizInput("check", "stage") }])]);
		assert.equal(shownToLearner(messages, "toolu_c1"), true);
	});
});
