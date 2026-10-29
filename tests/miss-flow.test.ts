/**
 * Explain my miss (medical fork, Phase 7) — the parts with no UI:
 *
 *   core        the fixed title, the marker, and the word-for-word copy check
 *   route       POST /api/chats with flow "miss": teach kind, fixed title, marker
 *   prompts     the miss-flow rules reach the prober and the teacher
 *   tools       a miss session always holds the multiple-choice quiz
 *   extraction  graph findings that copy the bank are sent back; the note is sent
 *   anki        cards drafted from a miss session cannot carry the bank's wording
 *
 * Runs under an isolated LH_DATA_DIR (set before any config-loading import)
 * with scripted faux models: no network, no keys, nothing from the real data dir.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-miss-flow-"));
process.env.LH_DATA_DIR = TMP_DATA;
after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const { composeInstructions } = await import("../src/agent/teacher-agent.ts");
const { createTeacherTools, createProberTools } = await import("../src/agent/tools.ts");
const { createExtractionPipeline, EXTRACTOR_INSTRUCTIONS, MISS_EXTRACTOR_NOTE, validateNoBankCopy } = await import("../src/agent/subagents/extraction.ts");
const { runAnkiMaker, ANKI_MAKER_INSTRUCTIONS, ANKI_MAKER_MISS_NOTE } = await import("../src/agent/subagents/anki-maker.ts");
const { createAnkiService } = await import("../src/server/anki.ts");
const { createAnkiDraftStore } = await import("../src/store/anki.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { graphStore } = await import("../src/store/graph.ts");
const chatsRoute = await import("../app/api/chats/route.ts");
const core = await import("../src/core/index.ts");
const { isMissFlow, learnerTexts, newMissFlowMessage, toLlmMessages } = core;
import type { PiEngine } from "../src/agent/models.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

// A made-up bank item. The wording is deliberately long enough to be copied.
const BANK_STEM =
	"A 58-year-old man presents with crushing chest pain radiating to the left arm for two hours and ST elevation in leads II III and aVF";
const BANK_EXPLANATION =
	"The correct answer is right coronary artery occlusion because the inferior leads are supplied by the posterior descending branch";

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

const userMessage = (id: string, text: string): LhMessage => ({ id, role: "user", content: text, timestamp: 1 }) as never;
const teacherMessage = (id: string, text: string): LhMessage =>
	({
		id,
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openrouter",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason: "stop",
		timestamp: 2,
	}) as never;

describe("core — title, marker, copy check", () => {
	it("the miss title is a fixed label plus the date, never the pasted question", () => {
		const title = core.missSessionTitle(new Date(2026, 9, 29, 14, 5));
		assert.equal(title, "Explain my miss — 29 Oct 14:05");
		assert.ok(title.startsWith(core.MISS_SESSION_TITLE));
	});

	it("the marker is the session's identity and reads as injected context, not as the learner", () => {
		const marker = newMissFlowMessage();
		assert.equal(isMissFlow([marker as LhMessage]), true);
		assert.equal(isMissFlow([userMessage("u1", "hello")]), false);
		assert.match(marker.content, /^\[Session context\]/);
		assert.match(marker.content, /Explain my miss/);
		// The model receives it (as a user-role message); the transcript hides it.
		const wire = toLlmMessages([marker, userMessage("u1", "my question")] as never);
		assert.equal(wire.length, 2);
		assert.match(JSON.stringify(wire[0]), /Explain my miss/);
		const view = core.projectView([marker as LhMessage, userMessage("u1", "my question")]);
		assert.equal(view.length, 1, "the marker draws nothing");
		assert.equal(core.nativeInputCause(marker as never, []), "neutral");
	});

	it("learnerTexts returns what the learner typed, and only that", () => {
		const texts = learnerTexts([newMissFlowMessage() as LhMessage, userMessage("u1", BANK_STEM), teacherMessage("t1", "Let us look at this.")]);
		assert.deepEqual(texts, [BANK_STEM]);
	});

	it("copiesSource flags a long copied run, not a shared term or a rewrite", () => {
		const runs = core.verbatimRuns([BANK_STEM, BANK_EXPLANATION]);
		assert.equal(core.copiesSource("ST elevation in the inferior leads", runs), false, "a short clinical phrase is fine");
		assert.equal(core.copiesSource("Inferior STEMI usually reflects right coronary artery occlusion.", runs), false, "own words are fine");
		// Eight words in a row from the stem, with different case and punctuation.
		assert.equal(core.copiesSource("Note: crushing chest pain radiating to the left arm for two hours!", runs), true);
		assert.equal(core.copiesSource("because the inferior leads are supplied by the posterior descending branch", runs), true);
		assert.equal(core.copiesSource("anything", core.verbatimRuns([])), false, "no bank text → nothing to guard");
	});
});

describe("POST /api/chats — flow miss", () => {
	const post = (body: unknown) =>
		chatsRoute.POST(new Request("http://localhost/api/chats", { method: "POST", body: JSON.stringify(body) }));

	it("starts an ordinary teaching session with a fixed title and the miss marker as message[0]", async () => {
		// A buggy or old client that sends the pasted question as the title.
		const res = await post({ title: BANK_STEM, flow: "miss" });
		const { id, title } = (await res.json()) as { id: string; title: string };
		assert.match(title, /^Explain my miss — /);
		assert.equal(title.includes("58-year-old"), false, "no question text in the title");

		const record = chatStore.getChat(id)!;
		assert.equal(record.title, title);
		assert.equal(record.kind, undefined, "kind stays teach — graph extraction runs as normal");
		assert.equal(chatStore.listChats().find((c) => c.id === id)?.kind, "teach");
		assert.equal(isMissFlow(record.messages), true);
		assert.equal(record.messages.length, 1, "the learner's first message is delivered by the chat page, not stored here");
		assert.equal(JSON.stringify(record).includes("58-year-old"), false, "question text is not stored by session creation");
	});

	it("ignores graph picks in the miss flow, and leaves ordinary sessions without a marker", async () => {
		const res = await post({ title: "x", flow: "miss", graphContext: { propositions: [{ id: "n_1", name: "a", statement: "b" }] } });
		const miss = chatStore.getChat(((await res.json()) as { id: string }).id)!;
		assert.equal(miss.messages.length, 1);
		assert.equal(miss.messages[0]!.role === "custom" && miss.messages[0]!.customType, "miss-flow");

		const plain = await post({ title: "teach me the chain rule" });
		const body = (await plain.json()) as { id: string; title: string };
		assert.equal(body.title, "teach me the chain rule");
		assert.equal(isMissFlow(chatStore.getChat(body.id)!.messages), false);
	});
});

describe("prompt rules", () => {
	it("the prober hears the reasoning first, names the gap in plain words, and concludes with one strand", () => {
		const prompt = composeInstructions("prober");
		assert.match(prompt, /Explain my miss/);
		assert.match(prompt, /ask why they picked it/i);
		assert.match(prompt, /Never explain, hint at the right answer, or say whether it was right before you have heard the reasoning/);
		for (const klass of [
			"missed a clue in the stem (cue)",
			"confused look-alikes (discrimination)",
			"knew it but slipped in the steps (execution)",
			"careless",
			"missing underlying knowledge (structural)",
		]) assert.ok(prompt.includes(klass), `names the miss class: ${klass}`);
		assert.match(prompt, /One strand only/);
		assert.match(prompt, /never copied word for word/);
		assert.match(prompt, /management claims in it still follow the accuracy tiers/);
	});

	it("the teacher teaches only the gap, ends with a lettered twin, and never copies the bank", () => {
		const prompt = composeInstructions("teacher");
		assert.match(prompt, /teach only that gap/i);
		assert.match(prompt, /three-node `plan_init` map/);
		assert.match(prompt, /Do not present the plan and wait/);
		assert.match(prompt, /end at the bedside/);
		assert.match(prompt, /look-alike \(discrimination\) miss/);
		assert.match(prompt, /`library_search`/);
		assert.match(prompt, /Never copy the bank/);
		assert.match(prompt, /twin question/i);
		assert.match(prompt, /different angle/);
		assert.match(prompt, /`value` set to `"A"` through `"E"`/);
		assert.match(prompt, /exactly five/);
		assert.match(prompt, /reteach once from the twin's angle/);
		assert.match(prompt, /Do not ask a second twin/);
	});

	it("the practice agent is untouched by the miss flow", () => {
		assert.equal(/Explain my miss/.test(composeInstructions("practice")), false);
	});
});

describe("tools — the twin needs the multiple-choice quiz", () => {
	const ctx = {
		chatId: "chat_x",
		chatStore,
		jobStore: {} as never,
		spawn: () => undefined,
	};

	it("a miss session holds `quiz` even when the learner's setting arms free recall", () => {
		const free = { explain: true };
		assert.ok("explain" in createTeacherTools(ctx, free), "ordinary session: free recall is respected");
		assert.equal("quiz" in createTeacherTools(ctx, free), false);
		const miss = createTeacherTools({ ...ctx, missFlow: true }, free);
		assert.ok("quiz" in miss);
		assert.equal("explain" in miss, false);
		assert.ok("read" in miss && "plan_init" in miss, "the screenshot reader and the plan tool stay");
	});

	it("the prober can read a screenshot", () => {
		assert.ok("read" in createProberTools({ ...ctx, deliver: () => undefined } as never));
	});
});

describe("extraction — the bank's wording stays out of the graph", () => {
	const bankLearner = [newMissFlowMessage() as LhMessage, userMessage("u1", `${BANK_STEM}. I chose left circumflex.`)];
	const teaching = teacherMessage("t1", "Inferior ST elevation points to the right coronary artery, which supplies the inferior wall.");

	it("validateNoBankCopy names the offending proposition", () => {
		const bank = core.verbatimRuns(core.learnerTexts(bankLearner));
		const problem = validateNoBankCopy(
			{ propositions: [{ name: "Inferior STEMI", statement: `Presents with ${BANK_STEM.slice(20)}` }] },
			bank,
		);
		assert.match(problem ?? "", /Proposition 1 \("Inferior STEMI"\)/);
		assert.match(problem ?? "", /own words/);
		assert.equal(validateNoBankCopy({ propositions: [{ name: "Inferior STEMI", statement: "Occlusion of the right coronary artery causes inferior ST elevation." }] }, bank), null);
	});

	it("a miss session's extractor gets the note, and a finding that copies the stem is sent back to be rewritten", async () => {
		const chat = chatStore.createChat("Explain my miss — 29 Oct 14:05");
		chatStore.saveMessages(chat.id, [...bankLearner, teaching]);

		const prompts: string[] = [];
		const findings = (statement: string) => ({
			propositions: [{ id: "p1", name: "Inferior STEMI", statement, aliases: [], messageId: "t1" }],
			chains: [],
		});
		const extractor = fauxEngine([
			(context) => {
				prompts.push(JSON.stringify(context.messages)); // the system prompt rides as the first message
				return fauxAssistantMessage(
					[fauxToolCall("submit_findings", findings(`Presents with ${BANK_STEM.slice(20)}`) as unknown as ToolCall["arguments"], { id: "f1" })],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				prompts.push(JSON.stringify(context.messages));
				return fauxAssistantMessage(
					[fauxToolCall("submit_findings", findings("Occlusion of the right coronary artery causes ST elevation in the inferior leads.") as unknown as ToolCall["arguments"], { id: "f2" })],
					{ stopReason: "toolUse" },
				);
			},
		]);
		const auditor = fauxEngine([
			fauxAssistantMessage([fauxToolCall("submit_review", { links: [] } as unknown as ToolCall["arguments"], { id: "a1" })], { stopReason: "toolUse" }),
		]);

		const pipeline = createExtractionPipeline({ chatStore, graphStore, extractor, auditor });
		const stats = await pipeline.runExtraction(chat.id);
		assert.deepEqual(stats, { nodes: 1, chains: 0 });

		assert.ok(prompts[0]!.includes("Never copy the question bank"), "the miss note rides the extractor's instructions");
		assert.ok(MISS_EXTRACTOR_NOTE.includes("Never copy the question bank"));
		assert.match(prompts[1]!, /repeats the question bank's wording word for word/, "the copy was refused back to the model");
		const saved = graphStore.readNodes().find((n) => n.name === "Inferior STEMI")!;
		assert.ok(saved, "the rewritten finding was merged");
		assert.equal(saved.statement.includes("crushing chest pain"), false);
		assert.equal(core.copiesSource(`${saved.name} ${saved.statement}`, core.verbatimRuns([BANK_STEM, BANK_EXPLANATION])), false);
	});

	it("an ordinary session's extractor instructions are unchanged", () => {
		assert.equal(EXTRACTOR_INSTRUCTIONS.includes("question-bank"), false);
	});
});

describe("Anki — cards cannot carry the bank's wording", () => {
	const quiet = { onStep: () => undefined, signal: undefined };
	const card = (front: string, back: string) => ({ type: "basic", kind: "mechanism", system: "cardio", topic: "Inferior MI", front, back });
	const submit = (cards: unknown, onContext?: (text: string) => void): FauxResponseStep => (context) => {
		onContext?.(JSON.stringify(context.messages)); // the system prompt rides as the first message
		return fauxAssistantMessage([fauxToolCall("submit_cards", { cards } as ToolCall["arguments"], { id: "c" })], { stopReason: "toolUse" });
	};

	it("the card maker's instructions grow the miss note only when a bank is given", async () => {
		const seen: string[] = [];
		await runAnkiMaker({ ...quiet, title: "t", material: "m", bank: core.verbatimRuns([BANK_STEM]), engine: fauxEngine([submit([], (t) => seen.push(t))]) });
		await runAnkiMaker({ ...quiet, title: "t", material: "m", engine: fauxEngine([submit([], (t) => seen.push(t))]) });
		assert.ok(seen[0]!.includes("Never copy the question bank"));
		assert.equal(seen[1]!.includes("Never copy the question bank"), false);
		assert.ok(ANKI_MAKER_MISS_NOTE.includes("Never copy the question bank"));
		assert.ok(ANKI_MAKER_INSTRUCTIONS.length > 0);
	});

	it("a card that repeats the stem is sent back; the rewritten one is kept", async () => {
		const seen: string[] = [];
		const cards = await runAnkiMaker({
			...quiet,
			title: "t",
			material: "m",
			bank: core.verbatimRuns([BANK_STEM, BANK_EXPLANATION]),
			engine: fauxEngine([
				submit([card(`Vignette: ${BANK_STEM}. Which artery?`, "Right coronary artery")], (t) => seen.push(t)),
				submit([card("Which artery is occluded in an inferior STEMI?", "The right coronary artery, which supplies the inferior wall")], (t) => seen.push(t)),
			]),
		});
		assert.equal(seen.length, 2, "the model was asked again");
		assert.match(seen[1]!, /repeats the question bank's wording word for word/);
		assert.equal(cards.length, 1);
		assert.equal(cards[0]!.front, "Which artery is occluded in an inferior STEMI?");
	});

	it("the service leaves the learner's opening message (the pasted question) out of a miss session's material", async () => {
		let material = "";
		const record = {
			id: "chat_miss",
			title: "Explain my miss — 29 Oct 14:05",
			messages: [newMissFlowMessage(), userMessage("u1", `${BANK_STEM}. I chose B.`), teacherMessage("t1", "Inferior ST elevation points to the right coronary artery."), userMessage("u2", "ok, the RCA supplies the inferior wall")],
		};
		const service = createAnkiService({
			drafts: createAnkiDraftStore(path.join(TMP_DATA, `drafts-${crypto.randomUUID()}`)),
			chatStore: { getChat: (id) => (id === record.id ? (record as never) : null) },
			graphStore: { readNodes: () => [], readChains: () => [] },
			engine: () => fauxEngine([submit([card("Which artery supplies the inferior wall?", "The right coronary artery")], (t) => (material = t))]),
			providerKeyMissing: () => false,
		});
		const started = await service.start({ kind: "session", chatId: "chat_miss" });
		assert.ok(started.ok);
		for (let i = 0; i < 200 && service.get(started.draft.id)!.status === "generating"; i++) await new Promise((r) => setTimeout(r, 10));
		assert.equal(service.get(started.draft.id)!.status, "ready");
		assert.equal(material.includes("58-year-old"), false, "the stem is not in the material");
		assert.match(material, /Inferior ST elevation points to the right coronary artery/);
		assert.match(material, /the RCA supplies the inferior wall/, "the learner's later reasoning is kept");
		assert.ok(material.includes("Never copy the question bank"), "and the card maker is told not to copy the bank");
	});
});
