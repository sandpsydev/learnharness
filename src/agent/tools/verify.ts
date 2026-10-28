import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { invalidInputResult, serverExecute } from "../tool-execute.ts";
import { VERIFY_LIMITS, verifyPromptProblems, type VerifyItem } from "../../core/contracts.ts";
import type { VerifyStore } from "../../core/ports.ts";
import type { SearchStatus } from "../../core/search.ts";

/**
 * The teacher's evidence-routing tools (medical fork, spec "Evidence
 * sources for the Changing tier"):
 *
 *   verify_queue     — write questions for UpToDate Expert AI into the
 *                      learner's queue (plan time AND mid-session), or list
 *                      the queue. The app NEVER asks UpToDate itself: the
 *                      learner's browser extension runs each question by the
 *                      learner's own click and sends the answer back, which
 *                      arrives in the lesson as a message (src/server/verify.ts).
 *   evidence_sources — which of the three evidence routes are usable right
 *                      now (extension, web search, literature), so the
 *                      teacher routes honestly and says plainly what is off.
 *
 * The ctx is injected by the composition root (import law: this layer never
 * imports a store or server module).
 */

export interface VerifyToolContext {
	chatId: string;
	verifyStore: VerifyStore;
	/** Live web-search state (server/search.ts searchStatus). */
	searchStatus: () => SearchStatus;
	/** When the browser extension last called the local API (ISO), or null
	 *  if it never has this run. */
	extensionLastSeen: () => string | null;
}

const queueInput = Type.Object({
	questions: Type.Optional(
		Type.Array(
			Type.Object({
				prompt: Type.String({
					description:
						"The full question for UpToDate Expert AI. SELF-CONTAINED: every question starts a fresh conversation, so include all the clinical context it needs " +
						"(age band, sex, setting, comorbidities, the decision at stake) and ask for the guideline basis. GENERIC: never a name, hospital number, date, " +
						"or any identifier — even if the learner mentioned a real patient; describe the case in the abstract.",
				}),
				claim: Type.Optional(
					Type.String({
						description:
							"The management claim you are about to teach PROVISIONALLY while this is checked — one plain sentence. " +
							"You will be given it back, with the answer, to compare against.",
					}),
				),
			}),
			{ maxItems: VERIFY_LIMITS.perCall, description: "Questions to add. Omit to just list the queue." },
		),
	),
});

const noInput = Type.Object({});

/** Compact queue line for the tool result. */
function line(item: VerifyItem): { id: string; status: string; prompt: string; claim?: string } {
	return {
		id: item.id,
		status: item.status,
		prompt: item.prompt.length > 160 ? `${item.prompt.slice(0, 160)}…` : item.prompt,
		...(item.provisionalClaim ? { claim: item.provisionalClaim } : {}),
	};
}

const PROVISIONAL_REMINDER =
	"Queued. The learner runs these one at a time, by their own click, whenever they choose — teaching continues now, nothing waits. " +
	"Until an answer arrives, mark each related management claim as provisional in the lesson (e.g. “(provisional — awaiting UpToDate Expert AI)”). " +
	"When the answer arrives it comes back as a message: compare, correct what differs, and cite it.";

/** The guard every question passes before it is queued. */
function screen(questions: ReadonlyArray<{ prompt: string; claim?: string }>) {
	const accepted: Array<{ prompt: string; provisionalClaim?: string }> = [];
	const rejected: Array<{ prompt: string; problems: string[] }> = [];
	for (const q of questions) {
		const problems = verifyPromptProblems(q.prompt);
		if (q.claim && q.claim.length > 600) problems.push("claim is over 600 characters; keep it to one sentence");
		if (problems.length > 0) rejected.push({ prompt: q.prompt.trim().slice(0, 80), problems });
		else accepted.push({ prompt: q.prompt, provisionalClaim: q.claim });
	}
	return { accepted, rejected };
}

interface Screened {
	accepted: Array<{ prompt: string; provisionalClaim?: string }>;
	rejected: Array<{ prompt: string; problems: string[] }>;
	listOnly: boolean;
}

export function verifyTools(ctx: VerifyToolContext): Record<string, AgentTool<any>> {
	const runQueue = serverExecute("verify_queue", Type.Unsafe<Screened>({}), (screened: Screened) => {
		const existing = () => ctx.verifyStore.listItems({ chatId: ctx.chatId });
		if (screened.listOnly) return { queue: existing().map(line) };
		const added = ctx.verifyStore.addItems(ctx.chatId, screened.accepted);
		return {
			queued: added.map(line),
			...(screened.rejected.length > 0 ? { rejected: screened.rejected } : {}),
			queue: existing().filter((i) => i.status === "queued" || i.status === "asked").map(line),
			reminder: PROVISIONAL_REMINDER,
		};
	}) as NonNullable<AgentTool<any>["execute"]>;
	return {
		verify_queue: {
			name: "verify_queue",
			label: "verify_queue",
			description:
				"Queue questions for UpToDate Expert AI — the main source for MANAGEMENT principles and clinical judgement (approach to X, first-line choice and why, " +
				"nuanced comparisons). Write the lesson's questions up front when you plan, and append more as the session raises them. " +
				"The learner's browser extension runs each one on the learner's click and sends the answer back; this call never waits for it. " +
				"Call with no `questions` to list this session's queue. Prompts must be self-contained and contain no identifiers.",
			parameters: queueInput,
			execute: async (toolCallId, params, signal) => {
				const input = params as Static<typeof queueInput>;
				const { accepted, rejected } = screen(input.questions ?? []);
				if ((input.questions?.length ?? 0) > 0 && accepted.length === 0) {
					// Every question bounced: the retryable authoring-failure shape.
					return invalidInputResult(
						"verify_queue",
						rejected.flatMap((r) => r.problems.map((p) => `“${r.prompt}…”: ${p}`)),
					);
				}
				return runQueue(toolCallId, { accepted, rejected, listOnly: !input.questions?.length }, signal);
			},
		},

		evidence_sources: {
			name: "evidence_sources",
			label: "evidence_sources",
			description:
				"Report which evidence routes work right now: the Expert AI queue (is the learner's browser extension connected), web search over open guidelines " +
				"(is a search key set), and PubMed / Europe PMC. Call it once when you plan a lesson that has management content, then route accordingly " +
				"and tell the learner plainly about anything that is off.",
			parameters: noInput,
			execute: serverExecute("evidence_sources", noInput, () => {
				const search = ctx.searchStatus();
				const seen = ctx.extensionLastSeen();
				const queued = ctx.verifyStore.listItems({ chatId: ctx.chatId, status: ["queued", "asked"] }).length;
				return {
					expertAi: {
						route: "verify_queue → the learner's browser extension, on the learner's click",
						extensionLastSeen: seen,
						note: seen
							? "The extension has contacted the app this run."
							: "The extension has not contacted the app this run — it may not be installed or open. Queue anyway; the questions wait.",
						pendingInThisSession: queued,
					},
					webSearch: {
						route: "research (the background researcher), aimed at open guidelines",
						available: search.available,
						reason: search.available ? search.reason : `${search.reason}. Web search is OFF: tell the learner plainly, and do not present remembered thresholds or doses as verified.`,
					},
					literature: {
						route: "pubmed_search / pubmed_fetch / europepmc_search (official keyless APIs)",
						available: true,
					},
				};
			}),
		},
	};
}
