import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { normalizeQuizType, type QuizQuestionType } from "../core/question-core.ts";
import { failedOutputCallIds, sendToUserText, SEND_TO_USER_TOOL, type LhMessage } from "../core/native-messages.ts";
import { stripModelValueDebris } from "../core/value-debris.ts";

/**
 * Visible-teaching guard (medical fork): the teacher may not CHECK a step the
 * learner has not been taught yet.
 *
 * The failure it stops: the teacher writes a step's teaching only in its
 * thinking (which the learner never sees) and then calls a check quiz — the
 * learner meets a question about material nobody showed them ("you haven't
 * taught me the T numbers"). Only what the learner can SEE counts as teaching:
 * a non-empty text block, or a non-empty `send_to_user` message, from the
 * teacher. Thinking never counts.
 *
 * The rule refuses exactly two cases and nothing else:
 *   1. a CHECK right after the learner answered a PREDICT, with no visible
 *      teaching since that answer (the predict's answer is where the teaching
 *      is owed);
 *   2. a CHECK on a DIFFERENT node than the previous question, with no visible
 *      teaching since that question's answer (a new step starts with teaching).
 * Predict questions, the follow-up questions of a check set on the same node,
 * the first question of a chat, and repair flows are never refused.
 *
 * It is a pure read of the transcript, so it works the same on every engine
 * (pi-native and Claude Code); a refused call returns an error result the
 * learner never sees as a question (the dock mounts only on a clean call).
 */

/** The teach questions the rule watches (the quiz and its free-recall twin). */
export const GUARDED_QUESTION_TOOLS: readonly string[] = ["quiz", "explain"];

/** The only question role the rule ever refuses. */
export const REFUSED_QUESTION_TYPE: QuizQuestionType = "check";

/** What the teacher is told when a check is refused. */
export const UNSEEN_STEP_NOTE =
	"Check not shown: the learner has not seen this step. The learner only sees visible messages — never your thinking — " +
	"and nothing visible has been taught since their last answer. Nothing was shown to the learner. " +
	"Teach this step now in a visible message (send_to_user, or ordinary reply text), then ask the check.";

interface Answered {
	nodeId: string;
	type: QuizQuestionType | undefined;
}

type Block = { type: string; id?: string; name?: string; arguments?: unknown; text?: unknown };

function nodeIdOf(args: unknown): string | undefined {
	const raw = (args as { nodeId?: unknown } | null | undefined)?.nodeId;
	return typeof raw === "string" && raw.trim() ? stripModelValueDebris(raw).trim() : undefined;
}

function isVisible(block: Block, failedOutputs: ReadonlySet<string>): boolean {
	if (block.type === "text") return typeof block.text === "string" && block.text.trim() !== "";
	if (block.type === "toolCall" && block.name === SEND_TO_USER_TOOL) {
		return !failedOutputs.has(block.id ?? "") && sendToUserText(block) !== undefined;
	}
	return false;
}

/**
 * The decision, as a pure function. `history` is everything saved/held BEFORE
 * the assistant message that carries the call; `assistant` is that message
 * (only its blocks BEFORE the call count — what follows is not yet shown).
 * Returns the refusal note, or null to let the call through.
 */
export function unseenStepNote(
	history: readonly AgentMessage[],
	assistant: { content: readonly Block[] },
	callId: string,
): string | null {
	const callAt = assistant.content.findIndex((b) => b.type === "toolCall" && b.id === callId);
	const call = callAt >= 0 ? assistant.content[callAt] : undefined;
	if (!call || !GUARDED_QUESTION_TOOLS.includes(call.name ?? "")) return null;
	if (normalizeQuizType((call.arguments as { type?: unknown } | null)?.type) !== REFUSED_QUESTION_TYPE) return null;
	const nodeId = nodeIdOf(call.arguments);
	if (nodeId === undefined) return null;

	const failedOutputs = failedOutputCallIds(history as readonly LhMessage[]);
	const asked = new Map<string, Answered>();
	let last: Answered | undefined;
	let visible = false;
	for (const message of history) {
		if (message.role === "assistant") {
			for (const block of message.content as readonly Block[]) {
				if (isVisible(block, failedOutputs)) visible = true;
				if (block.type === "toolCall" && GUARDED_QUESTION_TOOLS.includes(block.name ?? "")) {
					const id = nodeIdOf(block.arguments);
					if (id !== undefined && block.id) {
						asked.set(block.id, { nodeId: id, type: normalizeQuizType((block.arguments as { type?: unknown } | null)?.type) });
					}
				}
			}
		} else if (message.role === "toolResult" && !message.isError && message.details != null) {
			const answered = asked.get(message.toolCallId);
			if (answered && GUARDED_QUESTION_TOOLS.includes(message.toolName)) {
				last = answered;
				visible = false;
			}
		}
	}
	for (const block of assistant.content.slice(0, callAt)) if (isVisible(block, failedOutputs)) visible = true;

	if (!last || visible) return null;
	if (last.type === "predict" || last.nodeId !== nodeId) return UNSEEN_STEP_NOTE;
	return null;
}
