/**
 * The Claude Code engine's restart cost (docs: the owner's chat "approach to breast", 2026-11-22).
 *
 * A held CLI process is only continued when the next request is the old conversation plus the tool
 * results. A background result (a steer) that lands right after a tool result breaks that, so the
 * process is killed and the WHOLE record is sent again as one fresh user message. The measured turn
 * (7 steps, a steer after most tool results) re-wrote 91k to 114k tokens on each restart and read only
 * 31,851 tokens (the system prompt and tools) every time.
 *
 * The prompt cache matches a request against an earlier one at content-block boundaries. These tests
 * pin (1) the trigger, using the fake CLI, and (2) that the replay is now laid out so each restart
 * ends on blocks the previous restart stored, measured with a small model of that cache rule (no
 * live call: the rule is the documented block-boundary lookup, and the old numbers it reproduces
 * match the owner's usage log).
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

import { CLAUDE_CODE_MODELS } from "../src/agent/claude-code/provider.ts";
import { createClaudeCodeStreamFunction, type RunClaude } from "../src/agent/claude-code/stream.ts";
import { toClaudeInput, type ClaudeContentBlock } from "../src/agent/claude-code/transcript.ts";

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/claude-code/fake-claude.mjs", import.meta.url));

// ── a model of the prompt cache's block rule ────────────────────────────────

const STATIC_PREFIX_TOKENS = 31_851; // the owner's constant cacheRead: system prompt + tools
const LOOKBACK_BLOCKS = 20; // how far back from the request's last block the cache looks for a stored prefix
const tokensOf = (block: ClaudeContentBlock) => Math.ceil((block.type === "text" ? block.text.length : block.source.data.length) / 4);

/** Reads what an earlier request stored when it ends on a block this request also has (within the
 *  lookback); writes everything after it; stores this request's prefix. */
class BlockCache {
	private stored = new Set<string>();
	request(blocks: ClaudeContentBlock[]): { read: number; write: number } {
		const key = (n: number) => JSON.stringify(blocks.slice(0, n));
		let read = 0;
		for (let n = blocks.length; n >= Math.max(1, blocks.length - LOOKBACK_BLOCKS); n--) {
			if (this.stored.has(key(n))) {
				read = blocks.slice(0, n).reduce((sum, block) => sum + tokensOf(block), 0);
				break;
			}
		}
		const total = blocks.reduce((sum, block) => sum + tokensOf(block), 0);
		this.stored.add(key(blocks.length));
		return { read: STATIC_PREFIX_TOKENS + read, write: total - read };
	}
}

/** The layout before this change: all consecutive text in ONE block. */
function asOneBlock(blocks: ClaudeContentBlock[]): ClaudeContentBlock[] {
	const out: ClaudeContentBlock[] = [];
	for (const block of blocks) {
		const last = out[out.length - 1];
		if (block.type === "text" && last?.type === "text") out[out.length - 1] = { type: "text", text: last.text + block.text };
		else out.push(block);
	}
	return out;
}

// ── a scripted turn ─────────────────────────────────────────────────────────

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });
const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({ role: "assistant", content, api: "claude-code-cli", provider: "claude-code", model: "opus", usage, stopReason: "toolUse", timestamp: 0 });
const result = (id: string, name: string, text: string): ToolResultMessage => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: 0 });
const words = (label: string, kb: number) => `${label} ${"clinical detail ".repeat(Math.ceil((kb * 1024) / 16))}`;

/** ~90k tokens of earlier lesson (the learner's answers, reports already delivered, tool traffic). */
function earlierLesson(): Message[] {
	const out: Message[] = [user("teach me breast imaging")];
	for (let i = 0; i < 16; i++) {
		out.push(assistant([{ type: "text", text: words(`lesson ${i}`, 6) }, { type: "toolCall", id: `old-${i}`, name: "library_read", arguments: { page: i } }]));
		out.push(result(`old-${i}`, "library_read", words(`passage ${i}`, 8)));
		out.push(user(words(`Research complete ${i}`, 8)));
	}
	return out;
}

/** The turn: each step is a tool call, its result, then a background result landing right after it. */
function stepsOf(history: Message[], steps: number): Message[][] {
	const requests: Message[][] = [];
	let messages = [...history];
	for (let step = 0; step < steps; step++) {
		requests.push([...messages]);
		messages = [
			...messages,
			assistant([{ type: "toolCall", id: `call-${step}`, name: "library_search", arguments: { query: `q${step}` } }]),
			result(`call-${step}`, "library_search", words(`search ${step}`, 12)),
			user(words(`Research complete step ${step}`, 8)),
		];
	}
	return requests;
}

function measure(layout: (blocks: ClaudeContentBlock[]) => ClaudeContentBlock[]): { read: number; write: number }[] {
	const cache = new BlockCache();
	// The conversation up to the turn's start was already sent (the learner's last answer continued a held process or
	// restarted one): its cache entry exists in the layout under test.
	const requests = stepsOf(earlierLesson(), 7);
	return requests.map((messages) => cache.request(layout(toClaudeInput(messages).userContent)));
}

test("a restart after a background result re-reads the record instead of re-writing it", (t) => {
	const before = measure(asOneBlock);
	const after = measure((blocks) => blocks);
	const sum = (rows: { read: number; write: number }[], key: "read" | "write", from = 1) => rows.slice(from).reduce((total, row) => total + row[key], 0);

	t.diagnostic(`restarts 2..7, tokens written: before ${sum(before, "write")}, after ${sum(after, "write")}`);
	t.diagnostic(`restarts 2..7, tokens read:    before ${sum(before, "read")}, after ${sum(after, "read")}`);
	t.diagnostic(`per restart write before: ${before.map((row) => row.write).join(" ")}`);
	t.diagnostic(`per restart write after:  ${after.map((row) => row.write).join(" ")}`);

	// Before: every restart reads only the static prefix and re-writes the whole record (the owner's log).
	for (const row of before.slice(1)) assert.equal(row.read, STATIC_PREFIX_TOKENS);
	assert.ok(before.slice(1).every((row) => row.write > 80_000), "each restart re-wrote the whole conversation");

	// After: every restart reads the previous one and writes only what is new since.
	assert.ok(after.slice(1).every((row) => row.read > 80_000), "each restart reads the earlier record");
	assert.ok(after.slice(1).every((row) => row.write < 8_000), "and writes only the step's new entries");
	assert.ok(sum(after, "write") * 10 < sum(before, "write"), "an order of magnitude fewer tokens written over the turn");
});

test("the blocks put together read exactly as the one block did", () => {
	for (const requests of stepsOf(earlierLesson(), 3)) {
		const blocks = toClaudeInput(requests).userContent;
		assert.ok(blocks.length > 20, "one block per entry");
		assert.deepEqual(asOneBlock(blocks).length, 1);
		// An earlier request is a block-for-block prefix of a later one: the growth only appends.
		const later = toClaudeInput([...requests, assistant([{ type: "text", text: "next" }])]).userContent;
		assert.deepEqual(later.slice(0, blocks.length), blocks);
	}
});

// ── the trigger, end to end with the fake CLI ───────────────────────────────

function fakeRun(t: TestContext, scenario: string[], extraEnv: Record<string, string>): { runClaude: RunClaude; spawned: ChildProcessWithoutNullStreams[] } {
	const dir = mkdtempSync(join(tmpdir(), "claude-code-replay-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const scenarioFile = join(dir, "scenario.jsonl");
	writeFileSync(scenarioFile, `${scenario.join("\n")}\n`);
	const spawned: ChildProcessWithoutNullStreams[] = [];
	const runClaude: RunClaude = (args, options) => {
		const child = spawn(process.execPath, [FAKE_CLAUDE, ...args], {
			cwd: options.cwd,
			env: { ...options.env, FAKE_CLAUDE_SCENARIO: scenarioFile, ...extraEnv },
			stdio: ["pipe", "pipe", "pipe", "ipc"],
		}) as ChildProcessWithoutNullStreams;
		t.after(() => child.kill("SIGKILL"));
		spawned.push(child);
		return child;
	};
	return { runClaude, spawned };
}

test("a result that lands right after a tool result restarts the held process with the record as one block per entry", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "claude-code-replay-stdin-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const stdinFile = join(dir, "stdin.jsonl");
	const call = { id: "toolu_replay_a", name: "read", arguments: { path: "a" } };
	const scenario = [
		JSON.stringify({ type: "stream_event", event: { type: "message_start", message: { usage: {} } } }),
		JSON.stringify({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: call.id, name: `mcp__learnharness__${call.name}`, input: {} } } }),
		JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.arguments) } } }),
		JSON.stringify({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }),
		JSON.stringify({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} } }),
		JSON.stringify({ type: "stream_event", event: { type: "message_stop" } }),
		JSON.stringify({ fake: "call", id: call.id, name: call.name, arguments: call.arguments }),
		JSON.stringify({ fake: "reply" }),
	];
	const { runClaude, spawned } = fakeRun(t, scenario, { FAKE_CLAUDE_STDIN: stdinFile });
	const stream = createClaudeCodeStreamFunction(runClaude);
	const model = CLAUDE_CODE_MODELS[0]!;
	const run = async (messages: Message[]) => {
		const context = normalizeContext({ systemPrompt: "You are a tutor.", messages, tools: [{ name: "read", description: "Read", parameters: { type: "object", properties: {} } }] });
		let last: AssistantMessage | undefined;
		for await (const event of stream(model, context, { sessionId: "replay-cache-chat" })) if (event.type === "done") last = event.message;
		assert.ok(last);
		return last;
	};

	const first = await run([user("hi")]);
	assert.equal(first.stopReason, "toolUse");
	// The tool result is followed by a background result: the held process cannot be continued.
	await run([user("hi"), first, result(call.id, "read", "A"), user("Research complete — a report")]);

	assert.equal(spawned.length, 2, "a second process was started: the record is sent again");
	const lines = readFileSync(stdinFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { message?: { content?: ClaudeContentBlock[] } });
	const replay = lines.map((line) => line.message?.content).filter((content): content is ClaudeContentBlock[] => Array.isArray(content)).at(-1);
	assert.ok(replay && replay.length >= 4, "the record went as separate blocks");
	assert.ok(replay.every((block) => block.type === "text"));
	assert.ok(replay.some((block) => block.type === "text" && block.text.includes("Research complete — a report")));
	t.after(() => rmSync(dirname(stdinFile), { recursive: true, force: true }));
});
