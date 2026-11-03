/**
 * The organizer agent end to end with a SCRIPTED engine (no live model): its
 * prompt, its tools, what a proposal does and does not do, and how a refused
 * proposal is retried. Plus the server service (apply / undo / gates).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { organizerInstructions, organizerPrompt, runOrganizer } from "../src/agent/subagents/organizer.ts";
import { organizerTools, PROPOSE_CHANGES_TOOL } from "../src/agent/tools/graph-organizer.ts";
import type { GraphChain, GraphNode } from "../src/core/contracts.ts";
import { getGraph } from "../src/core/graph.ts";
import type { OrganizerHistoryStore } from "../src/core/graph-organizer.ts";
import type { OrganizerHistoryEntry } from "../src/core/organizer-types.ts";
import type { GraphStore } from "../src/core/ports.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError, ROLE_SLOT } from "../src/core/settings.ts";
import { createGraphOrganizer, parseOrganizerMessages } from "../src/server/graph-organizer.ts";

const node = (id: string, name: string, over: Partial<GraphNode> = {}): GraphNode => ({
	id,
	name,
	statement: `${name} statement.`,
	aliases: [],
	createdAt: "2026-10-01T00:00:00.000Z",
	provenance: [{ chatId: "chat1", messageId: "m1" }],
	...over,
});
const chain = (id: string, premises: string[], conclusion: string): GraphChain => ({
	id,
	premises,
	conclusion,
	provenance: [],
	createdAt: "2026-10-01T00:00:00.000Z",
});

function memory() {
	const state = {
		nodes: [node("n_a", "Low GFR", { systems: ["renal"] }), node("n_b", "Retained urea"), node("n_c", "Uraemia")],
		chains: [chain("arg_1", ["n_a"], "n_b")],
	};
	const store = {
		readNodes: () => state.nodes.map((n) => structuredClone(n)),
		readChains: () => state.chains.map((c) => structuredClone(c)),
		rewriteLedgers: (next: { nodes?: GraphNode[]; chains?: GraphChain[] }) => {
			if (next.nodes) state.nodes = next.nodes;
			if (next.chains) state.chains = next.chains;
		},
		readPositions: () => ({}),
		writePositions: () => {},
	} as unknown as GraphStore;
	let entries: OrganizerHistoryEntry[] = [];
	const history: OrganizerHistoryStore = { read: () => entries, write: (e) => void (entries = e) };
	return { state, store, history };
}

function fauxEngine(steps: FauxResponseStep[]): { engine: PiEngine; calls: () => number } {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, calls: () => faux.state.callCount };
}
const call = (name: string, input: unknown) =>
	fauxAssistantMessage([fauxToolCall(name, input as ToolCall["arguments"], { id: `${name}-1` })], { stopReason: "toolUse" });

describe("the organizer's prompt", () => {
	const prompt = organizerInstructions();

	it("carries the whole tag vocabulary, from the one shared list", () => {
		for (const id of ["cardiovascular", "gi", "haem-onc", "id-immunology", "general", "mechanism", "clinical-feature", "diagnosis", "management", "memorise"]) {
			assert.ok(prompt.includes(`\`${id}\``), id);
		}
	});

	it("states the rules the owner asked for", () => {
		for (const rule of [
			/never add a medical fact/i,
			/cannot delete or merge nodes/i,
			/never invent|never coin a near-duplicate/i,
			/learner's (own )?wording/i,
			/ONE short question/,
			/never say a change is done/i,
		]) {
			assert.match(prompt, rule);
		}
	});

	it("names exactly the tools it has and no delete or merge", () => {
		const names = Object.keys(organizerTools({ graphStore: memory().store, onProposal: () => {} }));
		assert.deepEqual(names, ["graph_overview", "find_nodes", "list_nodes", "get_node", PROPOSE_CHANGES_TOOL]);
		assert.ok(!names.some((n) => /delete|merge|remove_node/.test(n)));
		for (const op of ["create_node", "rename_node", "edit_node", "set_tags", "add_connection", "remove_connection", "change_connection"]) {
			assert.ok(prompt.includes(`\`${op}\``), op);
		}
	});

	it("puts earlier turns before the learner's latest message", () => {
		assert.equal(organizerPrompt([{ role: "user", text: "hi" }]), "hi");
		const text = organizerPrompt([
			{ role: "user", text: "rename it" },
			{ role: "assistant", text: "Which node?" },
			{ role: "user", text: "Uraemia" },
		]);
		assert.match(text, /Learner: rename it\n\nOrganizer: Which node\?/);
		assert.ok(text.endsWith("Uraemia"));
		assert.throws(() => organizerPrompt([{ role: "assistant", text: "x" }]));
	});
});

describe("the read tools", () => {
	const m = memory();
	const tools = organizerTools({ graphStore: m.store, onProposal: () => {} });
	const run = async (name: string, input: unknown) => {
		const result = await tools[name]!.execute("t1", input as never, undefined as never);
		return (result.content[0] as { text: string }).text;
	};

	it("finds nodes by glob and shows tags and ids", async () => {
		const text = await run("find_nodes", { query: "*gfr*" });
		assert.match(text, /n_a :: Low GFR \[Renal\/Urinary \| no fact type\]/);
		assert.match(await run("find_nodes", { query: "zzz" }), /No node matches/);
	});

	it("lists with filters and says when a filter is not in the vocabulary", async () => {
		assert.match(await run("list_nodes", { system: "renal" }), /1 of 1/);
		assert.match(await run("list_nodes", { untagged: true }), /Nodes 1–3 of 3|Nodes 1–2 of 2/);
		assert.match(await run("list_nodes", { system: "cardiology" }), /Unknown organ system/);
	});

	it("get_node shows the node's connections with their ids", async () => {
		const text = await run("get_node", { nodeId: "n_b" });
		assert.match(text, /arg_1: Low GFR \(n_a\) ⟹ Retained urea \(n_b\)/);
		assert.match(await run("get_node", { nodeId: "n_nope" }), /No node n_nope/);
	});
});

describe("runOrganizer with a scripted model", () => {
	it("a question stays a question: no proposal, graph untouched", async () => {
		const m = memory();
		const { engine } = fauxEngine([fauxAssistantMessage("Which node do you mean: Low GFR or Uraemia?")]);
		const result = await runOrganizer({ engine, graphStore: m.store, messages: [{ role: "user", text: "rename the kidney one" }], signal: undefined });
		assert.equal(result.proposal, undefined);
		assert.match(result.reply, /Which node/);
	});

	it("looks things up, then proposes; the proposal is NOT applied", async () => {
		const m = memory();
		const before = JSON.stringify(m.state);
		const { engine } = fauxEngine([
			call("find_nodes", { query: "*uraemia*" }),
			call(PROPOSE_CHANGES_TOOL, {
				summary: "Rename Uraemia and tag it",
				changes: [
					{ op: "rename_node", nodeId: "n_c", name: "Uraemic syndrome" },
					{ op: "set_tags", nodeId: "n_c", systems: ["renal"], factType: "clinical-feature" },
				],
			}),
			fauxAssistantMessage("I propose renaming Uraemia and tagging it Renal, Clinical feature. Accept or reject below."),
		]);
		const result = await runOrganizer({ engine, graphStore: m.store, messages: [{ role: "user", text: "rename Uraemia to Uraemic syndrome and tag it" }], signal: undefined });
		assert.equal(result.proposal?.summary, "Rename Uraemia and tag it");
		assert.equal(result.proposal?.previews.length, 2);
		assert.match(result.reply, /Accept or reject/);
		assert.equal(JSON.stringify(m.state), before, "proposing changes nothing");
	});

	it("a refused proposal comes back with reasons and the agent fixes it", async () => {
		const m = memory();
		const { engine, calls } = fauxEngine([
			call(PROPOSE_CHANGES_TOOL, { summary: "bad", changes: [{ op: "set_tags", nodeId: "n_c", systems: ["nephrology"] }] }),
			(context) => {
				const last = context.messages[context.messages.length - 1] as { role: string; isError?: boolean; content: Array<{ text?: string }> };
				assert.equal(last.role, "toolResult");
				assert.equal(last.isError, true);
				assert.match(last.content[0]!.text ?? "", /unknown organ system “nephrology”/);
				return call(PROPOSE_CHANGES_TOOL, { summary: "good", changes: [{ op: "set_tags", nodeId: "n_c", systems: ["renal"] }] });
			},
			fauxAssistantMessage("Proposed: tag Uraemia Renal."),
		]);
		const result = await runOrganizer({ engine, graphStore: m.store, messages: [{ role: "user", text: "tag Uraemia as kidney" }], signal: undefined });
		assert.equal(calls(), 3);
		assert.equal(result.proposal?.summary, "good");
	});

	it("a stringified changes array is healed; a delete op is refused", async () => {
		const m = memory();
		const { engine } = fauxEngine([
			call(PROPOSE_CHANGES_TOOL, { summary: "x", changes: JSON.stringify([{ op: "delete_node", nodeId: "n_c" }]) }),
			(context) => {
				const last = context.messages[context.messages.length - 1] as { content: Array<{ text?: string }> };
				assert.match(last.content[0]!.text ?? "", /unknown op "delete_node"/);
				return fauxAssistantMessage("I can't delete nodes.");
			},
		]);
		const result = await runOrganizer({ engine, graphStore: m.store, messages: [{ role: "user", text: "delete Uraemia" }], signal: undefined });
		assert.equal(result.proposal, undefined);
		assert.match(result.reply, /can't delete/);
	});
});

describe("the server service", () => {
	const proposeEngine = () =>
		fauxEngine([
			call(PROPOSE_CHANGES_TOOL, {
				summary: "Add Hyperkalaemia under Low GFR",
				changes: [
					{ op: "create_node", ref: "new1", name: "Hyperkalaemia", statement: "Potassium is raised." },
					{ op: "add_connection", premises: ["n_a"], conclusion: "new1" },
				],
			}),
			fauxAssistantMessage("Proposed: a new node, Hyperkalaemia, connected from Low GFR."),
		]).engine;

	function service(over: Partial<Parameters<typeof createGraphOrganizer>[0]> = {}) {
		const m = memory();
		let settled = 0;
		const organizer = createGraphOrganizer({
			graphStore: m.store,
			history: m.history,
			engine: proposeEngine,
			providerKeyMissing: () => false,
			extractionRunning: () => false,
			settle: () => void settled++,
			revision: () => 42,
			...over,
		});
		return { m, organizer, settled: () => settled };
	}
	const ask = [{ role: "user" as const, text: "add Hyperkalaemia under Low GFR" }];

	it("chat → accept → undo: only accept writes, undo puts it back", async () => {
		const { m, organizer, settled } = service();
		const nodesBefore = JSON.stringify(m.state.nodes);
		const chat = await organizer.chat(ask);
		assert.ok(chat.ok && chat.proposal);
		assert.equal(JSON.stringify(m.state.nodes), nodesBefore, "a proposal changes nothing");
		assert.equal(settled(), 0);

		const applied = organizer.apply(chat.proposal.id);
		assert.ok(applied.ok);
		assert.equal(applied.graphRevision, 42);
		assert.ok(getGraph(m.store).nodes.some((n) => n.name === "Hyperkalaemia"));
		assert.equal(settled(), 1);
		assert.deepEqual(applied.history.map((h) => h.canUndo), [true]);

		const again = organizer.apply(chat.proposal.id);
		assert.ok(!again.ok && again.status === 404, "a proposal is applied once");

		const undone = organizer.undo(applied.entryId);
		assert.ok(undone.ok);
		assert.equal(JSON.stringify(m.state.nodes), nodesBefore);
		assert.equal(settled(), 2);
	});

	it("apply re-checks the graph: a stale proposal is rejected whole with reasons", async () => {
		const { m, organizer } = service();
		const chat = await organizer.chat(ask);
		assert.ok(chat.ok && chat.proposal);
		m.state.nodes = m.state.nodes.filter((n) => n.id !== "n_a"); // deleted meanwhile
		m.state.chains = [];
		const before = JSON.stringify(m.state);
		const applied = organizer.apply(chat.proposal.id);
		assert.ok(!applied.ok);
		assert.equal(applied.status, 422);
		assert.match(applied.problems![0]!, /not a node in the graph/);
		assert.equal(JSON.stringify(m.state), before);
	});

	it("apply and undo wait out an extraction run", async () => {
		let running = false;
		const { organizer } = service({ extractionRunning: () => running });
		const chat = await organizer.chat(ask);
		assert.ok(chat.ok && chat.proposal);
		running = true;
		const blocked = organizer.apply(chat.proposal.id);
		assert.ok(!blocked.ok && blocked.status === 409 && blocked.code === "extraction_running");
		running = false;
		const applied = organizer.apply(chat.proposal.id);
		assert.ok(applied.ok, "the proposal is still there once the run is done");
		running = true;
		const blockedUndo = organizer.undo(applied.entryId);
		assert.ok(!blockedUndo.ok && blockedUndo.status === 409);
	});

	it("refuses honestly when no model is configured or the key is gone", async () => {
		await assert.rejects(service({ engine: () => undefined }).organizer.chat(ask), (err) => {
			assert.ok(err instanceof ModelsNotConfiguredError);
			assert.deepEqual(err.envelope.missing, [ROLE_SLOT.organizer]);
			return true;
		});
		await assert.rejects(service({ providerKeyMissing: () => true }).organizer.chat(ask), ProviderKeyMissingError);
	});

	it("runs on the strong slot, like the other conversational role", () => {
		assert.equal(ROLE_SLOT.organizer, "strong");
	});

	it("validates the conversation from the page", () => {
		assert.deepEqual(parseOrganizerMessages([{ role: "user", text: " hi " }]), [{ role: "user", text: "hi" }]);
		for (const bad of [null, [], [{ role: "assistant", text: "x" }], [{ role: "user", text: "" }], [{ role: "system", text: "x" }], [{ role: "user", text: "x".repeat(4001) }]]) {
			assert.equal(typeof parseOrganizerMessages(bad), "string", JSON.stringify(bad)?.slice(0, 40));
		}
	});
});
