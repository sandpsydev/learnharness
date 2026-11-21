/**
 * Claude Code transcript replay (src/agent/claude-code/transcript.ts).
 *
 * The CLI makes one model call per input user message, so earlier turns are
 * rendered as labelled text inside the single user message it receives.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { AssistantMessage, Message, SystemMessage, Tool, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

import { TOOL_RESULT_LABEL_PREFIX, TOOL_USE_LABEL_PREFIX, toClaudeInput, toStreamJsonLine } from "../src/agent/claude-code/transcript.ts";

const READ_TOOL: Tool = { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } };
const WRITE_TOOL: Tool = { name: "write", description: "Write a file", parameters: { type: "object", properties: {} } };

function system(fields: Partial<SystemMessage>): SystemMessage {
	return { role: "system", content: "", timestamp: 0, ...fields };
}

function user(content: UserMessage["content"]): UserMessage {
	return { role: "user", content, timestamp: 0 };
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "claude-code-cli",
		provider: "claude-code",
		model: "opus",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

const HISTORY_NOTE =
	'Note on the record below: entries starting "[earlier tool use, already done:" and "[earlier tool result:" are tools you already used earlier and what came back. ' +
	"They are history, not a format to write. To use a tool now, make a real tool call; never write a tool call out as text.";

function toolResult(toolName: string, content: ToolResultMessage["content"], isError = false): ToolResultMessage {
	return { role: "toolResult", toolCallId: `${toolName}-1`, toolName, content, isError, timestamp: 0 };
}

test("system prompt joins all system content, then the live sections", () => {
	const messages: Message[] = [
		system({ content: "You are a tutor.", sections: { goals: "Teach TCP.", style: "Be brief." } }),
		user("hi"),
		system({ content: "The learner switched topics.", sections: { goals: "Teach TLS.", style: null } }),
		user("next"),
	];
	assert.equal(toClaudeInput(messages).systemPrompt, "You are a tutor.\n\nThe learner switched topics.\n\nTeach TLS.");
});

test("tools reflect toolsAdded minus toolsRemoved", () => {
	const messages: Message[] = [
		system({ content: "p", toolsAdded: [READ_TOOL, WRITE_TOOL] }),
		user("hi"),
		system({ toolsRemoved: [{ name: "read" }] }),
		user("next"),
	];
	assert.deepEqual(
		toClaudeInput(messages).tools.map((t) => t.name),
		["write"],
	);
});

test("single user message passes through as text", () => {
	const input = toClaudeInput([system({ content: "p" }), user("what is a socket?")]);
	assert.deepEqual(input.userContent, [{ type: "text", text: "what is a socket?" }]);
});

test("history renders user, assistant text, tool call name+JSON args and tool result text in order before the latest user message", () => {
	const messages: Message[] = [
		user([{ type: "text", text: "open notes.md" }]),
		assistant([
			{ type: "text", text: "Reading it." },
			{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "notes.md" } },
		]),
		toolResult("read", [{ type: "text", text: "# Notes" }]),
		assistant([{ type: "text", text: "It has a heading." }]),
		user("summarise it"),
	];
	const expected = [
		HISTORY_NOTE,
		"[user]\nopen notes.md",
		"[assistant]\nReading it.",
		'[earlier tool use, already done: read] {"path":"notes.md"}',
		"[earlier tool result: read]\n# Notes",
		"[assistant]\nIt has a heading.",
		"[user]\nsummarise it",
	].join("\n\n");
	assert.deepEqual(toClaudeInput(messages).userContent, [{ type: "text", text: expected }]);
});

test("error tool results are marked as errors in the replay", () => {
	const messages: Message[] = [
		user("open missing.md"),
		assistant([{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "missing.md" } }]),
		toolResult("read", [{ type: "text", text: "ENOENT" }], true),
		user("why?"),
	];
	const expected = [
		HISTORY_NOTE,
		"[user]\nopen missing.md",
		'[earlier tool use, already done: read] {"path":"missing.md"}',
		"[earlier tool result: read, failed]\nENOENT",
		"[user]\nwhy?",
	].join("\n\n");
	assert.deepEqual(toClaudeInput(messages).userContent, [{ type: "text", text: expected }]);
});

test("images in user and tool-result content become base64 image blocks", () => {
	const messages: Message[] = [
		user([
			{ type: "text", text: "look" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		]),
		assistant([{ type: "toolCall", id: "shot-1", name: "screenshot", arguments: {} }]),
		toolResult("screenshot", [{ type: "image", data: "BBBB", mimeType: "image/jpeg" }]),
		user("compare"),
	];
	assert.deepEqual(toClaudeInput(messages).userContent, [
		{ type: "text", text: `${HISTORY_NOTE}\n\n[user]\nlook` },
		{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
		{ type: "text", text: "[earlier tool use, already done: screenshot] {}\n\n[earlier tool result: screenshot]" },
		{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } },
		{ type: "text", text: "[user]\ncompare" },
	]);
});

test("transcript ending on a tool result renders as history with no trailing user turn", () => {
	const messages: Message[] = [
		user("open notes.md"),
		assistant([{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "notes.md" } }]),
		toolResult("read", [{ type: "text", text: "# Notes" }]),
	];
	const expected = [HISTORY_NOTE, "[user]\nopen notes.md", '[earlier tool use, already done: read] {"path":"notes.md"}', "[earlier tool result: read]\n# Notes"].join("\n\n");
	assert.deepEqual(toClaudeInput(messages).userContent, [{ type: "text", text: expected }]);
});

test("a replayed quiz call never looks like a call the model could imitate", () => {
	const quiz = { type: "check", nodeId: "breast-imaging", question: "Which view is standard?", options: [{ label: "CC and MLO" }], correctAnswer: "CC and MLO", explanation: "Standard." };
	const answer = JSON.stringify({ chosen: "CC and MLO", correct: true });
	const messages: Message[] = [
		user("teach me"),
		assistant([{ type: "toolCall", id: "quiz-1", name: "quiz", arguments: quiz }]),
		toolResult("quiz", [{ type: "text", text: answer }]),
		user("What's desmoplastic reaction?"),
	];
	const [block] = toClaudeInput(messages).userContent;
	assert.ok(block?.type === "text");
	const text = block.text;

	assert.ok(!text.includes("[tool call"), text);
	assert.ok(!text.includes("[tool result"), text);
	assert.ok(text.includes(`${TOOL_USE_LABEL_PREFIX}quiz] ${JSON.stringify(quiz)}`), text);
	assert.ok(text.includes(`${TOOL_RESULT_LABEL_PREFIX}quiz]\n${answer}`), text);
	assert.ok(text.startsWith(HISTORY_NOTE), text);
});

test("a transcript with no tool use gets no history note", () => {
	const messages: Message[] = [user("hi"), assistant([{ type: "text", text: "Hello." }]), user("bye")];
	assert.deepEqual(toClaudeInput(messages).userContent, [{ type: "text", text: "[user]\nhi\n\n[assistant]\nHello.\n\n[user]\nbye" }]);
});

test("thinking blocks are omitted from replay", () => {
	const messages: Message[] = [
		user("hi"),
		assistant([
			{ type: "thinking", thinking: "secret plan" },
			{ type: "text", text: "Hello." },
		]),
		user("bye"),
	];
	assert.deepEqual(toClaudeInput(messages).userContent, [{ type: "text", text: "[user]\nhi\n\n[assistant]\nHello.\n\n[user]\nbye" }]);
});

test('toStreamJsonLine emits {"type":"user","message":{"role":"user","content":[...]}}', () => {
	assert.deepEqual(JSON.parse(toStreamJsonLine([{ type: "text", text: "hi" }])), {
		type: "user",
		message: { role: "user", content: [{ type: "text", text: "hi" }] },
	});
});
