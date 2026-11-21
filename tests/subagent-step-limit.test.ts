/**
 * The sub-agent step-limit wrap-up (docs: researcher step-limit fix,
 * 2026-11-21): a loop stopped by maxTurns while the model still wanted tools
 * makes ONE more model call with no tools — but only when the caller opted in
 * with `wrapUp`. Covered on both engines the researcher can run on: a scripted
 * pi (faux) engine and the real Claude Code stream function driven by the fake
 * claude CLI.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { Type } from "typebox";

import { createClaudeCodeStreamFunction, type RunClaude } from "../src/agent/claude-code/stream.ts";
import { CLAUDE_CODE_MODELS } from "../src/agent/claude-code/provider.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { runSubagent } from "../src/agent/subagents/pi-run.ts";

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/claude-code/fake-claude.mjs", import.meta.url));
const WRAP_UP = "Tools are gone. Write the brief now.";

const lookup: AgentTool<any, any> = {
	name: "lookup",
	label: "Lookup",
	description: "Look something up",
	parameters: Type.Object({ q: Type.String() }),
	execute: async (_id, args: { q: string }) => ({ content: [{ type: "text", text: `result for ${args.q}` }], details: null }),
};

function piEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

const callTurn = (id: string) => fauxAssistantMessage([fauxToolCall("lookup", { q: id }, { id })], { stopReason: "toolUse" });

test("pi engine: opted-in loop capped mid-work gets one tool-less wrap-up call", async () => {
	const toolsSeen: number[] = [];
	const seen = (message: ReturnType<typeof fauxAssistantMessage>): FauxResponseStep => (context) => {
		toolsSeen.push(getCurrentTools(context.messages).length);
		return message;
	};
	const run = await runSubagent([lookup], {
		role: "researcher",
		systemPrompt: "sys",
		prompt: "go",
		maxTurns: 2,
		wrapUp: { instruction: WRAP_UP },
		engine: piEngine([seen(callTurn("a")), seen(callTurn("b")), seen(fauxAssistantMessage([fauxText("the brief")]))]),
	});
	assert.equal(run.text, "the brief");
	assert.equal(run.wrappedUp, true);
	assert.deepEqual(toolsSeen, [1, 1, 0]);
});

test("pi engine: without wrapUp the loop just ends at the cap (other sub-agents unchanged)", async () => {
	const run = await runSubagent([lookup], {
		role: "researcher",
		systemPrompt: "sys",
		prompt: "go",
		maxTurns: 2,
		engine: piEngine([callTurn("a"), callTurn("b"), fauxAssistantMessage([fauxText("never asked for")])]),
	});
	assert.equal(run.text, "");
	assert.equal(run.wrappedUp, false);
});

test("pi engine: a loop that finishes on its own never makes the wrap-up call", async () => {
	let calls = 0;
	const counted = (message: ReturnType<typeof fauxAssistantMessage>): FauxResponseStep => () => { calls++; return message; };
	const run = await runSubagent([lookup], {
		role: "researcher",
		systemPrompt: "sys",
		prompt: "go",
		maxTurns: 2,
		wrapUp: { instruction: WRAP_UP },
		engine: piEngine([counted(callTurn("a")), counted(fauxAssistantMessage([fauxText("done in time")]))]),
	});
	assert.equal(run.text, "done in time");
	assert.equal(run.wrappedUp, false);
	assert.equal(calls, 2);
});

test("pi engine: an empty wrap-up reply leaves the capped outcome untouched", async () => {
	const run = await runSubagent([lookup], {
		role: "researcher",
		systemPrompt: "sys",
		prompt: "go",
		maxTurns: 1,
		wrapUp: { instruction: WRAP_UP },
		engine: piEngine([callTurn("a"), fauxAssistantMessage([])]),
	});
	assert.equal(run.text, "");
	assert.equal(run.wrappedUp, false);
});

function streamEvent(event: object): string {
	return JSON.stringify({ type: "stream_event", event });
}

test("Claude Code engine: the wrap-up call starts a fresh CLI turn with no tools and the instruction", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "step-limit-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	// Process 1: one held tool call (the capped step). Process 2: the wrap-up reply.
	const scenarios = [
		[
			streamEvent({ type: "message_start", message: { usage: {} } }),
			streamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "mcp__learnharness__lookup", input: {} } }),
			streamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ q: "x" }) } }),
			streamEvent({ type: "content_block_stop", index: 0 }),
			streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
			streamEvent({ type: "message_stop" }),
			JSON.stringify({ fake: "call", id: "toolu_1", name: "lookup", arguments: { q: "x" } }),
			JSON.stringify({ fake: "hold" }),
		],
		[
			streamEvent({ type: "message_start", message: { usage: {} } }),
			streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
			streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "claude brief" } }),
			streamEvent({ type: "content_block_stop", index: 0 }),
			streamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }),
			streamEvent({ type: "message_stop" }),
			JSON.stringify({ fake: "hold" }),
		],
	];
	const argsSeen: string[][] = [];
	const children: ChildProcessWithoutNullStreams[] = [];
	const runClaude: RunClaude = (args, options) => {
		const index = argsSeen.length;
		argsSeen.push(args);
		const scenarioFile = join(dir, `scenario-${index}.jsonl`);
		writeFileSync(scenarioFile, `${scenarios[index]!.join("\n")}\n`);
		const child = spawn(process.execPath, [FAKE_CLAUDE, ...args], {
			cwd: options.cwd,
			env: { ...options.env, FAKE_CLAUDE_SCENARIO: scenarioFile, FAKE_CLAUDE_STDIN: join(dir, `stdin-${index}.txt`) },
			stdio: ["pipe", "pipe", "pipe", "ipc"],
		}) as ChildProcessWithoutNullStreams;
		children.push(child);
		t.after(() => child.kill("SIGKILL"));
		return child;
	};
	const model = CLAUDE_CODE_MODELS[0]!;
	const run = await runSubagent([lookup], {
		role: "researcher",
		systemPrompt: "sys",
		prompt: "go",
		maxTurns: 1,
		wrapUp: { instruction: WRAP_UP },
		engine: { model, streamFn: createClaudeCodeStreamFunction(runClaude) },
	});
	assert.equal(run.text, "claude brief");
	assert.equal(run.wrappedUp, true);
	assert.equal(argsSeen.length, 2, "one CLI turn for the capped step, one for the wrap-up");
	assert.ok(argsSeen[0]!.includes("--allowedTools"), "the first turn exposed the tool");
	assert.ok(!argsSeen[1]!.includes("--allowedTools"), "the wrap-up turn exposed no tools");
	const wrapStdin = readFileSync(join(dir, "stdin-1.txt"), "utf8");
	assert.ok(wrapStdin.includes(WRAP_UP), "the wrap-up instruction reached the CLI");
	assert.ok(wrapStdin.includes("result for x"), "the findings so far were replayed to the CLI");
});
