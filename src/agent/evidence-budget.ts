import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { nativeInputCause } from "../core/native-messages.ts";

/**
 * The evidence budget (medical fork): how much outside research the teacher
 * may START per learner message. A "basic overview" lesson is taught mainly
 * from the lecture, the learner's library and what the teacher already knows;
 * every research brief and Expert AI answer lands in the teacher's context in
 * full, so an unbounded fan-out (5 research jobs + 6 Expert AI questions on
 * one overview request) grows the context and the lesson far past what was
 * asked.
 *
 * The limits are per LEARNER message: they reset when the learner writes (or
 * answers a quiz), NOT when a job result wakes the teacher — otherwise each
 * returning brief would hand the teacher a fresh allowance and the fan-out
 * would just continue in the next turn. The count therefore starts from the
 * saved transcript (everything the teacher already started since the last
 * learner input) and adds this request's own calls as they happen.
 */
export const EVIDENCE_LIMITS = {
	/** Most `research` (web research) jobs the teacher may start per learner message. */
	researchJobs: 2,
	/** Most UpToDate Expert AI questions `verify_queue` may queue per learner message. */
	expertAiQuestions: 2,
} as const;

export interface EvidenceBudget {
	/** Claim one research job. False = the limit is reached; start nothing. */
	claimResearch(): boolean;
	/** Claim up to `wanted` Expert AI questions; returns how many may be queued. */
	claimQuestions(wanted: number): number;
}

/** What the teacher is told when `research` is over the limit. */
export const RESEARCH_LIMIT_NOTE =
	`Research limit for this step reached: at most ${EVIDENCE_LIMITS.researchJobs} web research jobs are started per learner message, and this message has used them. ` +
	"Nothing was started. Teach from what you already have — the learner's lecture and library, and what you know — and mark anything you could not check as unverified. " +
	"If the learner asks for more depth, you may research that one specific gap after their next message.";

/** The Expert AI note: how many were queued, and what to do about the rest. */
export function expertAiLimitNote(queued: number, notQueued: number): string {
	return (
		`Expert AI limit for this step reached: at most ${EVIDENCE_LIMITS.expertAiQuestions} questions are queued per learner message. ` +
		`${queued} queued, ${notQueued} NOT queued (nothing was started for those). ` +
		"Teach from what you already have — the learner's lecture and library, and what you know — and mark what you could not check as unverified. " +
		"If the learner asks for more depth, you may queue a question for that one specific gap after their next message."
	);
}

interface Used {
	research: number;
	questions: number;
}

/** What the transcript shows the teacher already started since the last
 *  learner input (a message, a quiz/ask/explain answer). */
export function evidenceUsedSinceLearner(history: readonly AgentMessage[]): Used {
	let from = 0;
	for (let i = history.length - 1; i >= 0; i--) {
		if (nativeInputCause(history[i]!, history.slice(0, i)) === "learner") {
			from = i + 1;
			break;
		}
	}
	const tail = history.slice(from);
	const results = new Map<string, { isError?: boolean; details?: unknown }>();
	for (const m of tail) if (m.role === "toolResult") results.set(m.toolCallId, m);
	const used: Used = { research: 0, questions: 0 };
	for (const m of tail) {
		if (m.role !== "assistant") continue;
		for (const block of m.content) {
			if (block.type !== "toolCall") continue;
			const result = results.get(block.id);
			if (result?.isError) continue;
			if (block.name === "research") used.research += 1;
			else if (block.name === "verify_queue") {
				const queued = (result?.details as { queued?: unknown } | undefined)?.queued;
				if (Array.isArray(queued)) used.questions += queued.length;
			}
		}
	}
	return used;
}

/** A budget seeded from the saved transcript (see the file header). */
export function evidenceBudgetFor(history: readonly AgentMessage[] = []): EvidenceBudget {
	const used = evidenceUsedSinceLearner(history);
	return {
		claimResearch() {
			if (used.research >= EVIDENCE_LIMITS.researchJobs) return false;
			used.research += 1;
			return true;
		},
		claimQuestions(wanted) {
			const granted = Math.max(0, Math.min(wanted, EVIDENCE_LIMITS.expertAiQuestions - used.questions));
			used.questions += granted;
			return granted;
		},
	};
}
