/**
 * Each background result reaches the teacher and the saved chat ONCE.
 *
 * The owner's chat "approach to breast" (2026-11-22) held research reports
 * twice: the same `steer_<jobId>` marker saved a second time AFTER a
 * compaction marker (the retained tail of the compaction already had it),
 * and once inside a run. Every scenario here is scripted with fakes (no
 * model, no network): results arrive mid-turn, a compaction lands, and a
 * second writer then saves a copy of a marker the record already holds.
 *
 * What is pinned:
 * - persistTurn never adds a steer marker whose id the record already has;
 * - an idle wake carrying one marker twice appends it once;
 * - a live run is not steered a marker it already holds;
 * - a compaction marker never overwrites what was saved while the summary
 *   was being written;
 * - OLD chats that already hold copies read, show and replay each result
 *   once, and the saved file is left exactly as it was.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-background-once-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { ensureCompacted } = await import("../src/server/compaction.ts");
const { persistTurn } = await import("../src/server/turn-service.ts");
const { handleChatInput } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");
const { deliverJobResult, discardChatDeliveries, registerLiveAgent, setTurnRunner, settleSteers, unregisterLiveAgent } = await import("../src/server/jobs.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { buildSubagentSteer } = await import("../src/core/contracts.ts");
const { activeCompactionOf, dropRepeatedSteers, newUserMessage, toLlmMessages } = await import("../src/core/index.ts");
const { projectView } = await import("../src/core/view.ts");
import type { LhMessage } from "../src/core/index.ts";
import type { SteerMessage } from "../src/core/contracts.ts";

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

// ── fixtures ────────────────────────────────────────────────────────────────

/** A research steer for a job, `kb` of brief so it weighs like a real report. */
function steerFor(jobId: string, kb = 8, at = Date.now()): SteerMessage {
	const steer = buildSubagentSteer(
		{ id: jobId, kind: "research", toolCallId: `call_${jobId}` },
		{ brief: `Report for ${jobId}: ${"finding ".repeat(kb * 128)}`, sources: [{ title: "Source", url: "https://example.invalid/s" }] },
	);
	return { ...steer, timestamp: at };
}

const big = (text: string, kb = 60): LhMessage => newUserMessage(`${text}: ${"x".repeat(kb * 1024)}`);

const ids = (messages: readonly { id?: string; customType?: string }[], type = "subagent-steer") =>
	messages.filter((m) => m.customType === type).map((m) => m.id!);

/** How many copies of this result's report the model would read. */
function copiesOnTheWire(messages: LhMessage[], steer: SteerMessage): number {
	const jobId = (steer.details as { jobId: string }).jobId;
	return JSON.stringify(toLlmMessages(messages as never)).split(`Report for ${jobId}:`).length - 1;
}

const faux = () => {
	const core = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	return core;
};

const summarize = {
	summarize: async () => ({
		summary: "SUMMARY: the learner knows the basics.",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	}),
};
const compactDeps = (chatId: string, thresholdTokens: number) => ({
	chatStore,
	engine: { model: { provider: "faux", id: "test", contextWindow: 1_000_000 } } as never,
	modelId: "faux:test",
	kind: "teach" as const,
	thresholdTokens,
	systemPromptTokens: 100,
	...summarize,
	chatId,
});

// ── the scenario: results mid-turn, a compaction, then a second writer ──────

describe("a background result is saved and replayed once", () => {
	it("a late run that carries a result the record already holds adds nothing (the 'research reports twice' shape)", async () => {
		const chat = chatStore.createChat("once: late writer after compaction");
		const results = ["job_a", "job_b", "job_c"].map((id) => steerFor(id));
		// Run A delivered the results mid-lesson and saved them (they sit in the
		// record, after the learner's answer).
		const head = [big("lesson 1", 100), big("lesson 2", 100), newUserMessage("my answer")];
		const delivered = [...head, ...results, big("teacher reply", 8), big("recent 1", 8), big("recent 2", 8)];
		chatStore.saveMessages(chat.id, delivered);

		// The record grew past the threshold: compaction summarises the head and
		// keeps the tail (the cut falls on the kept tail's first message).
		await ensureCompacted(compactDeps(chat.id, 40_000), chat.id);
		const compacted = chatStore.getChat(chat.id)!.messages;
		const marker = activeCompactionOf(compacted);
		assert.ok(marker, "a compaction marker landed");

		// A second run that started BEFORE the compaction (it was handed the same
		// results again, re-stamped) now settles. Its slice is the copies plus its
		// own reply.
		const copies = results.map((steer) => ({ ...steer, timestamp: Date.now() + 5 }));
		const reply = { ...(big("late reply") as object), id: "late_reply" } as LhMessage;
		const base = delivered.length;
		const turnMessages = [...delivered, ...copies, reply];
		const stamped = persistTurn(chatStore, chat.id, base, turnMessages as never, false);

		const saved = chatStore.getChat(chat.id)!.messages;
		assert.deepEqual(ids(saved), results.map((r) => r.id), "each result is in the saved chat exactly once");
		assert.equal(stamped.filter((m) => m.role === "custom").length, 0, "the copies were not saved");
		assert.ok(saved.some((m) => m.id === "late_reply"), "the run's own reply is still saved");
		const shown = results.map((steer) => copiesOnTheWire(saved, steer));
		assert.ok(shown.every((n) => n <= 1), `no report is shown twice (${shown.join(",")})`);
		assert.ok(shown.some((n) => n === 1), "the reports the cut kept are still shown");
	});

	it("a result that sits inside the span the summary covers is not brought back by a later copy", async () => {
		const chat = chatStore.createChat("once: copy of a summarised result");
		const early = steerFor("job_early");
		const messages = [big("lesson 1"), early, big("lesson 2"), big("lesson 3"), big("recent")];
		chatStore.saveMessages(chat.id, messages);
		await ensureCompacted(compactDeps(chat.id, 40_000), chat.id);

		const marker = activeCompactionOf(chatStore.getChat(chat.id)!.messages)!;
		const keptFrom = chatStore.getChat(chat.id)!.messages.findIndex((m) => m.id === marker.details.firstKeptMessageId);
		const earlyAt = chatStore.getChat(chat.id)!.messages.findIndex((m) => m.id === early.id);
		assert.ok(earlyAt < keptFrom, "the result is inside the summarised span");

		const current = chatStore.getChat(chat.id)!.messages;
		persistTurn(chatStore, chat.id, current.length, [...current, { ...early, timestamp: Date.now() + 9 }] as never, false);
		const saved = chatStore.getChat(chat.id)!.messages;
		assert.deepEqual(ids(saved), [early.id], "not saved again");
		assert.equal(copiesOnTheWire(saved, early), 0, "the summary carries it; nothing after the cut repeats it");
	});

	it("a marker saved twice in ONE run's slice is saved once", () => {
		const chat = chatStore.createChat("once: twice inside one run");
		const steer = steerFor("job_twice");
		const first = { ...steer, timestamp: 1 };
		const second = { ...steer, timestamp: 2 };
		chatStore.saveMessages(chat.id, [newUserMessage("start")]);
		persistTurn(chatStore, chat.id, 1, [newUserMessage("start"), first, second] as never, false);
		assert.deepEqual(ids(chatStore.getChat(chat.id)!.messages), [steer.id]);
	});

	it("a compaction never overwrites a message saved while its summary was being written", async () => {
		const chat = chatStore.createChat("once: save during summary");
		chatStore.saveMessages(chat.id, [big("lesson 1"), big("lesson 2"), big("lesson 3"), newUserMessage("recent")]);
		const late = steerFor("job_during_summary");
		const deps = {
			...compactDeps(chat.id, 40_000),
			// The summary takes time; another writer saves a result meanwhile.
			summarize: async () => {
				chatStore.saveMessages(chat.id, [...chatStore.getChat(chat.id)!.messages, late]);
				return summarize.summarize();
			},
		};
		await ensureCompacted(deps, chat.id);
		const saved = chatStore.getChat(chat.id)!.messages;
		assert.ok(saved.some((m) => m.id === late.id), "the result saved during the summary survived");
		assert.ok(activeCompactionOf(saved), "and the marker landed too");
	});

	it("an idle wake that carries one marker twice appends it once", async () => {
		const chat = chatStore.createChat("once: wake with a doubled marker");
		chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
		chatStore.saveMessages(chat.id, [newUserMessage("teach me")]);
		const steer = steerFor("job_wake");
		const core = faux();
		core.setResponses([fauxAssistantMessage("Noted.")]);
		const res = await handleChatInput(chat.id, { type: "steers", steers: [steer, { ...steer, timestamp: steer.timestamp + 300 }] }, (opts) =>
			createTeacherAgent(undefined, { engine: { model: core.getModel(), streamFn: core.streamSimple }, tools: {}, messages: opts.messages }),
		);
		assert.equal(res.status, 200);
		const handle = runningTurn(chat.id);
		if (handle) await new Response(handle.subscribe()).text();
		assert.deepEqual(ids(chatStore.getChat(chat.id)!.messages), [steer.id]);
	});
});

// ── the live hand-off ───────────────────────────────────────────────────────

describe("a live run is not handed a result it already holds", () => {
	it("registering an agent whose history already carries the marker steers nothing more", async () => {
		const chat = chatStore.createChat("once: hand-off");
		chatStore.saveMessages(chat.id, [newUserMessage("teach me")]);
		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call_handoff" });
		const result = { brief: "Hand-off report", sources: [] };
		jobStore.updateJob(job.id, { status: "done", result, delivery: { kind: "result", status: "pending" } });
		const steer = buildSubagentSteer(job, result);
		const handed: SteerMessage[] = [];
		const agent = { steer: (m: SteerMessage) => handed.push(m), state: { messages: [{ id: steer.id, role: "custom" }] } };
		setTurnRunner(async () => 200);
		assert.ok(beginTurn(chat.id));
		registerLiveAgent(chat.id, agent as never);
		const delivery = deliverJobResult(steer);
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(handed.length, 0, "the run already holds this result; it is not steered in a second time");
		// The run settles with the marker saved: delivery resolves.
		chatStore.saveMessages(chat.id, [...chatStore.getChat(chat.id)!.messages, steer]);
		unregisterLiveAgent(chat.id);
		settleSteers(chat.id, [steer]);
		endTurn(chat.id);
		await delivery;
		discardChatDeliveries(chat.id);
	});
});

// ── old chats ───────────────────────────────────────────────────────────────

describe("an old chat that already holds copies", () => {
	/** The owner's saved shape, with invented content: five results in the kept tail, a
	 *  compaction marker, then the SAME five ids saved again after it. */
	function ownersShape(): { messages: LhMessage[]; results: SteerMessage[] } {
		const results = ["job_1", "job_2", "job_3", "job_4", "job_5"].map((id) => steerFor(id, 6));
		const head = [big("lesson 1", 30), big("lesson 2", 30)];
		const tail = [...results, big("reply", 10)];
		const messages: LhMessage[] = [...head, ...tail];
		const marker = {
			id: "compaction_marker",
			role: "custom" as const,
			customType: "compaction" as const,
			content: "[SESSION HISTORY COMPACTED]\n\nSUMMARY",
			display: true,
			details: { firstKeptMessageId: results[0]!.id, tokensBefore: 150_000, at: "2026-11-22T18:31:02.133Z" },
			timestamp: 1,
		};
		const copies = results.map((r) => ({ ...r, timestamp: r.timestamp + 1000 }));
		return { messages: [...messages, marker, ...copies, { ...(big("after", 5) as object), id: "after" } as LhMessage], results };
	}

	it("replays to the model once, shows once, and the saved file is not rewritten", () => {
		const { messages, results } = ownersShape();
		const chat = chatStore.createChat("once: old chat");
		chatStore.saveMessages(chat.id, messages);
		const file = path.join(TMP_DATA, "chats", `${chat.id}.json`);
		const before = fs.readFileSync(file, "utf-8");

		const saved = chatStore.getChat(chat.id)!.messages;
		assert.equal(ids(saved).length, 10, "the old chat really holds ten markers for five results");
		for (const steer of results) assert.equal(copiesOnTheWire(saved, steer), 1, "each report reaches the model once");

		const view = projectView(saved);
		const viewIds = view.map((m) => m.id);
		assert.equal(new Set(viewIds).size, viewIds.length, "the view has no repeated message ids");
		for (const steer of results) assert.equal(viewIds.filter((id) => id === steer.id).length, 1);

		assert.equal(fs.readFileSync(file, "utf-8"), before, "loading and projecting never rewrite the saved chat");
	});

	it("a record with no repeated marker is returned as it is", () => {
		const messages = [newUserMessage("hi"), steerFor("job_x")] as LhMessage[];
		assert.equal(dropRepeatedSteers(messages), messages);
	});
});
