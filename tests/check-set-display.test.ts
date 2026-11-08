/**
 * A check set (several teach `quiz` checks in one assistant turn) is displayed
 * strictly ONE question at a time, on every screen size: the dock holds only
 * the first unanswered question, the transcript renders no unanswered sibling,
 * and the next question arrives open (it follows a question) only after the
 * previous one is answered.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { findPendingToolCall, questionPartShownInTranscript } from "../src/core/pending.ts";
import { newAnswerResult, pendingQuestionOf, type LhMessage } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";
import { revealArrival } from "../components/chat.tsx";

function checkSet(...ids: string[]): LhMessage {
	return {
		id: "a1", role: "assistant",
		content: [
			{ type: "text", text: "Teaching first." },
			...ids.map((id) => ({
				type: "toolCall" as const, id, name: "quiz",
				arguments: { type: "check", nodeId: "n1", question: id, options: [{ label: "x", value: "a" }, { label: "y", value: "b" }], explanation: "e", correctAnswer: "a" },
			})),
		],
		stopReason: "toolUse", timestamp: 1, api: "openai-completions", provider: "fixture", model: "fixture",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

const answer = (id: string): LhMessage => ({ ...newAnswerResult(id, "quiz", { kind: "quiz", answers: [], dontKnow: true } as never), id: `ans-${id}` });
const pendingId = (messages: LhMessage[]) => findPendingToolCall(projectView(messages), pendingQuestionOf(messages))?.toolCallId ?? null;
const shownIds = (messages: LhMessage[]) =>
	projectView(messages).flatMap((m) => m.parts).filter((p) => p.type === "tool-quiz" && questionPartShownInTranscript(p.state)).map((p) => p.toolCallId);

test("a check set shows one question at a time: only the first unanswered is pending, and none of the unanswered is in the transcript", () => {
	const messages: LhMessage[] = [checkSet("easy", "medium", "hard")];
	assert.equal(pendingId(messages), "easy");
	assert.deepEqual(shownIds(messages), [], "no unanswered question renders in the transcript");

	messages.push(answer("easy"));
	assert.equal(pendingId(messages), "medium", "the next appears only after the previous is answered");
	assert.deepEqual(shownIds(messages), ["easy"], "only the answered one is a record; medium and hard stay hidden");

	messages.push(answer("medium"));
	assert.equal(pendingId(messages), "hard");
	assert.deepEqual(shownIds(messages), ["easy", "medium"]);

	messages.push(answer("hard"));
	assert.equal(pendingId(messages), null);
	assert.deepEqual(shownIds(messages), ["easy", "medium", "hard"]);
});

test("the first check waits behind the reveal; each next one opens directly", () => {
	assert.deepEqual(revealArrival(false), { expanded: false, revealed: false });
	assert.deepEqual(revealArrival(true), { expanded: true, revealed: true });
});

test("only an answered question part is shown in the transcript", () => {
	for (const state of ["input-streaming", "input-available", "output-error"]) assert.equal(questionPartShownInTranscript(state), false, state);
	assert.equal(questionPartShownInTranscript("output-available"), true);
});
