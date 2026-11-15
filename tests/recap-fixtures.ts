/**
 * A small teaching session for the Session recap tests: the shapes the real
 * record carries (user and teacher messages, answered check-ins, a real figure,
 * a drawn figure, a table), built by hand. No model anywhere.
 */

import type { FigureResult } from "../src/core/contracts/jobs.ts";
import { buildSubagentSteer } from "../src/core/contracts/jobs.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { QuestionAnswerData } from "../src/core/question-core.ts";

export const CHAT_ID = "chat_abc123_def45678";
export const FIGURE_FILE = "0123456789abcdef01234567.png";

export function user(id: string, text: string): LhMessage {
	return { id, role: "user", content: text, timestamp: 1 } as never;
}

export function teacher(id: string, text: string): LhMessage {
	return {
		id,
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openai-codex",
		model: "fake",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason: "stop",
		timestamp: 1,
	} as never;
}

export function toolResult(id: string, toolName: string, details: unknown, isError = false): LhMessage {
	return { id, role: "toolResult", toolCallId: `call_${id}`, toolName, content: [{ type: "text", text: "ok" }], details, isError, timestamp: 1 } as never;
}

export const TABLE = ["| Drug | Mechanism |", "| --- | --- |", "| Furosemide | Blocks NKCC2 in the thick ascending limb |", "| Spironolactone | Blocks aldosterone receptors |"].join("\n");

export const quizAnswer = (over: Partial<QuestionAnswerData> = {}): QuestionAnswerData => ({
	kind: "quiz",
	tool: "quiz",
	questionType: "check",
	questionText: "Which transporter does furosemide block?",
	options: [
		{ index: 1, label: "NCC" },
		{ index: 2, label: "NKCC2" },
		{ index: 3, label: "ENaC" },
	],
	dontKnow: false,
	answers: [{ label: "NCC", value: "ncc", index: 1 }],
	correct: false,
	correctIndices: [2],
	explanation: "Furosemide acts on NKCC2 in the thick ascending limb; NCC is the thiazide target.",
	answeredAt: "2026-11-10T09:00:00.000Z",
	...over,
});

const figureResult: FigureResult = {
	concept: "chest X-ray of a left pneumothorax",
	outcome: "image",
	image: {
		file: FIGURE_FILE,
		mime: "image/png",
		tier: "radiopaedia",
		source: "Radiopaedia",
		title: "Left pneumothorax",
		credit: "Dr Example, via Radiopaedia",
		licence: "CC BY-NC-SA 3.0",
	},
	caption: "Left pneumothorax on an erect chest X-ray.",
	keyFeature: "The visceral pleural line with no lung markings beyond it.",
	links: [],
	brief: "A real figure is shown.",
};

/** The session: teaching on diuretics, a table, a missed check, a real figure, a drawn figure, and a skipped question. */
export function sessionMessages(): LhMessage[] {
	return [
		user("m1", "Teach me how loop diuretics work."),
		teacher("m2", `Loop diuretics block NKCC2 in the thick ascending limb, so less sodium is reabsorbed there.\n\n${TABLE}\n\nThe table shows which transporter each drug blocks.`),
		toolResult("m3", "quiz", quizAnswer()),
		teacher("m4", "Not quite: the loop diuretics act on NKCC2, not NCC. NCC is the thiazide target."),
		buildSubagentSteer({ id: "job_fig", kind: "figure", toolCallId: "call_fig" }, figureResult),
		buildSubagentSteer({ id: "job_vis", kind: "visual", toolCallId: "call_vis" }, { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>' }),
		teacher("m7", "The drawn diagram shows the nephron with the thick ascending limb marked."),
		toolResult("m8", "quiz", quizAnswer({ questionText: "Which ion shift causes the hypokalaemia?", options: undefined, answers: [], dontKnow: true, correct: undefined, correctIndices: undefined, explanation: undefined, dismissed: true })),
		user("m9", "Let's stop here for today."),
	];
}
