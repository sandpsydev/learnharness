/**
 * The illness-script writer end to end with a SCRIPTED engine (no live
 * model): its prompt, its source tools, the check on what it submits, and the
 * illness lister.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import type { LibraryReader } from "../src/agent/library/searcher.ts";
import {
	SUBMIT_SCRIPT_TOOL,
	illnessBatches,
	illnessBatchPrompt,
	illnessListerInstructions,
	listIllnesses,
	mergeIllnesses,
	runScriptwriter,
	scriptwriterInstructions,
	scriptwriterPrompt,
} from "../src/agent/subagents/scriptwriter.ts";
import { expertTools, recordingLibraryReader, scriptGraphTools } from "../src/agent/tools/review-sources.ts";
import type { GraphChain, GraphNode, LibraryBook, VerifyItem } from "../src/core/contracts.ts";
import { SCRIPT_SECTIONS } from "../src/core/contracts.ts";
import { newSeenSources, seenPageKey } from "../src/core/illness-script.ts";
import type { GraphStore } from "../src/core/ports.ts";
import { ROLE_SLOT } from "../src/core/settings.ts";

const node = (id: string, name: string, over: Partial<GraphNode> = {}): GraphNode => ({
	id,
	name,
	statement: `${name} statement.`,
	aliases: [],
	createdAt: "2026-10-01T00:00:00.000Z",
	provenance: [],
	...over,
});
const chain = (id: string, premises: string[], conclusion: string): GraphChain => ({ id, premises, conclusion, provenance: [], createdAt: "2026-10-01T00:00:00.000Z" });

const nodes = [
	node("n_gall", "Gallstones block the pancreatic duct", { systems: ["gi"], factType: "mechanism" }),
	node("n_amy", "Serum amylase rises in acute pancreatitis", { systems: ["gi"], factType: "diagnosis" }),
	node("n_ins", "Insulin binds its receptor", { systems: ["endocrine"] }),
];
const graphStore = {
	readNodes: () => nodes.map((n) => structuredClone(n)),
	readChains: () => [chain("arg_1", ["n_gall"], "n_amy")],
} as unknown as Pick<GraphStore, "readNodes" | "readChains">;

const book = { id: "bk_lec", kind: "slidescribe", title: "Pancreas lecture", status: "ready" } as LibraryBook;
const library: LibraryReader = {
	hasBooks: () => true,
	async search() {
		return { hits: [{ book, chunk: { index: 0, page: 12, text: "Gallstones and alcohol cause most cases." }, score: 1, via: ["keyword" as const] }], notes: [] };
	},
	read: (_b, pages) => ({ ok: true, book, pages: [{ page: Number.parseInt(pages, 10), chunks: [{ index: 0, page: Number.parseInt(pages, 10), text: "Slide text." }] }] }),
};

const answer: VerifyItem = {
	id: "vi_1",
	chatId: "c1",
	prompt: "Initial fluid management in acute pancreatitis",
	status: "answered",
	createdAt: "2026-11-01T00:00:00.000Z",
	updatedAt: "2026-11-02T00:00:00.000Z",
	answer: { text: "Give moderate isotonic crystalloid early. Avoid over-resuscitation.", references: [{ title: "ACG guideline" }], receivedAt: "2026-11-02T09:00:00.000Z" },
};
const verifyStore = { listItems: () => [answer], getItem: (id: string) => (id === answer.id ? answer : null) };

function fauxEngine(steps: FauxResponseStep[]): { engine: PiEngine; calls: () => number } {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, calls: () => faux.state.callCount };
}
const call = (name: string, input: unknown, id = `${name}-1`) =>
	fauxAssistantMessage([fauxToolCall(name, input as ToolCall["arguments"], { id })], { stopReason: "toolUse" });

const goodScript = () => ({
	title: "Acute pancreatitis",
	aliases: ["Pancreatitis, acute"],
	sections: SCRIPT_SECTIONS.map((s) => ({
		id: s.id,
		claims: [
			{
				text: `${s.title}: gallstones obstruct the duct.`,
				graph: ["n_gall"],
				...(s.id === "management" ? { expert: ["vi_1"], library: [{ book: "Pancreas lecture", page: 12 }] } : {}),
			},
		],
		...(s.id === "who" ? { gaps: ["Your sources give no incidence figures."] } : {}),
		...(s.id === "pathophysiology" ? { images: [{ book: "Pancreas lecture", page: 12, caption: "Obstruction" }] } : {}),
	})),
});

describe("the writer's prompt", () => {
	const prompt = scriptwriterInstructions();

	it("states the rules the owner asked for", () => {
		for (const rule of [
			/Every claim names its source/,
			/Never cite from memory and never make up a source/,
			/Gaps are honest/,
			/never fill it from memory/,
			/No mnemonic acronyms/,
			/Only from the learner's own library/,
			/\*Changing\*/,
			/\*Conflict\*/,
		]) {
			assert.match(prompt, rule);
		}
		for (const s of SCRIPT_SECTIONS) assert.ok(prompt.includes(`\`${s.id}\``), s.id);
	});

	it("carries the learner context and the shared accuracy tiers, and keeps the illness lister apart", () => {
		assert.match(prompt, /clinical-year medical student in Thailand/);
		assert.match(prompt, /Medical accuracy — non-negotiable/);
		assert.doesNotMatch(prompt, /Listing the illnesses in a graph/);
		assert.match(illnessListerInstructions(), /submit_illnesses/);
	});

	it("names the illness, the starting nodes, the books and the Expert AI answers in the request", () => {
		const text = scriptwriterPrompt({ illness: "acute pancreatitis", startNodes: [nodes[0]!], libraryTitles: ["Pancreas lecture"] }, 2);
		assert.match(text, /Write the illness script for: acute pancreatitis/);
		assert.match(text, /- n_gall :: Gallstones block the pancreatic duct/);
		assert.match(text, /"Pancreas lecture"/);
		assert.match(text, /collected 2 Expert AI answer/);
		assert.match(scriptwriterPrompt({ illness: "x", libraryTitles: [] }, 0), /library is empty/);
	});

	it("runs on the strong slot", () => {
		assert.equal(ROLE_SLOT.scriptwriter, "strong");
	});
});

describe("the source tools record what they show", () => {
	it("graph tools record every node they return, and neighbours in get_node", async () => {
		const seen = newSeenSources();
		const tools = scriptGraphTools({ graphStore, seen });
		const run = async (name: string, input: unknown) => ((await tools[name]!.execute("t", input as never, undefined as never)).content[0] as { text: string }).text;
		assert.match(await run("find_nodes", { query: "*gallstone*" }), /n_gall :: Gallstones block the pancreatic duct \[GI\/Hepatobiliary \| Mechanism\]/);
		assert.deepEqual([...seen.nodes.keys()], ["n_gall"]);
		assert.match(await run("get_node", { nodeId: "n_amy" }), /Gallstones block the pancreatic duct \(n_gall\) ⟹ Serum amylase/);
		assert.deepEqual([...seen.nodes.keys()].sort(), ["n_amy", "n_gall"]);
		assert.match(await run("find_nodes", { query: "*nothing-like-this*" }), /No node matches/);
	});

	it("the library reader records books and pages from searches and reads", async () => {
		const seen = newSeenSources();
		const reader = recordingLibraryReader(library, seen);
		await reader.search("pancreatitis");
		assert.ok(seen.pages.has(seenPageKey("bk_lec", 12)));
		reader.read("Pancreas lecture", "13");
		assert.ok(seen.pages.has(seenPageKey("bk_lec", 13)));
		assert.deepEqual(seen.pages.get(seenPageKey("bk_lec", 13)), { bookId: "bk_lec", title: "Pancreas lecture", kind: "slidescribe", page: 13 });
	});

	it("expert tools find answers by their words, and record the answer with its date", async () => {
		const seen = newSeenSources();
		const tools = expertTools({ verifyStore, seen });
		const run = async (name: string, input: unknown) => ((await tools[name]!.execute("t", input as never, undefined as never)).content[0] as { text: string }).text;
		assert.match(await run("expert_search", { query: "fluid crystalloid" }), /vi_1 — 2026-11-02/);
		assert.deepEqual(seen.expert.get("vi_1"), { id: "vi_1", date: "2026-11-02", prompt: "Initial fluid management in acute pancreatitis" });
		assert.match(await run("expert_search", { query: "warfarin" }), /No Expert AI answer mentions "warfarin"/);
		const full = await run("expert_read", { id: "vi_1" });
		assert.match(full, /UpToDate Expert AI, 2026-11-02/);
		assert.match(full, /Avoid over-resuscitation/);
		assert.match(full, /ACG guideline/);
		assert.match(await run("expert_read", { id: "vi_nope" }), /No Expert AI answer vi_nope/);
	});
});

describe("writing a script", () => {
	const input = (engine: PiEngine) => ({
		engine,
		graphStore,
		verifyStore,
		library,
		libraryTitles: ["Pancreas lecture"],
		illness: "acute pancreatitis",
		signal: undefined,
	});

	it("gathers first, then submits a script that is checked against what it read", async () => {
		const { engine, calls } = fauxEngine([
			call("find_nodes", { query: "*pancreat*" }),
			call("library_search", { query: "pancreatitis causes" }),
			call("expert_search", { query: "fluid" }),
			call(SUBMIT_SCRIPT_TOOL, goodScript()),
		]);
		const result = await runScriptwriter(input(engine));
		assert.equal(calls(), 4);
		assert.equal(result.draft.title, "Acute pancreatitis");
		assert.equal(result.draft.sections.length, 9);
		assert.deepEqual(result.draft.nodeIds, ["n_gall"]);
		assert.deepEqual(result.draft.pageImages.map((i) => [i.bookId, i.page]), [["bk_lec", 12]]);
		assert.equal(result.usage.calls, 4);
		assert.ok([...result.seen.nodes.keys()].includes("n_amy") || result.seen.nodes.has("n_gall"));
	});

	it("an invented citation comes back with the reasons and the writer fixes it", async () => {
		const bad = goodScript();
		bad.sections[0]!.claims![0] = { text: "Defined.", graph: ["n_imaginary"] } as never;
		bad.sections[6]!.claims![0] = { text: "Use drug X 5 mg.", library: [{ book: "Imaginary textbook", page: 3 }] } as never;
		const { engine, calls } = fauxEngine([
			call("find_nodes", { query: "*gallstone*" }),
			call("library_search", { query: "pancreatitis" }),
			call("expert_search", { query: "fluid" }),
			call(SUBMIT_SCRIPT_TOOL, bad),
			(context) => {
				const last = context.messages[context.messages.length - 1] as { role: string; isError?: boolean; content: Array<{ text?: string }> };
				assert.equal(last.role, "toolResult");
				assert.equal(last.isError, true);
				const text = last.content[0]!.text ?? "";
				assert.match(text, /graph source "n_imaginary" was not returned by any graph tool/);
				assert.match(text, /"Imaginary textbook" page 3 was not shown/);
				return call(SUBMIT_SCRIPT_TOOL, goodScript(), "submit-2");
			},
		]);
		const result = await runScriptwriter(input(engine));
		assert.equal(calls(), 5);
		assert.equal(result.draft.sections[0]!.claims[0]!.sources[0]!.type, "graph");
	});

	it("refuses a citation to a node the writer never looked up", async () => {
		const { engine } = fauxEngine([
			call(SUBMIT_SCRIPT_TOOL, goodScript()),
			(context) => {
				const last = context.messages[context.messages.length - 1] as { content: Array<{ text?: string }> };
				assert.match(last.content[0]!.text ?? "", /graph source "n_gall" was not returned/);
				return fauxAssistantMessage("I can't cite what I have not read.");
			},
		]);
		await assert.rejects(runScriptwriter(input(engine)), /without submitting a script/);
	});

	it("a stringified sections array is healed", async () => {
		const { engine } = fauxEngine([
			call("find_nodes", { query: "*gallstone*" }),
			call("library_search", { query: "pancreatitis" }),
			call("expert_search", { query: "fluid" }),
			call(SUBMIT_SCRIPT_TOOL, { ...goodScript(), sections: JSON.stringify(goodScript().sections) }),
		]);
		const result = await runScriptwriter(input(engine));
		assert.equal(result.draft.sections.length, 9);
	});

	it("has no library tools when the library is empty", async () => {
		const { engine } = fauxEngine([
			call("library_search", { query: "x" }),
			(context) => {
				const last = context.messages[context.messages.length - 1] as { content: Array<{ text?: string }>; isError?: boolean };
				assert.equal(last.isError, true);
				return fauxAssistantMessage("no library");
			},
		]);
		await assert.rejects(runScriptwriter({ ...input(engine), library: { ...library, hasBooks: () => false } }), /without submitting/);
	});
});

describe("listing the illnesses in a graph", () => {
	it("batches nodes by organ system and shows ids, tags and statements", () => {
		const batches = illnessBatches(nodes, 2);
		assert.equal(batches.length, 2);
		assert.deepEqual(batches[0]!.map((n) => n.id).sort(), ["n_amy", "n_gall"], "the two GI nodes share a batch");
		const text = illnessBatchPrompt(batches[0]!);
		assert.match(text, /n_amy :: Serum amylase rises in acute pancreatitis \[GI\/Hepatobiliary \| Diagnosis\/investigation\] — /);
	});

	it("merges batch answers: one entry per illness, real ids only, at least two nodes", () => {
		const ids = new Set(["a", "b", "c", "d"]);
		const merged = mergeIllnesses(
			[
				[{ title: "Acute pancreatitis", aliases: ["AP"], nodeIds: ["a", "b", "ghost"] }, { title: "Lonely fact", aliases: [], nodeIds: ["c"] }],
				[{ title: "acute  Pancreatitis", aliases: ["Pancreatitis, acute"], nodeIds: ["c", "d"] }],
			],
			ids,
		);
		assert.deepEqual(merged, [{ title: "Acute pancreatitis", aliases: ["AP", "Pancreatitis, acute"], nodeIds: ["a", "b", "c", "d"] }]);
	});

	it("asks the model once per batch and returns the merged list", async () => {
		const { engine, calls } = fauxEngine([
			call("submit_illnesses", { illnesses: [{ title: "Acute pancreatitis", aliases: [], nodeIds: ["n_gall", "n_amy", "n_made_up"] }] }),
		]);
		const list = await listIllnesses({ engine, graphStore, signal: undefined });
		assert.equal(calls(), 1);
		assert.deepEqual(list, [{ title: "Acute pancreatitis", aliases: [], nodeIds: ["n_gall", "n_amy"] }]);
	});
});
