/**
 * The placer — the single-submit agent that gives every fact its place in the
 * outline (docs/medical-spec.md "Textbook outline placement"): organ system →
 * topic → aspect. It reads a batch of facts (name + statement + any tags they
 * already carry) together with the app's CANONICAL topic list and answers
 * with one placement per fact.
 *
 * The model never sees a source and never touches a ledger; the caller turns
 * its answers into placement lines (core/placement.ts applyPlacerProposals).
 * That is also where canonical-topic reuse is enforced: a topic named in a
 * different spelling, or by an unambiguous acronym, resolves to the topic the
 * app already holds, and only a genuinely new name mints one.
 *
 * Same seam as the tagger: runSubmitAgent, plain-string schema fields, the
 * shared value lists — near-miss values are mapped or dropped by the
 * sanitizers in the caller, never a retry.
 */

import type { Usage } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { FACT_TYPES, ORGAN_SYSTEMS, factTypeLabel, organSystemLabel, type GraphNode } from "../../core/contracts.ts";
import { PLACEMENT_ASPECTS, type PlacementTopic } from "../../core/contracts/placement.ts";
import type { PlacerProposal } from "../../core/placement.ts";
import type { PiEngine } from "../models.ts";
import { healStringifiedArrays, runSubmitAgent } from "./submit-agent.ts";

/** How many facts one model call places. */
export const PLACER_BATCH_SIZE = 25;

const placementsSchema = Type.Object({
	placements: Type.Array(
		Type.Object({
			id: Type.String({ description: 'The fact id from the list ("n_…"), verbatim.' }),
			system: Type.String({
				description: "Exactly one organ system: " + ORGAN_SYSTEMS.map((s) => `"${s.id}" (${s.label})`).join(", ") + ".",
			}),
			topicId: Type.Optional(
				Type.String({ description: 'An EXISTING topic\'s id ("t_…") from the topic list, verbatim — use this whenever a listed topic means the same thing.' }),
			),
			newTopic: Type.Optional(
				Type.String({ description: "A new topic's name — only when no listed topic is the same disease or subject. A short textbook heading." }),
			),
			aspect: Type.String({
				description: "Exactly one aspect: " + PLACEMENT_ASPECTS.map((a) => `"${a.id}" (${a.label})`).join(", ") + ".",
			}),
			confidence: Type.Optional(Type.String({ description: '"high" or "low" — "low" when you are guessing.' })),
		}),
		{ description: "One entry per fact. Every fact gets a place — give your best guess, with confidence low, rather than leaving it out." },
	),
});

export const PLACER_INSTRUCTIONS = `You are the placing stage of a medical learning application. You receive facts from a student's knowledge graph —
each a true statement the student has studied — and give each fact ONE place in a textbook-style outline:

  organ system  →  topic (a disease or subject)  →  aspect

- system: the organ system the fact belongs to. If the fact already carries tags, they are hints, not orders. Pharmacology,
  biochemistry, genetics, biostatistics and other principles that are not tied to one organ system are "general".
- topic: the disease or subject the fact is ABOUT, as a textbook chapter would head it ("Small-bowel obstruction", "Acute
  pancreatitis", "Loop diuretics"). Facts about the same disease share ONE topic. You are given the topic list the app already
  holds. REUSE: if a listed topic is the same disease or subject — whatever the spelling or abbreviation ("SBO" is
  "Small-bowel obstruction") — answer with its topicId. Mint a newTopic only when nothing listed is the same thing; then name it
  the way a textbook would, in full words, singular, no abbreviations. Do not make a topic for a single symptom, a lab value or a
  mechanism fragment when the fact belongs to a disease; and do not make near-duplicates of a listed topic.
- aspect: which part of an illness script the fact is: risk-factors (who gets it, causes, predisposing factors), how-it-develops
  (mechanism, pathophysiology, natural history), presentation (symptoms, signs, epidemiology of the picture), workup
  (investigations and how to read them, diagnosis), management (treatment, prevention, drugs), complications (what goes wrong,
  prognosis). A fact that fits none of these — a definition, a general principle — is "other".

Submit ONE submit_placements call with an entry for EVERY fact, using the fact ids verbatim. Never leave a fact out: when unsure,
give your best guess and set confidence to "low". Place from the statement itself; never invent facts.`;

function fillPlacements(raw: Static<typeof placementsSchema>): PlacerProposal[] {
	return raw.placements.map((p) => ({
		nodeId: p.id,
		system: p.system,
		...(p.topicId !== undefined && p.topicId.trim() !== "" ? { topicId: p.topicId.trim() } : {}),
		...(p.newTopic !== undefined && p.newTopic.trim() !== "" ? { newTopic: p.newTopic } : {}),
		aspect: p.aspect,
		...(p.confidence !== undefined ? { confidence: p.confidence.trim().toLowerCase() } : {}),
	}));
}

/** The facts as the model sees them. */
function factLine(n: Pick<GraphNode, "id" | "name" | "statement" | "systems" | "factType">): string {
	const hints = [
		...(n.systems ?? []).map(organSystemLabel),
		...(n.factType ? [factTypeLabel(n.factType)] : []),
	];
	return `${n.id} | ${n.name} | ${n.statement.replace(/\s+/g, " ")}${hints.length > 0 ? ` | tags: ${hints.join(", ")}` : ""}`;
}

/** The canonical topic list as the model sees it, grouped by system. */
export function topicListText(topics: readonly PlacementTopic[]): string {
	if (topics.length === 0) return "(none yet — every topic you use will be new)";
	const lines: string[] = [];
	for (const s of ORGAN_SYSTEMS) {
		const mine = topics.filter((t) => t.system === s.id).sort((a, b) => a.name.localeCompare(b.name));
		if (mine.length === 0) continue;
		lines.push(`[${s.id}]`);
		for (const t of mine) lines.push(`${t.id} | ${t.name}`);
	}
	return lines.join("\n");
}

/** Place ONE batch of facts. Answers for ids outside the batch are dropped. */
export async function runPlacer(opts: {
	engine: PiEngine | undefined;
	nodes: ReadonlyArray<Pick<GraphNode, "id" | "name" | "statement" | "systems" | "factType">>;
	topics: readonly PlacementTopic[];
	signal: AbortSignal | undefined;
	onStep?: (usage: Usage, model: string, step: number, finishReason: string, tools: string) => void;
}): Promise<PlacerProposal[]> {
	const ids = new Set(opts.nodes.map((n) => n.id));
	const proposals = await runSubmitAgent<PlacerProposal[]>({
		role: "placer",
		toolName: "submit_placements",
		toolDescription: "Submit the place (organ system, topic, aspect) of each fact.",
		parameters: placementsSchema,
		fill: fillPlacements,
		systemPrompt: PLACER_INSTRUCTIONS,
		prompt:
			`Topics the app already holds (id | name), by organ system:\n\n${topicListText(opts.topics)}\n\n` +
			`Facts to place (id | name | statement):\n\n${opts.nodes.map(factLine).join("\n")}`,
		engine: opts.engine,
		signal: opts.signal,
		onStep: opts.onStep ?? (() => {}),
		neverSubmitted: "the placer never submitted placements",
		prepareArguments: (args) => healStringifiedArrays(args, ["placements"]),
	});
	return proposals.filter((p) => ids.has(p.nodeId));
}
