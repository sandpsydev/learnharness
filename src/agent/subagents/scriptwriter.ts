/**
 * The illness-script writer (medical fork, Review mode): two jobs on the
 * `scriptwriter` model role, run on the existing pi engine and the ChatGPT
 * sign-in.
 *
 *   runScriptwriter   gathers from the graph, the library and the collected
 *                     Expert AI answers, then submits ONE script. The submit
 *                     is checked against what the run actually read
 *                     (core/illness-script.ts validateDraft) — an unknown
 *                     citation or an unsourced management claim sends the
 *                     writer back to fix it.
 *   listIllnesses     reads the graph in batches and names the illnesses it
 *                     is about, with the nodes that belong to each.
 *
 * Neither writes anything: the caller (server/review.ts) turns the validated
 * draft into images and a stored script.
 */

import fs from "node:fs";
import path from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { PATHS } from "../../../config.ts";
import { ORGAN_SYSTEMS, factTypeLabel, organSystemLabel } from "../../core/contracts/graph.ts";
import { SCRIPT_SECTIONS, type CatalogueIllness } from "../../core/contracts/review.ts";
import type { GraphNode } from "../../core/contracts.ts";
import { getGraph } from "../../core/graph.ts";
import {
	newSeenSources,
	scriptSlug,
	validateDraft,
	type RawScriptDraft,
	type SeenSources,
	type ValidatedDraft,
} from "../../core/illness-script.ts";
import type { GraphStore, VerifyStore } from "../../core/ports.ts";
import { FRAGMENT_RE } from "../../core/prompt-segments.ts";
import type { LibraryReader } from "../library/searcher.ts";
import type { PiEngine } from "../models.ts";
import { expertTools, recordingLibraryReader, scriptGraphTools } from "../tools/review-sources.ts";
import { libraryTools } from "../tools/library.ts";
import { healStringifiedArrays, runSubmitAgent } from "./submit-agent.ts";

const PROMPT_DIR = path.join(PATHS.root, "src", "agent", "prompts", "scriptwriter");
const SHARED_DIR = path.join(PATHS.root, "src", "agent", "prompts", "shared");

/** Turns allowed for one script: a round of searching per section, reading, a submit and a few fixes. */
export const SCRIPTWRITER_MAX_TURNS = 48;
/** Nodes shown to the illness lister per call. */
export const ILLNESS_BATCH = 220;

/** The illness-list fragment is its own prompt; the writer's fragments are the rest. */
const LISTER_FRAGMENT = "40-illnesses.md";

function fragments(): string[] {
	return fs
		.readdirSync(PROMPT_DIR)
		.filter((f) => FRAGMENT_RE.test(f) && f !== LISTER_FRAGMENT)
		.sort()
		.map((f) => fs.readFileSync(path.join(PROMPT_DIR, f), "utf-8").trim());
}

/** The illness lister's system prompt. */
export function illnessListerInstructions(): string {
	return [fs.readFileSync(path.join(PROMPT_DIR, LISTER_FRAGMENT), "utf-8").trim(), shared("12-learner.md")].join("\n\n---\n\n");
}

const shared = (file: string): string => fs.readFileSync(path.join(SHARED_DIR, file), "utf-8").trim();

/** The writer's system prompt: its own fragments, the learner context and the accuracy tiers. */
export function scriptwriterInstructions(): string {
	return [...fragments(), shared("12-learner.md"), shared("15-accuracy.md")].join("\n\n---\n\n");
}

// ─── the script ──────────────────────────────────────────────────────────────

const claimSchema = Type.Object({
	text: Type.String({ minLength: 1, description: "One idea in one to three sentences." }),
	bullet: Type.Optional(Type.Boolean({ description: "True to show this claim as a list item." })),
	changing: Type.Optional(Type.Boolean({ description: "True for the changing tier: management, drugs, doses, thresholds, schedules." })),
	general: Type.Optional(Type.Boolean({ description: "True for settled science stated from general knowledge, with no source. Not allowed for changing-tier claims." })),
	graph: Type.Optional(Type.Array(Type.String(), { description: "Node ids (n_…) from find_nodes / get_node that this claim rests on." })),
	library: Type.Optional(
		Type.Array(Type.Object({ book: Type.String(), page: Type.Integer({ minimum: 0 }) }), {
			description: "Library passages, book title and page exactly as library_search / library_read printed them.",
		}),
	),
	expert: Type.Optional(Type.Array(Type.String(), { description: "Expert AI answer ids from expert_search / expert_read." })),
});

const sectionSchema = Type.Object({
	id: Type.String({ description: "One of: " + SCRIPT_SECTIONS.map((s) => s.id).join(", ") + "." }),
	claims: Type.Optional(Type.Array(claimSchema)),
	gaps: Type.Optional(Type.Array(Type.String(), { description: "What the learner's sources do not cover for this section." })),
	images: Type.Optional(
		Type.Array(Type.Object({ book: Type.String(), page: Type.Integer({ minimum: 1 }), caption: Type.String() }), {
			description: "Pages of the learner's library to show, only pages you read.",
		}),
	),
	diagrams: Type.Optional(
		Type.Array(Type.Object({ brief: Type.String(), caption: Type.String() }), { description: "At most two for the whole script." }),
	),
});

const scriptSchema = Type.Object({
	title: Type.String({ minLength: 1, description: "The illness, in its usual name." }),
	aliases: Type.Optional(Type.Array(Type.String())),
	sections: Type.Array(sectionSchema, { description: "All nine sections." }),
});

export const SUBMIT_SCRIPT_TOOL = "submit_script";

export interface ScriptwriterResult {
	draft: ValidatedDraft;
	seen: SeenSources;
	usage: { calls: number; inputTokens: number; outputTokens: number };
}

export interface ScriptwriterInput {
	engine: PiEngine | undefined;
	graphStore: Pick<GraphStore, "readNodes" | "readChains">;
	verifyStore: Pick<VerifyStore, "listItems" | "getItem">;
	library: LibraryReader | undefined;
	/** Titles of the books the library holds, to point the writer at them. */
	libraryTitles: readonly string[];
	/** The illness as the learner named it. */
	illness: string;
	/** Graph nodes already known to belong to it (from the illness list). */
	startNodes?: readonly GraphNode[];
	signal: AbortSignal | undefined;
	onStep?: (usage: Usage, model: string, step: number) => void;
}

export function scriptwriterPrompt(input: Pick<ScriptwriterInput, "illness" | "startNodes" | "libraryTitles">, expertCount: number): string {
	const lines = [`Write the illness script for: ${input.illness}`];
	if (input.startNodes && input.startNodes.length > 0) {
		lines.push("", "Graph notes already known to be about it (look for more as well):", ...input.startNodes.slice(0, 80).map((n) => `- ${n.id} :: ${n.name}`));
	}
	lines.push(
		"",
		input.libraryTitles.length > 0
			? `The learner's library holds ${input.libraryTitles.length} book(s): ${input.libraryTitles.slice(0, 30).map((t) => `"${t}"`).join(", ")}.`
			: "The learner's library is empty: write from the graph and the Expert AI answers, and note the gaps.",
		expertCount > 0 ? `The learner has collected ${expertCount} Expert AI answer(s).` : "The learner has no Expert AI answers yet: management will rest on the library and graph, and unsourced management belongs in gaps.",
	);
	return lines.join("\n");
}

export async function runScriptwriter(input: ScriptwriterInput): Promise<ScriptwriterResult> {
	const seen = newSeenSources();
	const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
	const answered = input.verifyStore.listItems({ status: ["answered"] }).filter((i) => i.answer);
	const extraTools = {
		...scriptGraphTools({ graphStore: input.graphStore, seen }),
		...(input.library && input.library.hasBooks() ? libraryTools({ reader: recordingLibraryReader(input.library, seen) }) : {}),
		...expertTools({ verifyStore: input.verifyStore, seen }),
	};
	let validated: ValidatedDraft | undefined;
	await runSubmitAgent<RawScriptDraft>({
		role: "scriptwriter",
		toolName: SUBMIT_SCRIPT_TOOL,
		toolDescription:
			"Submit the finished illness script: all nine sections, every claim with the sources you read. The script is checked against what you were shown; if anything is refused you get the reasons and must fix and submit again.",
		parameters: scriptSchema,
		fill: (raw) => raw as RawScriptDraft,
		systemPrompt: scriptwriterInstructions(),
		prompt: scriptwriterPrompt(input, answered.length),
		engine: input.engine,
		signal: input.signal,
		extraTools,
		maxTurns: SCRIPTWRITER_MAX_TURNS,
		prepareArguments: (args) => healStringifiedArrays(args, ["sections", "aliases"]),
		validate: (value) => {
			const result = validateDraft(value, seen);
			if (!result.ok) return result.problems.map((p, i) => `${i + 1}. ${p}`).join("\n");
			validated = result.draft;
			return null;
		},
		onStep: (u, model, step) => {
			usage.calls++;
			usage.inputTokens += u.input;
			usage.outputTokens += u.output;
			input.onStep?.(u, model, step);
		},
		neverSubmitted: "The script writer finished without submitting a script.",
	});
	if (!validated) throw new Error("The script writer finished without submitting a script.");
	return { draft: validated, seen, usage };
}

// ─── the illness list ────────────────────────────────────────────────────────

const illnessSchema = Type.Object({
	illnesses: Type.Array(
		Type.Object({
			title: Type.String({ minLength: 1, description: "The illness's usual name." }),
			aliases: Type.Optional(Type.Array(Type.String(), { description: "Other names the nodes use for it." })),
			nodeIds: Type.Array(Type.String(), { description: "Ids of the nodes in this batch that are specifically about it." }),
		}),
	),
});

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export function illnessBatchPrompt(nodes: readonly GraphNode[]): string {
	const tags = (n: GraphNode): string => {
		const t = [...(n.systems ?? []).map(organSystemLabel), ...(n.factType ? [factTypeLabel(n.factType)] : [])];
		return t.length > 0 ? ` [${t.join(" | ")}]` : "";
	};
	return [
		"List the illnesses these graph nodes are about. Call submit_illnesses once.",
		"",
		...nodes.map((n) => `${n.id} :: ${n.name}${tags(n)} — ${clip(n.statement.replace(/\s+/g, " "), 170)}`),
	].join("\n");
}

/** Nodes in batches, grouped by organ system so one illness's nodes tend to share a batch. */
export function illnessBatches(nodes: readonly GraphNode[], size = ILLNESS_BATCH): GraphNode[][] {
	const order = new Map(ORGAN_SYSTEMS.map((s, i) => [s.id as string, i]));
	const key = (n: GraphNode): number => order.get(n.systems?.[0] ?? "") ?? ORGAN_SYSTEMS.length;
	const sorted = [...nodes].sort((a, b) => key(a) - key(b) || a.name.localeCompare(b.name));
	const out: GraphNode[][] = [];
	for (let i = 0; i < sorted.length; i += size) out.push(sorted.slice(i, i + size));
	return out;
}

/** Merge batch answers: one entry per illness, ids that exist, at least two nodes. */
export function mergeIllnesses(batches: ReadonlyArray<ReadonlyArray<CatalogueIllness>>, nodeIds: ReadonlySet<string>): CatalogueIllness[] {
	const bySlug = new Map<string, CatalogueIllness>();
	for (const batch of batches) {
		for (const ill of batch) {
			const title = ill.title.replace(/\s+/g, " ").trim();
			const slug = scriptSlug(title);
			if (slug === "") continue;
			const ids = ill.nodeIds.filter((id) => nodeIds.has(id));
			const existing = bySlug.get(slug);
			if (existing) {
				existing.nodeIds = [...new Set([...existing.nodeIds, ...ids])];
				existing.aliases = [...new Set([...existing.aliases, ...ill.aliases])];
			} else {
				bySlug.set(slug, { title, aliases: [...new Set(ill.aliases.map((a) => a.replace(/\s+/g, " ").trim()).filter((a) => a !== "" && a.toLowerCase() !== title.toLowerCase()))], nodeIds: [...new Set(ids)] });
			}
		}
	}
	return [...bySlug.values()].filter((i) => i.nodeIds.length >= 2).sort((a, b) => a.title.localeCompare(b.title));
}

export async function listIllnesses(input: {
	engine: PiEngine | undefined;
	graphStore: Pick<GraphStore, "readNodes" | "readChains">;
	signal: AbortSignal | undefined;
	onStep?: (usage: Usage, model: string, step: number) => void;
	onBatch?: (done: number, total: number) => void;
}): Promise<CatalogueIllness[]> {
	const nodes = getGraph(input.graphStore).nodes;
	const batches = illnessBatches(nodes);
	const ids = new Set(nodes.map((n) => n.id));
	const found: CatalogueIllness[][] = [];
	let done = 0;
	for (const batch of batches) {
		const answer = await runSubmitAgent<{ illnesses: CatalogueIllness[] }>({
			role: "scriptwriter",
			toolName: "submit_illnesses",
			toolDescription: "Submit the illnesses these nodes are about, each with the ids of the nodes that belong to it.",
			parameters: illnessSchema,
			fill: (raw) => ({
				illnesses: ((raw as { illnesses?: Array<{ title: string; aliases?: string[]; nodeIds: string[] }> }).illnesses ?? []).map((i) => ({
					title: i.title,
					aliases: i.aliases ?? [],
					nodeIds: i.nodeIds,
				})),
			}),
			systemPrompt: illnessListerInstructions(),
			prompt: illnessBatchPrompt(batch),
			engine: input.engine,
			signal: input.signal,
			maxTurns: 4,
			prepareArguments: (args) => healStringifiedArrays(args, ["illnesses"]),
			onStep: (u, model, step) => input.onStep?.(u, model, step),
			neverSubmitted: "The illness lister finished without an answer.",
		});
		found.push(answer.illnesses);
		input.onBatch?.(++done, batches.length);
	}
	return mergeIllnesses(found, ids);
}
