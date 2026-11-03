/**
 * The knowledge-organizer agent (medical fork, docs/medical-spec.md
 * "Knowledge organizer"): the learner talks to it from the graph page and it
 * turns what they say into a PROPOSED set of graph changes. It runs as the
 * `organizer` model role on the same engine and sign-in as every other role.
 *
 * It is a small pi agent loop with read tools and one propose_changes tool
 * (agent/tools/graph-organizer.ts). It never writes the graph — a valid
 * proposal is captured and handed back to the caller, which stores it until
 * the learner accepts (server/graph-organizer.ts).
 *
 * The page keeps the conversation; each call receives the turns so far as
 * plain text and starts a fresh agent run, so nothing but the proposal and
 * the reply survives a call.
 */

import fs from "node:fs";
import path from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { PATHS } from "../../../config.ts";
import { FACT_TYPES, ORGAN_SYSTEMS } from "../../core/contracts/graph.ts";
import type { OrganizerChangePreview, OrganizerMessage, RawOrganizerChange } from "../../core/organizer-types.ts";
import type { GraphStore } from "../../core/ports.ts";
import { FRAGMENT_RE } from "../../core/prompt-segments.ts";
import type { PiEngine } from "../models.ts";
import { organizerTools } from "../tools/graph-organizer.ts";
import { healToolRecord } from "../tools/heal.ts";
import { runSubagent } from "./pi-run.ts";

const ORGANIZER_PROMPT_DIR = path.join(PATHS.root, "src", "agent", "prompts", "organizer");

/** Turns allowed per call: a handful of lookups, a proposal, a retry or two, a reply. */
export const ORGANIZER_MAX_TURNS = 14;

/** The tag vocabulary, from the one list the whole app reads. */
function vocabularySection(): string {
	return [
		"# Tag vocabulary",
		"",
		"Organ systems (use the id): " + ORGAN_SYSTEMS.map((s) => `\`${s.id}\` (${s.label})`).join(", ") + ".",
		"",
		"Fact types (use the id; a node has exactly one): " + FACT_TYPES.map((t) => `\`${t.id}\` (${t.label})`).join(", ") + ".",
	].join("\n");
}

/** The organizer's system prompt: its fragments in filename order, then the vocabulary. */
export function organizerInstructions(): string {
	const fragments = fs
		.readdirSync(ORGANIZER_PROMPT_DIR)
		.filter((f) => FRAGMENT_RE.test(f))
		.sort()
		.map((f) => fs.readFileSync(path.join(ORGANIZER_PROMPT_DIR, f), "utf-8").trim());
	return [...fragments, vocabularySection()].join("\n\n---\n\n");
}

/** The conversation as one prompt: earlier turns, then the learner's latest message. */
export function organizerPrompt(messages: readonly OrganizerMessage[]): string {
	const latest = messages[messages.length - 1];
	if (!latest || latest.role !== "user") throw new Error("The organizer needs the learner's message last.");
	if (messages.length === 1) return latest.text;
	const earlier = messages
		.slice(0, -1)
		.map((m) => `${m.role === "user" ? "Learner" : "Organizer"}: ${m.text}`)
		.join("\n\n");
	return `Conversation so far:\n\n${earlier}\n\nThe learner now says:\n\n${latest.text}`;
}

export interface OrganizerRunResult {
	/** What to show the learner: the agent's closing words. */
	reply: string;
	/** The last VALID proposal the agent made this call, if any. */
	proposal?: { summary: string; changes: RawOrganizerChange[]; previews: OrganizerChangePreview[] };
}

export async function runOrganizer(opts: {
	engine: PiEngine | undefined;
	graphStore: GraphStore;
	messages: readonly OrganizerMessage[];
	signal: AbortSignal | undefined;
	onStep?: (usage: Usage, model: string, step: number) => void;
}): Promise<OrganizerRunResult> {
	let proposal: OrganizerRunResult["proposal"];
	const tools = healToolRecord(
		organizerTools({
			graphStore: opts.graphStore,
			onProposal: (p) => {
				proposal = p;
			},
		}),
	);
	const result = await runSubagent(Object.values(tools), {
		role: "organizer",
		engine: opts.engine,
		systemPrompt: organizerInstructions(),
		prompt: organizerPrompt(opts.messages),
		maxTurns: ORGANIZER_MAX_TURNS,
		abortSignal: opts.signal,
		onAssistantMessage: (message, step) =>
			opts.onStep?.(message.usage, `${message.provider}:${message.model}`, step),
	});
	const reply = result.text.trim() || (proposal ? proposal.summary : "I couldn't work out what to change — could you say it another way?");
	return { reply, ...(proposal ? { proposal } : {}) };
}
