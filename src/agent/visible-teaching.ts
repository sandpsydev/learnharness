import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { normalizeQuizType, normalizeOptions, resolveCorrect } from "../core/question-core.ts";
import { QUESTION_TOOLS } from "../core/pending.ts";
import { failedOutputCallIds, sendToUserText, SEND_TO_USER_TOOL, type LhMessage } from "../core/native-messages.ts";
import { stripModelValueDebris } from "../core/value-debris.ts";

/** Assessment surfaces only: clarification/choice questions never need a lesson. */
export const GUARDED_QUESTION_TOOLS: readonly string[] = ["quiz", "explain", "probe", "recall", "problem"];
const ANSWER_TOOLS: readonly string[] = [...QUESTION_TOOLS, "problem"];
export const MAX_LESSON_REPAIR_REQUESTS = 3;
export const UNSEEN_STEP_NOTE =
	"Question not shown: the learner has not seen this step. The learner only sees visible messages — never your thinking — " +
	"and no lesson has been printed since their last message or answer. Nothing was shown to the learner. " +
	"Teach this step now in a visible message (send_to_user, or ordinary reply text), then ask the question. " +
	"Introductions, plans and progress updates do not teach the step.";
export const LESSON_REPAIR_FAILED_TEXT =
	"I couldn’t finish the explanation before asking the next question. Please retry this turn so I can explain it first.";

// A roadmap is not a lesson. Exclude procedural sentences, acknowledgements,
// questions and references to prior sessions. This is deliberately a surface
// check, not a semantic grader of whether an explanation is medically correct.
const PROCEDURAL_SENTENCE = /^(?:(?:so|then|next|now|first)[,:]?\s+)*(?:(?:i|we)(?:\b|'|’)|let(?:'|’)s\b|your\s+(?:map|previous|earlier|past|prior)\b|(?:a few|some|these|the next)\s+questions?\b|(?:okay|ok|sure|thanks|thank you|great|correct|welcome|done)\b|try\s+(?:this|the following)\b)/iu;

/** Keep only explanatory sentences; a plan cannot supply a missing label. */
function lessonText(value: string): string {
	return value.split(/(?<=[.!?])\s+|\n+/u).filter((sentence) => {
		const plain = sentence.trim().replace(/^[#>*_\s-]+/u, "");
		return /[\p{L}\p{N}]/u.test(plain) && !plain.endsWith("?") && !PROCEDURAL_SENTENCE.test(plain);
	}).join("\n");
}

export function hasLessonText(value: string): boolean { return lessonText(value).trim().length > 0; }

type Block = { type: string; id?: string; name?: string; arguments?: unknown; text?: unknown };
interface Asked {
	nodeId: string | undefined;
	type: ReturnType<typeof normalizeQuizType>;
	taught: boolean;
	lesson: string;
	arguments: unknown;
	tool: string | undefined;
	correct?: boolean;
}

function questionOf(block: Block): Asked {
	const args = block.arguments as { nodeId?: unknown; type?: unknown } | undefined;
	const raw = args?.nodeId;
	return {
		nodeId: typeof raw === "string" && raw.trim() ? stripModelValueDebris(raw).trim() : undefined,
		type: normalizeQuizType(args?.type),
		taught: false,
		lesson: "",
		arguments: args,
		tool: block.name,
	};
}

/** A new numbered answer category needs its own visible teaching. */
function coversAnswerLabels(lesson: string, args: unknown): boolean {
	const input = args as { options?: Parameters<typeof normalizeOptions>[0]; correctAnswer?: string | string[] } | undefined;
	if (!input) return true;
	let options: ReturnType<typeof normalizeOptions>;
	try { options = normalizeOptions(input.options); } catch { return false; }
	const answer = options.length
		? resolveCorrect(input.correctAnswer, options).indices.map((i) => options[i - 1]?.label ?? "").join(" ")
		: typeof input.correctAnswer === "string" ? input.correctAnswer : "";
	// Short numbered category codes need teaching. Longer names containing
	// digits are not category codes: a lesson can explain them in ordinary words.
	const labels = answer.match(/\b[A-Z]\d+[a-z]*\b/gu) ?? [];
	const taught = new Set(lesson.match(/\b[A-Z]\d+[a-z]*\b/gu) ?? []);
	return labels.every((label) => taught.has(label));
}

/** Only a correct CHECK continues an already taught check set on that node. */
function continuesTaughtCheck(last: Asked | undefined, next: Asked): boolean {
	return ["quiz", "explain"].includes(last?.tool ?? "") && ["quiz", "explain"].includes(next.tool ?? "") &&
		last?.taught === true && last.correct === true && last.type === "check" && next.type === "check" &&
		next.nodeId !== undefined && next.nodeId === last.nodeId && coversAnswerLabels(last.lesson, next.arguments);
}

function visibleText(block: Block, failedOutputs: ReadonlySet<string>): string | undefined {
	if (block.type === "text" && typeof block.text === "string") return block.text;
	if (block.type === "toolCall" && block.name === SEND_TO_USER_TOOL && !failedOutputs.has(block.id ?? "")) {
		return sendToUserText(block);
	}
	return undefined;
}

export type VisibleTeachingRefusal = "no-text" | "procedural-only" | "unseen-category-label" | "not-correct-same-node";
export interface VisibleTeachingDecision {
	reason: VisibleTeachingRefusal;
	visibleWords: number;
	explanatoryWords: number;
	visibleWordsSinceAnswer: number;
	explanatoryWordsSinceAnswer: number;
}
const words = (value: string) => value.match(/[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu)?.length ?? 0;

/** An acknowledgement/test request continues the explanation already on screen.
 * Substantive questions, topic changes and image/file inputs still reset it. */
function continuesVisibleLesson(message: AgentMessage): boolean {
	if (message.role !== "user") return false;
	const content = message.content;
	if (Array.isArray(content) && content.some((b) => b.type !== "text")) return false;
	const value = (typeof content === "string" ? content : content.map((b) => b.type === "text" ? b.text : "").join(" "))
		.toLowerCase().replace(/[—–,:;.!?]+/gu, " ").replace(/\s+/gu, " ").trim();
	return /^(?:(?:ok(?:ay)?|opk|alright|got it|understood|yes|nice|i (?:get|understand|know) (?:it|this)|test me|quiz me|next|continue|go on|what(?:'s|’s| is) next)\s*)+$/u.test(value);
}

/**
 * One rule on every engine and agent: a question needs visible teaching since
 * the last substantive learner input, except a correct same-node check-set continuation.
 * Simple acknowledgements/test requests retain the already visible explanation.
 * Only blocks BEFORE the call count. Thinking, tool results and failed output
 * calls never grant teaching credit. No question type or missing node bypasses
 * the rule. Historical answers carry check-set credit only if taught on screen.
 */
export function unseenStepDecision(
	history: readonly AgentMessage[],
	assistant: { content: readonly Block[] },
	callId: string,
): VisibleTeachingDecision | null {
	const callAt = assistant.content.findIndex((b) => b.type === "toolCall" && b.id === callId);
	const call = assistant.content[callAt];
	if (!call || !GUARDED_QUESTION_TOOLS.includes(call.name ?? "")) return null;
	const failedOutputs = failedOutputCallIds(history as readonly LhMessage[]);
	const asked = new Map<string, Asked>();
	let last: Asked | undefined;
	let visible = false;
	let lesson = "";
	let rawVisible = "";
	let sinceAnswer = "";
	let explanationSinceAnswer = "";
	const scan = (block: Block) => {
		const text = visibleText(block, failedOutputs);
		const teaching = text ? lessonText(text) : "";
		if (text) { rawVisible += `\n${text}`; sinceAnswer += `\n${text}`; }
		if (teaching) explanationSinceAnswer += `\n${teaching}`;
		if (teaching) { visible = true; lesson += `\n${teaching}`; }
		if (block.type === "toolCall" && block.id && ANSWER_TOOLS.includes(block.name ?? "")) {
			const question = questionOf(block);
			question.taught = (visible && coversAnswerLabels(lesson, question.arguments)) || continuesTaughtCheck(last, question);
			question.lesson = visible ? lesson : last?.lesson ?? "";
			asked.set(block.id, question);
		}
	};
	for (const message of history) {
		if (message.role === "assistant") {
			for (const block of message.content as readonly Block[]) scan(block);
		} else if (message.role === "user" || (message.role === "custom" && ["practice-thinking", "practice-next"].includes(message.customType))) {
			if (!continuesVisibleLesson(message)) {
				visible = false;
				lesson = "";
				rawVisible = "";
				last = undefined;
			}
		} else if (message.role === "toolResult" && !message.isError && message.details != null) {
			const question = asked.get(message.toolCallId);
			if (question && ANSWER_TOOLS.includes(message.toolName)) {
				const details = message.details as { correct?: unknown; dontKnow?: unknown; dismissed?: unknown };
				last = { ...question, correct: details.correct === true && details.dontKnow !== true && details.dismissed !== true };
				visible = false;
				lesson = "";
				rawVisible = "";
				sinceAnswer = "";
				explanationSinceAnswer = "";
			}
		}
	}
	for (const block of assistant.content.slice(0, callAt)) scan(block);
	const next = questionOf(call);
	if ((visible && coversAnswerLabels(lesson, call.arguments)) || continuesTaughtCheck(last, next)) return null;
	const reason: VisibleTeachingRefusal = visible ? "unseen-category-label" : rawVisible.trim() ? "procedural-only" :
		last?.nodeId !== undefined && last.nodeId === next.nodeId && last.correct !== true ? "not-correct-same-node" : "no-text";
	return { reason, visibleWords: words(rawVisible), explanatoryWords: words(lesson),
		visibleWordsSinceAnswer: words(sinceAnswer), explanatoryWordsSinceAnswer: words(explanationSinceAnswer) };
}

export function unseenStepNote(history: readonly AgentMessage[], assistant: { content: readonly Block[] }, callId: string): string | null {
	return unseenStepDecision(history, assistant, callId) ? UNSEEN_STEP_NOTE : null;
}
