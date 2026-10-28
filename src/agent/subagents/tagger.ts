/**
 * The tagger — the one-off "tag existing nodes" back-fill (docs/medical-spec.md
 * Phase 4). Nodes stored before the medical fork carry no organ system or fact
 * type; this single-submit agent reads a batch of them (name + statement
 * only) and proposes both tags. It never sees a source and never touches the
 * ledgers itself: the caller writes the proposals through core/graph.ts
 * fillNodeTags, which only FILLS missing tags (first assignment sticks).
 *
 * Same seam as the extractor: runSubmitAgent, plain-string schema fields, and
 * the shared value lists from contracts/graph.ts — near-miss values are mapped
 * or dropped by the sanitizers, never a retry.
 */

import type { Usage } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import {
	FACT_TYPES,
	ORGAN_SYSTEMS,
	sanitizeFactType,
	sanitizeSystems,
	type FactType,
	type GraphNode,
	type OrganSystem,
} from "../../core/contracts.ts";
import type { PiEngine } from "../models.ts";
import { healStringifiedArrays, runSubmitAgent } from "./submit-agent.ts";

/** How many nodes one model call tags. */
export const TAG_BATCH_SIZE = 40;

const tagsSchema = Type.Object({
	tags: Type.Array(
		Type.Object({
			id: Type.String({ description: 'The node id from the list ("n_…"), verbatim.' }),
			systems: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"One or more organ systems: " + ORGAN_SYSTEMS.map((s) => `"${s.id}" (${s.label})`).join(", ") + ".",
				}),
			),
			factType: Type.Optional(
				Type.String({
					description: "Exactly one fact type: " + FACT_TYPES.map((t) => `"${t.id}" (${t.label})`).join(", ") + ".",
				}),
			),
		}),
		{ description: "One entry per node you can tag. Skip a node that is not medical material." },
	),
});

export interface TagProposal {
	id: string;
	systems: OrganSystem[];
	factType?: FactType;
}

export const TAGGER_INSTRUCTIONS = `You are the tagging stage of a medical learning application. You receive a list of knowledge-graph nodes, each a
true statement the learner has studied. Tag every node with:
- systems: the organ system(s) it belongs to (one or more). A fact that spans systems carries several
  (diabetic nephropathy → endocrine + renal). Pharmacology, biochemistry, genetics and biostatistics principles
  that are not tied to one organ system are "general".
- factType: exactly one of mechanism (why something happens), clinical-feature (symptoms, signs, epidemiology,
  natural history), diagnosis (investigations and how to interpret them), management (treatment and
  prevention), memorise (an arbitrary fact that can only be learned by heart — a cutoff, a name, a number).

Submit ONE submit_tags call with an entry per node, using the node ids verbatim. If a node is not medical material at
all, leave it out. Tag from the statement itself; never invent facts.`;

function fillTags(raw: Static<typeof tagsSchema>): TagProposal[] {
	return raw.tags.map((t) => {
		const factType = sanitizeFactType(t.factType);
		return { id: t.id, systems: sanitizeSystems(t.systems), ...(factType !== undefined ? { factType } : {}) };
	});
}

/** Tag ONE batch of nodes. Proposals for ids outside the batch are dropped. */
export async function runTagger(opts: {
	engine: PiEngine | undefined;
	nodes: ReadonlyArray<Pick<GraphNode, "id" | "name" | "statement">>;
	signal: AbortSignal | undefined;
	onStep: (usage: Usage, model: string, step: number, finishReason: string, tools: string) => void;
}): Promise<TagProposal[]> {
	const ids = new Set(opts.nodes.map((n) => n.id));
	const lines = opts.nodes.map((n) => `${n.id} | ${n.name} | ${n.statement.replace(/\s+/g, " ")}`);
	const proposals = await runSubmitAgent<TagProposal[]>({
		role: "extractor",
		toolName: "submit_tags",
		toolDescription: "Submit the organ system(s) and fact type for the nodes.",
		parameters: tagsSchema,
		fill: fillTags,
		systemPrompt: TAGGER_INSTRUCTIONS,
		prompt: `Nodes to tag (id | name | statement):\n\n${lines.join("\n")}`,
		engine: opts.engine,
		signal: opts.signal,
		onStep: opts.onStep,
		neverSubmitted: "the tagger never submitted tags",
		prepareArguments: (args) => healStringifiedArrays(args, ["tags"]),
	});
	return proposals.filter((p) => ids.has(p.id));
}
