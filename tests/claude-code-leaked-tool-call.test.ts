/**
 * Leaked tool-call safety net (src/agent/claude-code/leaked-tool-call.ts): a tool call the model
 * wrote out as text must never reach the learner as raw JSON.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { hasLeakedToolCall, stripLeakedToolCalls } from "../src/agent/claude-code/leaked-tool-call.ts";

const QUIZ = '{"type":"check","nodeId":"breast-imaging","question":"Which view? {a}","options":[{"label":"CC \\"and\\" MLO"}],"explanation":"x ] y"}';

test("the old replay shape from the owner's chat is detected and removed whole", () => {
	const text = `Let's check.\n\n[tool call quiz] ${QUIZ}\n\n[tool call quiz] ${QUIZ}\n\nThen we go on.`;

	assert.equal(hasLeakedToolCall(text), true);
	assert.equal(stripLeakedToolCalls(text), "Let's check.\n\nThen we go on.");
});

test("the new replay labels are removed too, with their JSON", () => {
	const text = `Before.\n[earlier tool use, already done: quiz] ${QUIZ}\nAfter.`;

	assert.equal(hasLeakedToolCall(text), true);
	assert.equal(stripLeakedToolCalls(text), "Before.\n\nAfter.");
});

test("a leaked call with pretty-printed JSON and braces inside strings is removed whole", () => {
	const text = `[tool call quiz]\n${JSON.stringify(JSON.parse(QUIZ), null, 2)}`;

	assert.equal(stripLeakedToolCalls(text), "");
});

test("a leaked result label without a payload is removed on its own", () => {
	assert.equal(stripLeakedToolCalls("[tool result quiz]\nfine"), "fine");
});

test("an unterminated leaked JSON payload is removed to the end", () => {
	assert.equal(stripLeakedToolCalls('Hi.\n[tool call quiz] {"question":"cut off'), "Hi.");
});

test("ordinary text, brackets and JSON are left alone", () => {
	const text = 'Use the [tool] wisely. Example: {"a":1} and [1, 2].';

	assert.equal(hasLeakedToolCall(text), false);
	assert.equal(stripLeakedToolCalls(text), text);
});
