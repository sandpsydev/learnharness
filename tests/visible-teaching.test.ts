/** Reproductions use generic lessons, scripted pi responses and a fake CLI.
 * No learner data, web access or live model calls.
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

const { GUARDED_QUESTION_TOOLS, MAX_LESSON_REPAIR_REQUESTS, LESSON_REPAIR_FAILED_TEXT, UNSEEN_STEP_NOTE, unseenStepNote } = await import("../src/agent/visible-teaching.ts");
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
const answer = (id: string, toolName = "quiz", correct = true, dontKnow = false): AgentMessage =>
	({
		role: "toolResult",
		toolCallId: id,
		toolName,
		content: [{ type: "text", text: "answered" }],
		details: { kind: "quiz", questionText: "Which?", dontKnow, correct, answers: [], answeredAt: "2026-11-23T00:00:00.000Z" },
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

describe("visible lesson before every question", () => {
	it("covers every question dock tool and the practice problem card", () => {
		assert.deepEqual([...GUARDED_QUESTION_TOOLS], ["quiz", "probe", "ask_user_question", "explain", "recall", "problem"]);
		for (const name of GUARDED_QUESTION_TOOLS) {
			assert.equal(decide([user("teach me")], thinking(), call("q", name, {})), UNSEEN_STEP_NOTE, name);
			assert.equal(decide([user("teach me")], text("A square's area is its side squared."), call("q", name, {})), null, name);
		}
	});

	it("refuses every quiz type, including absent type and node, without a lesson", () => {
		for (const type of ["check", "predict", "probe", undefined]) {
			assert.equal(decide([user("start")], call("q", "quiz", { type })), UNSEEN_STEP_NOTE);
		}
	});

	it("refuses the new-node and predict-to-check reproductions", () => {
		for (const previous of [quiz("p", "predict", "area"), quiz("p", "check", "length")]) {
			const history = [assistant(text("A square has four equal sides."), previous), answer("p")];
			assert.equal(decide(history, thinking(), quiz("q", "check", "area")), UNSEEN_STEP_NOTE);
		}
	});

	it("refuses same-node retries after a wrong, unknown or ungraded answer", () => {
		for (const result of [answer("p", "quiz", false), answer("p", "quiz", false, true), { ...answer("p"), details: {} } as AgentMessage]) {
			assert.equal(decide([assistant(text("Area is side squared."), quiz("p", "check", "area")), result], quiz("q", "check", "area")), UNSEEN_STEP_NOTE);
		}
	});

	it("allows consecutive same-node check-set follow-ups after correct answers to a taught step", () => {
		const history = [assistant(text("Area is side squared."), quiz("p", "check", "area")), answer("p"), assistant(quiz("q", "check", "area")), answer("q")];
		assert.equal(decide(history, quiz("r", "check", "area")), null);
		assert.equal(decide([...history, user("new request")], quiz("r", "check", "area")), UNSEEN_STEP_NOTE);
		assert.equal(decide([assistant(quiz("p", "check", "area")), answer("p")], quiz("q", "check", "area")), UNSEEN_STEP_NOTE);
	});

	it("a roadmap alone does not unlock the first warm-up, nor do correct probe answers unlock later warm-ups", () => {
		const roadmap = "Your map already holds the earlier concepts. So I'm starting at application level. A few questions will show where the gaps are. Then I'll build a lesson from your slides.";
		const history = [user("prepare for class"), assistant(sendToUser("s", roadmap)), sent("s")];
		assert.equal(decide(history, call("p", "probe", quizInput("check", "area"))), UNSEEN_STEP_NOTE);
		assert.equal(decide([...history, assistant(call("p", "probe", quizInput("check", "area"))), answer("p", "probe")], call("q", "probe", quizInput("check", "area"))), UNSEEN_STEP_NOTE);
	});

	it("a broad node does not unlock a new numbered category that was only in thinking", () => {
		const history = [assistant(text("The code describes the parcel's weight."), quiz("p", "check", "parcel")), answer("p")];
		const numbered = { ...quizInput("check", "parcel"), options: [{ label: "P1: light", value: "a" }, { label: "P2: heavy", value: "b" }], correctAnswer: "b" };
		assert.equal(decide(history, thinking("P2 means heavy."), call("q", "quiz", numbered)), UNSEEN_STEP_NOTE);
		assert.equal(decide(history, text("P2 means heavy."), call("q", "quiz", numbered)), null);
	});

	it("ordinary text or send_to_user before the call unlocks a question, including a same-node repair", () => {
		const history = [assistant(quiz("p", "check", "area")), answer("p", "quiz", false, true)];
		assert.equal(decide(history, text("Area is side squared."), quiz("q", "check", "area")), null);
		assert.equal(decide(history, sendToUser("s", "Area is side squared."), quiz("q", "check", "area")), null);
		assert.equal(decide([...history, assistant(sendToUser("s", "Area is side squared.")), sent("s")], quiz("q", "check", "area")), null);
	});

	it("thinking, empty output, failed delivery, old teaching and text after the call do not unlock it", () => {
		const history = [assistant(text("Area is side squared."), quiz("p", "predict", "area")), answer("p")];
		assert.equal(decide(history, thinking(), text("  "), quiz("q", "check", "area"), text("Area is side squared.")), UNSEEN_STEP_NOTE);
		assert.equal(decide([...history, assistant(sendToUser("s", "Area is side squared.")), sent("s", true)], quiz("q", "check", "area")), UNSEEN_STEP_NOTE);
		assert.equal(decide(history, call("r", "read", {})), null);
	});
});

// ─── the real turn: a scripted teacher, what the learner is shown ────────────

const proberContext = { chatId: "guard-test", chatStore: { getChat: () => null }, jobStore: {}, spawn: () => {} } as never;

type Faux = ReturnType<typeof createFauxCore>;

/** Run the teacher agent over `history` with scripted model responses. */
async function runScripted(history: AgentMessage[], steps: FauxResponseStep[], prober = false) {
	const faux: Faux = createFauxCore({});
	faux.setResponses(steps);
	const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
	const agent = prober ? createProberAgent(proberContext, { engine, messages: history }) : createTeacherAgent(undefined, { engine, messages: history });
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
	it("a correct taught check-set continuation is still shown", async () => {
		const history = [user("teach me"), assistant(text("Area is side squared."), quiz("c0", "check", "area")), answer("c0")];
		const { messages } = await runScripted(history, [fauxAssistantMessage([fauxToolCall("quiz", quizInput("check", "area"), { id: "c1" })], toolUse)]);
		assert.equal(shownToLearner(messages, "c1"), true);
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


	it("a wrong answer needs a visible repair even on the same node", async () => {
		const history = [user("start"), assistant(text("Area is side squared."), quiz("p", "check", "area")), answer("p", "quiz", false)];
		const { messages } = await runScripted(history, [
			fauxAssistantMessage([fauxThinking("repair silently"), fauxToolCall("quiz", quizInput("check", "area"), { id: "q" })], toolUse),
			fauxAssistantMessage([fauxText("Multiply the side by itself to find the area."), fauxToolCall("quiz", quizInput("check", "area"), { id: "r" })], toolUse),
		]);
		assert.equal(shownToLearner(messages, "q"), false);
		assert.equal(shownToLearner(messages, "r"), true);
	});

	it("a check preceded by a text block in the same message is shown", async () => {
		const history = [user("teach me"), assistant(quiz("c0", "check", "a")), answer("c0")];
		const { messages } = await runScripted(history, [
			fauxAssistantMessage([fauxText("The next step, taught."), fauxToolCall("quiz", quizInput("check", "b"), { id: "c1" })], toolUse),
		]);
		assert.equal(shownToLearner(messages, "c1"), true);
	});

	it("bounds repeated refusals and a silent repair, leaving a visible fallback", async () => {
		const steps = Array.from({ length: MAX_LESSON_REPAIR_REQUESTS + 1 }, (_, i) =>
			fauxAssistantMessage([fauxToolCall("quiz", quizInput("check", "area"), { id: `q${i}` })], toolUse));
		const { messages, remaining } = await runScripted([user("start")], steps);
		assert.equal(remaining, 0);
		assert.ok(messages.some((m) => m.role === "assistant" && m.content.some((b) => b.type === "text" && b.text === LESSON_REPAIR_FAILED_TEXT)));
		for (let i = 0; i < steps.length; i++) assert.equal(shownToLearner(messages, `q${i}`), false);
		const silent = await runScripted([user("start")], [steps[0]!, ...Array.from({ length: MAX_LESSON_REPAIR_REQUESTS }, () => fauxAssistantMessage([fauxThinking("private")]))]);
		assert.ok(silent.messages.some((m) => m.role === "assistant" && m.content.some((b) => b.type === "text" && b.text === LESSON_REPAIR_FAILED_TEXT)));
	});

	it("the prober refuses a first warm-up and can teach then ask it", async () => {
		const { messages } = await runScripted([user("start")], [
			fauxAssistantMessage([fauxToolCall("probe", quizInput("check", "area"), { id: "p1" })], toolUse),
			fauxAssistantMessage([fauxText("Area is side squared."), fauxToolCall("probe", quizInput("check", "area"), { id: "p2" })], toolUse),
		], true);
		assert.equal(shownToLearner(messages, "p1"), false);
		assert.equal(shownToLearner(messages, "p2"), true);
	});

	it("the prober exposes its guarded warm-up tool", () => {
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

async function runClaudeCode(t: TestContext, history: AgentMessage[], scenarios: string[][], prober = false) {
	const run = fakeRun(t, scenarios);
	const model = CLAUDE_CODE_MODELS.find((m) => m.id === "sonnet");
	assert.ok(model);
	const engine: PiEngine = { model, streamFn: createClaudeCodeStreamFunction(run.runClaude) };
	const agent = prober ? createProberAgent(proberContext, { engine, messages: history }) : createTeacherAgent(undefined, { engine, messages: history });
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
	it("bounds repeated refusals through Claude Code and prints a visible fallback", async (t) => {
		const messages = await runClaudeCode(t, [user("start")], Array.from({ length: MAX_LESSON_REPAIR_REQUESTS + 1 }, (_, i) =>
			cliScenario([{ id: `toolu_q${i}`, name: "quiz", input: quizInput("check", "area") }])));
		assert.ok(messages.some((m) => m.role === "assistant" && m.content.some((b) => b.type === "text" && b.text === LESSON_REPAIR_FAILED_TEXT)));
		for (let i = 0; i <= MAX_LESSON_REPAIR_REQUESTS; i++) assert.equal(shownToLearner(messages, `toolu_q${i}`), false);
	});

	it("the Claude prober refuses a first warm-up, then accepts a visibly taught one", async (t) => {
		const messages = await runClaudeCode(t, [user("start")], [
			cliScenario([{ id: "toolu_p1", name: "probe", input: quizInput("check", "area") }]),
			cliScenario([{ id: "toolu_p2", name: "probe", input: quizInput("check", "area") }], "Area is side squared."),
		], true);
		assert.equal(shownToLearner(messages, "toolu_p1"), false);
		assert.equal(shownToLearner(messages, "toolu_p2"), true);
	});

	it("a Claude same-node retry after don't-know must teach visibly first", async (t) => {
		const history = [user("start"), assistant(text("Area is side squared."), quiz("p", "check", "area")), answer("p", "quiz", false, true)];
		const messages = await runClaudeCode(t, history, [
			cliScenario([{ id: "toolu_q", name: "quiz", input: quizInput("check", "area") }]),
			cliScenario([{ id: "toolu_r", name: "quiz", input: quizInput("check", "area") }], "Multiply the side by itself to find the area."),
		]);
		assert.equal(shownToLearner(messages, "toolu_q"), false);
		assert.equal(shownToLearner(messages, "toolu_r"), true);
	});

});
