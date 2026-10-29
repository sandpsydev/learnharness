/** Medical Phase 9: scope and learner-request plumbing; no pacing counters. */
import type { PlanGroup, PlanNode, PlanTree, ProbeAssessment } from "./contracts.ts";
import { PlanTreeError } from "./plan-tree.ts";
import { derivePlanStatusesLh } from "./contracts/plan.ts";
import { danglingQuestionOf, hasProbeDone, newAnswerResult, probeDoneResultIds, type LhMessage } from "./native-messages.ts";
import { dismissedAnswer } from "./question-core.ts";
import { toolQuestionKind } from "./pending.ts";
import { parseProbeDoneInput } from "./tool-parts.ts";

export const TEST_OUT_PHRASE = "I know this — test me";

/** Accept the same words with ordinary keyboard punctuation, too. */
export function isTestOutRequest(text: string): boolean {
	return /^i know this\s*(?:[—–-]|[,;:])\s*test me[.!]?$/i.test(text.trim());
}

/** Read only a successful conclusion; failed/retried calls aren't verdicts. */
export function medicalProbeAssessment(messages: readonly LhMessage[]): ProbeAssessment | undefined {
	const calls = new Map<string, ProbeAssessment>();
	const successful = probeDoneResultIds(messages);
	for (const m of messages) {
		if (m.role === "assistant") {
			if (m.stopReason === "error" || m.stopReason === "aborted") continue;
			for (const block of m.content) {
				if (block.type === "toolCall" && block.name === "probe_done") {
					const input = parseProbeDoneInput(block.arguments);
					if (input) calls.set(block.id, input.assessment);
				}
			}
		} else if (m.role === "toolResult" && successful.has(m.id) && calls.has(m.toolCallId)) {
			return calls.get(m.toolCallId);
		}
	}
	return undefined;
}

export interface MedicalPlanArea {
	nodeId: string;
	group?: PlanGroup;
	probeStrands?: string[];
	reason?: string;
}

/** Link plan landmarks to the probe, with explicit scope for off-path items
 * and source-discovered gaps. Old plans remain ungrouped. */
export function medicalPlanNodes(nodes: PlanNode[], areas: MedicalPlanArea[] | undefined, assessment?: ProbeAssessment): PlanNode[] {
	const verdicts = new Map(assessment?.strands.map((s) => [s.strand, s.status]));
	if (!areas) {
		if (assessment?.strands.some((s) => s.status)) throw new PlanTreeError("Supply areas for every map node: Already yours, To build or Optional.");
		return nodes;
	}
	const byId = new Map<string, MedicalPlanArea>();
	for (const area of areas) {
		if (!nodes.some((n) => n.id === area.nodeId)) throw new PlanTreeError(`Unknown area nodeId: ${area.nodeId}`);
		if (byId.has(area.nodeId)) throw new PlanTreeError(`Duplicate area nodeId: ${area.nodeId}`);
		for (const strand of area.probeStrands ?? []) {
			if (!verdicts.has(strand)) throw new PlanTreeError(`Unknown probe strand: ${strand}. Copy its name exactly.`);
		}
		byId.set(area.nodeId, area);
	}
	return nodes.map((node) => {
		const area = byId.get(node.id);
		if (!area) throw new PlanTreeError(`Missing area for node: ${node.id}`);
		const refs = area.probeStrands ?? [];
		const group = area.group ?? (refs.length && refs.every((s) => verdicts.get(s) === "hold") ? "already-yours" : "to-build");
		return { ...node, group, ...(refs.length ? { probeStrands: refs } : {}), ...(area.reason ? { summary: area.reason } : {}) };
	});
}

/** A test-out replaces a waiting ordinary question on this step with a
 * harder applied one. Close its tool call honestly as skipped, never right.
 * This runs atomically in the same input write as the learner's phrase. */
export function testOutAppends(record: { messages: LhMessage[]; tree?: PlanTree; kind?: string }, text: string): LhMessage[] {
	if (!isTestOutRequest(text) || record.kind === "practice" || !record.tree || !hasProbeDone(record.messages)) return [];
	const current = derivePlanStatusesLh(record.tree, record.messages).current;
	if (!current) return [];
	const appends: LhMessage[] = [];
	let pending = danglingQuestionOf(record.messages);
	while (pending) {
		const args = pending.input as { nodeId?: string; question?: string };
		if ((pending.tool !== "quiz" && pending.tool !== "explain") || args.nodeId !== current) {
			throw new Error("Answer or dismiss the waiting question before testing out of this step.");
		}
		appends.push(newAnswerResult(pending.toolCallId, pending.tool, dismissedAnswer(toolQuestionKind(pending.tool), args.question ?? "")));
		pending = danglingQuestionOf([...record.messages, ...appends]);
	}
	return appends;
}

/** The requested hard question opens directly, without another reveal tap.
 * Only the first teaching question after the latest request gets this. */
export function isTestOutQuestion(messages: readonly LhMessage[], toolCallId: string): boolean {
	let requested = false;
	let first: string | undefined;
	for (const m of messages) {
		if (m.role === "user") {
			const text = typeof m.content === "string" ? m.content : m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
			requested = isTestOutRequest(text);
			first = undefined;
		} else if (requested && first === undefined && m.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted") {
			for (const b of m.content) {
				if (b.type === "toolCall" && (b.name === "quiz" || b.name === "explain")) { first = b.id; break; }
			}
		}
	}
	return first === toolCallId;
}
