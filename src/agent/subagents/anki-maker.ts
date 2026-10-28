/**
 * The Anki card maker (docs/medical-spec.md Phase 5): a single-submit
 * background agent that turns study material (a session's markdown, or the
 * statements + chains of selected graph nodes) into DRAFT flashcards. It
 * never talks to Anki: the learner reviews the draft first, and a separate
 * push (core/anki-connect.ts) delivers what survives.
 *
 * Same seam as the tagger: runSubmitAgent, plain-string schema fields mapped
 * by the shared sanitizers, near-misses repaired rather than retried. The one
 * semantic check (a cloze card must contain a deletion) runs through the
 * submit seam's `validate`, so the model gets a retry for it.
 */

import type { Usage } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import {
	CARD_KINDS,
	CARD_TYPES,
	ORGAN_SYSTEMS,
	cardProblem,
	frontKey,
	sanitizeCard,
	type AnkiCard,
	type OrganSystem,
} from "../../core/contracts.ts";
import type { PiEngine } from "../models.ts";
import { healStringifiedArrays, runSubmitAgent } from "./submit-agent.ts";

/** Material longer than this is split and drafted one slice at a time. */
export const ANKI_CHUNK_CHARS = 30_000;

const cardSchema = Type.Object({
	type: Type.String({
		description: "Card shape, exactly one of: " + CARD_TYPES.map((t) => `"${t.id}" (${t.label})`).join(", ") + ".",
	}),
	kind: Type.String({
		description: "What the card is about, exactly one of: " + CARD_KINDS.map((k) => `"${k.id}" (${k.label})`).join(", ") + ".",
	}),
	system: Type.String({
		description:
			"The ONE organ system whose deck gets the card, exactly one of: " +
			ORGAN_SYSTEMS.map((s) => `"${s.id}" (${s.label})`).join(", ") +
			'. A fact spanning systems goes to its primary one. Pharmacology, biochemistry, genetics and biostatistics use "general".',
	}),
	topic: Type.String({ description: "A short topic label, 1-4 words (e.g. 'renal tubular acidosis'). Becomes a tag." }),
	front: Type.String({
		description:
			"The question, vignette stem, or cloze text. For a cloze card write the cloze deletion in Anki syntax, e.g. " +
			"'{{c1::Type 1}} RTA cannot acidify the urine.'",
	}),
	back: Type.String({
		description:
			"The answer. For a mechanism card, the reasoning chain step by step (one step per line, joined with arrows). " +
			"For a cloze card, an optional one-line extra shown beneath (may be empty).",
	}),
	source: Type.Optional(
		Type.String({
			description:
				"Management cards only: the citation tag taught with the fact (guideline + year, or book + page), " +
				'copied from the material. If the material cites nothing, write "unverified".',
		}),
	),
});

const cardsSchema = Type.Object({
	cards: Type.Array(cardSchema, {
		description: "The draft cards. Quality over quantity; each card tests exactly one fact or one step of reasoning.",
	}),
});

export const ANKI_MAKER_INSTRUCTIONS = `You are the flashcard-drafting stage of a medical learning application. You receive study material the learner has
worked through (a tutoring session, or a set of true statements and reasoning chains from their knowledge graph) and
draft Anki cards for the learner to review. Nothing you draft is sent anywhere until the learner approves it.

CARD TYPES
- cloze: one sentence with the key term hidden, written {{c1::term}}. Best for a single fact (a threshold, a drug, a sign).
- basic: a question on the front, a short answer on the back.
- mechanism: a "why" question on the front; the back is the reasoning chain, one step per line joined with arrows,
  ending at its clinical consequence (the sign, lab finding, imaging finding, drug effect or exam buzzword it produces).
- vignette: a 2-3 line clinical stem on the front (age, sex, key findings), asking for the diagnosis or the next step;
  the back gives the answer and the one-line reason.

CONTENT KINDS (set "kind" on every card): mechanism, ddx (differential / telling look-alikes apart), labs, approach
(how to work a problem up), management (treatment and prevention), memorise (arbitrary facts that can only be learned by
heart: a cutoff, a name, a number — the material marks these [memorise]).

RULES
- Use only what the material says or directly entails. Never invent a fact, a number or a rationale. Do not draft a card
  for something the material leaves uncertain, contradicts, or marks wrong; the learner's own messages may contain
  errors, so prefer what the tutor taught or confirmed.
- Cards stand alone: no "as discussed", no reference to the session.
- One fact per card. Write the front so only one answer fits. No yes/no questions.
- Derivable things get a mechanism card (the why), not a memorised fact. Arbitrary facts get a cloze or basic card.
- MNEMONICS: do not write first-letter acronyms or sentence mnemonics ("I WATCH DEATH" style). A memory hook is allowed
  ONLY to separate a pair of look-alikes (disease A vs B, drug X vs Y), built on the one or two high-yield
  differentiating features, ideally mechanistic. Put it on the back of a ddx card.
- MANAGEMENT cards must carry "source": the citation tag the material gives the fact (guideline + year, or book + page).
  If the material cites nothing for it, set source to "unverified". Never make up a citation.
- Pick "system" for each card from the allowed list; that decides its Anki deck.
- Draft only what is worth remembering; skip pleasantries, scaffolding questions and meta-talk. Zero cards is a valid answer.

Material taken from a library book is split under headers like "--- Book title p.12 ---" (a lecture note: "slide 7"); that
header is the citation for the text beneath it. Use it as a management card's source. A lecture note's own ⚠ marks and
"(AI read — verify)" flags mean the passage is unverified: do not draft a management card from it unless the same fact is
sourced elsewhere.

Submit ONE submit_cards call containing every card.`;

/** Added to the instructions only when the library tools are given. */
export const ANKI_MAKER_LIBRARY_NOTE = `

You also have library_search and library_read over the learner's own books. Use them only to look up a point the
material leaves unclear or to find a citation; stay on the topic of the material you were given.`;

/** A hint the material can carry about where it sits in the graph. */
export interface MakerHints {
	/** The system to fall back to when a card's own is unusable. */
	fallbackSystem?: OrganSystem;
}

function fillCards(raw: Static<typeof cardsSchema>, hints: MakerHints): AnkiCard[] {
	return raw.cards.flatMap((c) => {
		const card = sanitizeCard(c, hints.fallbackSystem ?? "general");
		return card ? [card] : [];
	});
}

/** Split long material on paragraph boundaries into slices of at most `max` characters. */
export function chunkMaterial(text: string, max = ANKI_CHUNK_CHARS): string[] {
	if (text.length <= max) return [text];
	const chunks: string[] = [];
	let current = "";
	for (const paragraph of text.split(/\n{2,}/)) {
		if (paragraph === "") continue;
		// A single paragraph bigger than the budget is cut hard.
		for (let i = 0; i < paragraph.length; i += max) {
			const piece = paragraph.slice(i, i + max);
			if (current !== "" && current.length + piece.length + 2 > max) {
				chunks.push(current);
				current = "";
			}
			current = current === "" ? piece : `${current}\n\n${piece}`;
		}
	}
	if (current !== "") chunks.push(current);
	return chunks;
}

/** Drop later cards whose front repeats an earlier one (case/space-insensitive). */
export function dedupeByFront(cards: readonly AnkiCard[]): AnkiCard[] {
	const seen = new Set<string>();
	return cards.filter((card) => {
		const key = frontKey(card.front);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** Draft cards from ONE slice of material. */
export async function runAnkiMaker(opts: {
	engine: PiEngine | undefined;
	/** What the material is ("Session: Renal tubular acidosis"). */
	title: string;
	material: string;
	hints?: MakerHints;
	/** Extra tools beside the submit call: the seam for library_search / library_read. */
	extraTools?: Record<string, AgentTool<any>>;
	signal: AbortSignal | undefined;
	onStep: (usage: Usage, model: string, step: number, finishReason: string, tools: string) => void;
}): Promise<AnkiCard[]> {
	const hints = opts.hints ?? {};
	return runSubmitAgent<AnkiCard[]>({
		role: "extractor",
		toolName: "submit_cards",
		toolDescription: "Submit the drafted Anki cards.",
		parameters: cardsSchema,
		fill: (input) => fillCards(input as Static<typeof cardsSchema>, hints),
		validate: (cards) => {
			const problems = cards.flatMap((card, i) => {
				const problem = cardProblem(card);
				return problem ? [`Card ${i + 1} (${card.type}): ${problem}`] : [];
			});
			return problems.length > 0 ? problems.join(" ") : null;
		},
		systemPrompt: opts.extraTools ? ANKI_MAKER_INSTRUCTIONS + ANKI_MAKER_LIBRARY_NOTE : ANKI_MAKER_INSTRUCTIONS,
		// Looking things up takes turns; a plain draft needs only the submit and its fixes.
		maxTurns: opts.extraTools ? 12 : undefined,
		prompt: `Material: ${opts.title}\n\n${opts.material}`,
		engine: opts.engine,
		signal: opts.signal,
		onStep: opts.onStep,
		extraTools: opts.extraTools,
		neverSubmitted: "the card maker never submitted cards",
		prepareArguments: (args) => healStringifiedArrays(args, ["cards"]),
	});
}
