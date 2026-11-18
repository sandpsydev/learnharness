/**
 * The session-recap writer (medical fork, Session recap): one call on the
 * `recapWriter` model role, run on the existing pi engine and the ChatGPT
 * sign-in. It has no tools but the submit: the whole session is in its prompt
 * (core/session-recap.ts assembleTranscript), and the submit is checked against
 * that session (validateRecap) — a turn, table or figure the session never had
 * sends the writer back to fix it.
 *
 * It writes nothing: the caller (server/recap.ts) turns the validated draft
 * into a stored recap.
 */

import fs from "node:fs";
import path from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { PATHS } from "../../../config.ts";
import {
	validateRecap,
	type AssembledTranscript,
	type RawRecapDraft,
	type ValidatedRecap,
} from "../../core/session-recap.ts";
import { FRAGMENT_RE } from "../../core/prompt-segments.ts";
import type { PiEngine } from "../models.ts";
import { healStringifiedArrays, runSubmitAgent } from "./submit-agent.ts";

const PROMPT_DIR = path.join(PATHS.root, "src", "agent", "prompts", "recap");
const SHARED_DIR = path.join(PATHS.root, "src", "agent", "prompts", "shared");

/** The writer gets a few turns to fix a draft the check refused; nothing else needs a second one. */
export const RECAP_WRITER_MAX_TURNS = 6;

export const SUBMIT_RECAP_TOOL = "submit_recap";

/** The writer's system prompt: its own fragments, then who the learner is. */
export function recapWriterInstructions(): string {
	const own = fs
		.readdirSync(PROMPT_DIR)
		.filter((f) => FRAGMENT_RE.test(f))
		.sort()
		.map((f) => fs.readFileSync(path.join(PROMPT_DIR, f), "utf-8").trim());
	return [...own, fs.readFileSync(path.join(SHARED_DIR, "12-learner.md"), "utf-8").trim()].join("\n\n---\n\n");
}

const turnsSchema = Type.Array(Type.Integer({ minimum: 1 }), { description: "The turn numbers ([T4] → 4) this comes from." });

const recapSchema = Type.Object({
	summary: Type.String({ minLength: 1, description: "Two to five sentences: what the session covered." }),
	fitsTogether: Type.Optional(
		Type.Object(
			{ text: Type.String({ minLength: 1, description: "A short paragraph on how the session's topics connect, using only links the session stated." }), turns: turnsSchema },
			{ description: "How it fits together. Leave out when the session stated no links." },
		),
	),
	highYield: Type.Optional(
		Type.Array(Type.Object({ text: Type.String({ minLength: 1, description: "One must-remember fact, one or two sentences." }), turns: turnsSchema }), { description: "High-yield to remember." }),
	),
	understandFirst: Type.Optional(
		Type.Array(Type.Object({ text: Type.String({ minLength: 1, description: "One concept to understand before moving on, one or two sentences." }), turns: turnsSchema }), { description: "Understand before continuing." }),
	),
	topics: Type.Array(
		Type.Object({
			title: Type.String({ minLength: 1 }),
			points: Type.Array(Type.Object({ text: Type.String({ minLength: 1, description: "One idea, one or two sentences." }), turns: turnsSchema })),
			tables: Type.Optional(Type.Array(Type.String(), { description: "Table ids from the transcript (K1…), copied into the note as they are." })),
			pictures: Type.Optional(
				Type.Array(
					Type.Object({
						concept: Type.String({ minLength: 1, description: "What the picture must show, as the session described it." }),
						modality: Type.Optional(Type.String({ description: "Kind of picture: anatomy drawing, CT, stone photograph, histology…" })),
						caption: Type.String({ minLength: 1, description: "One plain sentence: what the picture shows, using only what the session said." }),
						diagram: Type.Optional(Type.String({ description: "A brief for a simple labelled drawing, only if no real picture could be found; only labels and links the session stated." })),
						turns: turnsSchema,
					}),
					{ description: "New pictures to look for: only for a visual point the session taught without a picture." },
				),
			),
			figures: Type.Optional(
				Type.Array(
					Type.Union([
						Type.String(),
						Type.Object({ id: Type.String(), caption: Type.Optional(Type.String({ description: "Only for a diagram the app drew." })) }),
					]),
					{ description: "Figure ids from the transcript (F1…)." },
				),
			),
		}),
	),
	misses: Type.Optional(
		Type.Array(
			Type.Object({
				question: Type.String(),
				yours: Type.String({ description: "What the learner answered, or that they did not know." }),
				correct: Type.String({ description: "The right answer as the session gave it." }),
				turns: turnsSchema,
			}),
		),
	),
	selfTest: Type.Optional(
		Type.Array(Type.Object({ question: Type.String(), answer: Type.String(), turns: turnsSchema })),
	),
});

export interface RecapWriterInput {
	engine: PiEngine | undefined;
	title: string;
	transcript: AssembledTranscript;
	signal: AbortSignal | undefined;
	onStep?: (usage: Usage, model: string, step: number) => void;
}

export interface RecapWriterResult {
	draft: ValidatedRecap;
	usage: { calls: number; inputTokens: number; outputTokens: number };
}

export function recapWriterPrompt(input: Pick<RecapWriterInput, "title" | "transcript">): string {
	const { transcript } = input;
	const tables = transcript.tables.size > 0 ? `Tables shown: ${[...transcript.tables.keys()].join(", ")}.` : "No tables were shown.";
	const figures = transcript.figures.size > 0 ? `Figures shown: ${[...transcript.figures.keys()].join(", ")}.` : "No figures were shown.";
	return [
		`Write the recap of this teaching session: "${input.title}". It has ${transcript.turns} turns. ${tables} ${figures}`,
		"",
		"=== SESSION TRANSCRIPT (your only source) ===",
		transcript.text,
		"=== END OF TRANSCRIPT ===",
	].join("\n");
}

export async function runRecapWriter(input: RecapWriterInput): Promise<RecapWriterResult> {
	const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
	let validated: ValidatedRecap | undefined;
	await runSubmitAgent<RawRecapDraft>({
		role: "recapWriter",
		toolName: SUBMIT_RECAP_TOOL,
		toolDescription:
			"Submit the finished recap: the summary, how it fits together, the high-yield and understand-first lists, the topics with their points (each naming its turns), the misses and the self-test. It is checked against the session; if anything is refused you get the reasons and must fix and submit again.",
		parameters: recapSchema,
		fill: (raw) => raw as RawRecapDraft,
		systemPrompt: recapWriterInstructions(),
		prompt: recapWriterPrompt(input),
		engine: input.engine,
		signal: input.signal,
		maxTurns: RECAP_WRITER_MAX_TURNS,
		prepareArguments: (args) => healStringifiedArrays(args, ["topics", "misses", "selfTest", "highYield", "understandFirst"]),
		validate: (value) => {
			const result = validateRecap(value, input.transcript);
			if (!result.ok) return result.problems.map((p, i) => `${i + 1}. ${p}`).join("\n");
			validated = result.recap;
			return null;
		},
		onStep: (u, model, step) => {
			usage.calls++;
			usage.inputTokens += u.input;
			usage.outputTokens += u.output;
			input.onStep?.(u, model, step);
		},
		neverSubmitted: "The recap writer finished without submitting a recap.",
	});
	if (!validated) throw new Error("The recap writer finished without submitting a recap.");
	return { draft: validated, usage };
}
