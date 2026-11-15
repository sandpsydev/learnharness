/**
 * Session recap, the service and the vault (medical fork): asking for a recap,
 * what the writer is and is not shown, the note landing at
 * `Session recaps/<date> <title>.md`, a refresh keeping the learner's My notes,
 * a moved or emptied vault rebuilt with no model call, the sync never removing
 * a recap, and the plain refusals. The writer is a fake; nothing here calls a
 * model.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { SUBMIT_RECAP_TOOL, recapWriterInstructions, recapWriterPrompt, runRecapWriter, type RecapWriterInput, type RecapWriterResult } from "../src/agent/subagents/recapwriter.ts";
import type { ChatRecord, FigureResult, FigureToolInput, GraphChain, GraphNode } from "../src/core/contracts.ts";
import { DEFAULT_MY_NOTES, MY_NOTES_MARKER, SESSION_RECAPS_DIR, splitMyNotes } from "../src/core/obsidian.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError, ROLE_SLOT } from "../src/core/settings.ts";
import { validateRecap } from "../src/core/session-recap.ts";
import { createRecapService, type RecapShared } from "../src/server/recap.ts";
import { createObsidianSync, newSyncState } from "../src/server/obsidian.ts";
import { createVault } from "../src/store/obsidian-vault.ts";
import { createRecapStore } from "../src/store/recaps.ts";
import { createReviewStore } from "../src/store/review.ts";
import { CHAT_ID, FIGURE_FILE, sessionMessages, teacher, user } from "./recap-fixtures.ts";

const T0 = "2026-11-12T08:00:00.000Z";
const ENGINE = { model: { provider: "openai-codex", id: "fake" }, streamFn: () => undefined } as unknown as PiEngine;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);

const node = (id: string, name: string, chatId: string, over: Partial<GraphNode> = {}): GraphNode => ({
	id,
	name,
	statement: `${name}.`,
	aliases: [],
	createdAt: "2026-10-01T00:00:00.000Z",
	provenance: [{ chatId, messageId: "m1" }],
	...over,
});

let dir: string;
let vaultDir: string;
let setups = 0;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-recap-"));
	vaultDir = path.join(dir, "vault");
	fs.mkdirSync(vaultDir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

interface Options {
	vault?: string | null;
	engine?: () => PiEngine | undefined;
	keyMissing?: boolean;
	messages?: ChatRecord["messages"];
	title?: string;
	kind?: ChatRecord["kind"];
	figureCached?: boolean;
	/** Called inside the fake writer; may return a promise to hold the run open. */
	onWrite?: (input: RecapWriterInput) => Promise<void> | void;
	fail?: string;
	/** New pictures the fake writer asks for. */
	pictures?: Array<{ concept: string; modality?: string; caption: string; diagram?: string; turns: number[] }>;
	/** The fake figure finder; absent = the finder engine isn't set, so pictures are skipped. */
	finder?: (input: FigureToolInput, signal: AbortSignal) => Promise<FigureResult> | FigureResult;
	/** The fake visual maker; absent = no drawing engine. */
	drawer?: (brief: string, signal: AbortSignal) => Promise<string> | string;
}

const finderImage = (file: string, over: Partial<NonNullable<FigureResult["image"]>> = {}): FigureResult => ({
	concept: "x",
	outcome: "image",
	image: { file, mime: "image/png", tier: "radiopaedia", source: "Radiopaedia", title: "A case", credit: "Dr Example, via Radiopaedia", licence: "CC BY-NC-SA 3.0", ...over },
	caption: "The finder's own description, which names a diagnosis the session never made.",
	keyFeature: "Look at the hilum.",
	links: [],
	brief: "shown",
});
const noPicture = (concept: string): FigureResult => ({ concept, outcome: "none", caption: "", keyFeature: "", links: [], brief: "Nothing usable turned up." });

function setup(opts: Options = {}) {
	let chat: ChatRecord = {
		id: CHAT_ID,
		title: opts.title ?? "Loop diuretics",
		createdAt: "2026-11-10T09:00:00.000Z",
		updatedAt: "2026-11-10T10:00:00.000Z",
		messages: opts.messages ?? sessionMessages(),
		...(opts.kind ? { kind: opts.kind } : {}),
	};
	let nodes: GraphNode[] = [node("n_lasix", "Furosemide blocks NKCC2", CHAT_ID, { systems: ["renal"] }), node("n_other", "Insulin binds its receptor", "chat_zzz_other")];
	const chains: GraphChain[] = [];
	const graphStore = { readNodes: () => nodes.map((n) => structuredClone(n)), readChains: () => chains, readSources: () => [] };
	const recapStore = createRecapStore(path.join(dir, `recaps-${++setups}`));
	const reviewStore = createReviewStore(path.join(dir, `review-${setups}`));
	const vaultPath = opts.vault === undefined ? vaultDir : opts.vault;
	const settings = () => (vaultPath ? { version: 1, obsidian: { vaultPath } } : null);
	const obsidian = createObsidianSync({
		readSettings: settings,
		graphStore,
		reviewStore,
		recapStore,
		makeVault: createVault,
		revision: () => 1,
		now: () => new Date(T0),
		suggest: () => null,
		setTimer: (() => 0) as never,
		clearTimer: () => {},
		state: newSyncState(),
	});
	const seen: RecapWriterInput[] = [];
	let writes = 0;
	const shared: RecapShared = { run: null, controller: null };
	const finderCalls: FigureToolInput[] = [];
	const phases: string[] = [];
	const service = createRecapService({
		...(opts.finder ? { figureEngine: () => ENGINE } : {}),
		...(opts.drawer ? { diagramEngine: () => ENGINE } : {}),
		findFigure: async (input, _engine, _chatId, signal) => {
			finderCalls.push(input);
			phases.push(shared.run?.current ?? "");
			return opts.finder!(input, signal);
		},
		drawDiagram: async (brief, _engine, signal) => opts.drawer!(brief, signal),
		getChat: (id) => (id === chat.id ? chat : null),
		recapStore,
		readSettings: settings,
		engine: opts.engine ?? (() => ENGINE),
		providerKeyMissing: () => opts.keyMissing === true,
		readFigure: (_chatId, file) => (file === FIGURE_FILE ? (opts.figureCached === false ? null : { bytes: PNG }) : file.startsWith("aaaa") ? { bytes: PNG } : null),
		syncNow: () => obsidian.run(),
		recapPath: (id) => obsidian.recapPath(id),
		now: () => new Date(T0),
		runRecapWriter: async (input: RecapWriterInput): Promise<RecapWriterResult> => {
			seen.push(input);
			writes++;
			await opts.onWrite?.(input);
			if (input.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
			if (opts.fail) throw new Error(opts.fail);
			const checked = validateRecap(
				{
					summary: `Loop diuretics, written ${writes} time(s).`,
					topics: [
						{
							title: "Loop diuretics",
							points: [{ text: "They block NKCC2 in the thick ascending limb.", turns: [2] }],
							tables: ["K1"],
							figures: [...input.transcript.figures.values()].map((f) => (f.kind === "image" ? f.id : { id: f.id, caption: "The nephron" })),
							...(opts.pictures ? { pictures: opts.pictures } : {}),
						},
					],
					misses: [{ question: "Which transporter does furosemide block?", yours: "NCC", correct: "NKCC2", turns: [3, 4] }],
					selfTest: [{ question: "Which transporter does furosemide block?", answer: "NKCC2", turns: [3] }],
				},
				input.transcript,
			);
			assert.ok(checked.ok, checked.ok ? "" : checked.problems.join());
			return { draft: checked.recap, usage: { calls: 1, inputTokens: 10, outputTokens: 5 } };
		},
		shared,
	});
	return {
		service,
		recapStore,
		obsidian,
		seen,
		finderCalls,
		phases,
		writes: () => writes,
		setChat: (patch: Partial<ChatRecord>) => void (chat = { ...chat, ...patch }),
		setNodes: (n: GraphNode[]) => void (nodes = n),
		notePath: (rel: string) => path.join(vaultDir, "LearnHarness", rel),
	};
}

const NOTE = `${SESSION_RECAPS_DIR}/2026-11-10 Loop diuretics.md`;

describe("Session recap — writing one", () => {
	it("writes the note to Session recaps/<date> <session title>.md, with its table and pictures, and offers an Obsidian link", async () => {
		const t = setup();
		const out = t.service.write(CHAT_ID);
		assert.ok(out.ok);
		await t.service.idle();
		const status = t.service.status(CHAT_ID);
		assert.equal(status.run?.error, undefined);
		assert.equal(status.recap?.notePath, NOTE);
		assert.equal(status.recap?.absolutePath, t.notePath(NOTE));
		assert.equal(status.recap?.obsidianUrl, `obsidian://open?path=${encodeURIComponent(t.notePath(NOTE))}`);
		const text = fs.readFileSync(t.notePath(NOTE), "utf-8");
		assert.match(text, /^---\nlh_managed: true\nlh_kind: "recap"\nlh_id: "chat_abc123_def45678"\ndate: "2026-11-10"\nsession: "Loop diuretics"/);
		assert.match(text, /tags:\n {2}- session-recap\n {2}- system\/renal/);
		assert.match(text, /\| Furosemide \| Blocks NKCC2/);
		assert.match(text, /## Fact notes from this session\n\n- \[\[Furosemide blocks NKCC2\]\]/);
		assert.ok(!text.includes("Insulin binds"), "a fact from another session is not linked");
		// Both pictures reached the app's Attachments folder, from the session's own cache and drawing.
		const attachments = fs.readdirSync(t.notePath("Attachments"));
		assert.equal(attachments.length, 2);
		assert.ok(attachments.some((f) => f.endsWith(FIGURE_FILE)) && attachments.some((f) => /-drawn-[0-9a-f]+\.svg$/.test(f)));
		for (const f of attachments) assert.ok(text.includes(`![[${f}|560]]`));
		assert.ok(text.includes(MY_NOTES_MARKER) && text.endsWith(DEFAULT_MY_NOTES));
	});

	it("stores the app's own copy of the recap", async () => {
		const t = setup();
		t.service.write(CHAT_ID);
		await t.service.idle();
		const stored = t.recapStore.get(CHAT_ID)!;
		assert.equal(stored.title, "Loop diuretics");
		assert.equal(stored.sessionDate, "2026-11-10");
		assert.equal(stored.messageCount, sessionMessages().length);
		assert.equal(stored.notePath, NOTE);
		assert.equal(stored.topics[0]!.tables[0]!.markdown.split("\n")[0], "| Drug | Mechanism |");
	});

	it("shows the writer the session and nothing else", async () => {
		const t = setup();
		t.service.write(CHAT_ID);
		await t.service.idle();
		const input = t.seen[0]!;
		assert.equal(input.title, "Loop diuretics");
		assert.match(input.transcript.text, /Loop diuretics block NKCC2/);
		const prompt = recapWriterPrompt(input);
		assert.ok(prompt.includes("=== SESSION TRANSCRIPT (your only source) ==="));
		assert.ok(!/Insulin binds|Furosemide blocks NKCC2\./.test(prompt), "no graph fact is passed to the writer");
		assert.deepEqual(Object.keys(input).sort(), ["engine", "signal", "title", "transcript"]);
	});

	it("is not the illness script or the SlideScribe folder: it writes into Session recaps only", async () => {
		const t = setup();
		t.service.write(CHAT_ID);
		await t.service.idle();
		const folders = fs.readdirSync(t.notePath("")).sort();
		assert.ok(folders.includes("Session recaps"));
		assert.ok(!folders.includes("Illness scripts") && !folders.includes("SlideScribe"));
		assert.deepEqual(fs.readdirSync(t.notePath("Session recaps")), ["2026-11-10 Loop diuretics.md"]);
	});

	it("tells the learner the phase while it runs, and nothing is written until the writer is done", async () => {
		let release!: () => void;
		const t = setup({ onWrite: () => new Promise<void>((r) => (release = r)) });
		assert.ok(t.service.write(CHAT_ID).ok);
		await new Promise((r) => setTimeout(r, 10));
		const running = t.service.status(CHAT_ID);
		assert.equal(running.run?.running, true);
		assert.equal(running.run?.phase, "writing");
		assert.equal(running.busy, true);
		assert.equal(fs.existsSync(t.notePath(NOTE)), false);
		release();
		await t.service.idle();
		assert.equal(t.service.status(CHAT_ID).run?.running, false);
		assert.equal(fs.existsSync(t.notePath(NOTE)), true);
	});

	it("runs one at a time, and a second click on the same session says so", async () => {
		let release!: () => void;
		const t = setup({ onWrite: () => new Promise<void>((r) => (release = r)) });
		t.service.write(CHAT_ID);
		const again = t.service.write(CHAT_ID);
		assert.ok(!again.ok && again.code === "recap_busy" && again.status === 409);
		release();
		await t.service.idle();
		assert.equal(t.writes(), 1);
	});

	it("keeps a picture out of the note when the session's cached copy is gone", async () => {
		const t = setup({ figureCached: false });
		t.service.write(CHAT_ID);
		await t.service.idle();
		const text = fs.readFileSync(t.notePath(NOTE), "utf-8");
		assert.ok(!text.includes(FIGURE_FILE));
		assert.deepEqual(fs.readdirSync(t.notePath("Attachments")).length, 1, "only the drawn diagram");
	});
});

describe("Session recap — pictures for the visual points", () => {
	const stone = { concept: "Calcium oxalate stones: spiculated, brown, and where they lodge", modality: "stone photograph", caption: "Calcium oxalate stones are hard, spiculated and brown.", turns: [2] };
	const ureter = { concept: "The ureter's three narrowings", caption: "The ureter narrows at the pelviureteric junction, the pelvic brim and the bladder wall.", diagram: "A ureter running from the renal pelvis to the bladder, with three narrow points labelled: pelviureteric junction, pelvic brim, vesicoureteric junction.", turns: [2] };

	it("finds a real picture, puts it in Attachments, and captions it with the writer's words and the picture's credit", async () => {
		const t = setup({ pictures: [stone], finder: () => finderImage("aaaa1111aaaa1111aaaa1111.png") });
		t.service.write(CHAT_ID);
		await t.service.idle();
		assert.equal(t.service.status(CHAT_ID).run?.error, undefined);
		const text = fs.readFileSync(t.notePath(NOTE), "utf-8");
		const name = fs.readdirSync(t.notePath("Attachments")).find((f) => f.endsWith("aaaa1111aaaa1111aaaa1111.png"))!;
		assert.ok(name, "the found picture is in the Attachments folder");
		assert.ok(text.includes(`![[${name}|560]]\n*Calcium oxalate stones are hard, spiculated and brown. — Dr Example, via Radiopaedia · CC BY-NC-SA 3.0*`));
		assert.ok(!text.includes("names a diagnosis the session never made"), "the finder's own description never reaches the note");
		assert.equal(t.finderCalls[0]!.concept, stone.concept);
		assert.equal(t.finderCalls[0]!.modality, "stone photograph");
		assert.equal(t.recapStore.get(CHAT_ID)!.topics[0]!.figures.length, 3, "the session's two figures and the found one");
	});

	it("credits the learner's own slide by its lecture and slide", async () => {
		const t = setup({ pictures: [stone], finder: () => finderImage("aaaa2222aaaa2222aaaa2222.png", { tier: "slides", title: "Renal lecture, slide 12", credit: "Your lecture slides", licence: "Your lecture slides" }) });
		t.service.write(CHAT_ID);
		await t.service.idle();
		assert.match(fs.readFileSync(t.notePath(NOTE), "utf-8"), /\*Calcium oxalate stones are hard, spiculated and brown\. — Renal lecture, slide 12 · Your lecture slides\*/);
	});

	it("shows which picture it is looking for while it works", async () => {
		let release!: () => void;
		const t = setup({ pictures: [stone, { ...stone, concept: "Renal arteries" }], finder: () => new Promise<FigureResult>((r) => (release = () => r(noPicture("x")))) });
		t.service.write(CHAT_ID);
		await new Promise((r) => setTimeout(r, 15));
		const running = t.service.status(CHAT_ID).run!;
		assert.equal(running.phase, "pictures");
		assert.equal(running.current, `Finding a picture: ${stone.concept} (1 of 2)`);
		release();
		await new Promise((r) => setTimeout(r, 15));
		release();
		await t.service.idle();
	});

	it("draws a diagram from the writer's brief when no real picture fits, and says nothing about a missing one it did draw", async () => {
		const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><circle r="1"/></svg>';
		const t = setup({ pictures: [ureter], finder: () => noPicture("x"), drawer: () => svg });
		t.service.write(CHAT_ID);
		await t.service.idle();
		const status = t.service.status(CHAT_ID);
		assert.equal(status.run?.message, undefined);
		const text = fs.readFileSync(t.notePath(NOTE), "utf-8");
		assert.match(text, /\*The ureter narrows at the pelviureteric junction, the pelvic brim and the bladder wall\. — drawn by LearnHarness\*/);
		assert.equal(fs.readdirSync(t.notePath("Attachments")).filter((f) => /-drawn-/.test(f)).length, 2, "the session's own drawing and this one");
	});

	it("skips a picture gracefully when the lookup fails or finds nothing, and still writes the recap", async () => {
		const t = setup({ pictures: [stone, ureter], finder: async () => { throw new Error("Radiopaedia is down"); } });
		t.service.write(CHAT_ID);
		await t.service.idle();
		const status = t.service.status(CHAT_ID);
		assert.equal(status.run?.error, undefined);
		assert.equal(status.run?.message, "0 of 2 new pictures added; 2 couldn't be found, so they were left out.");
		assert.ok(status.recap && fs.existsSync(t.notePath(NOTE)));
		assert.equal(fs.readdirSync(t.notePath("Attachments")).length, 2, "only the session's own pictures");
	});

	it("skips unsafe drawings", async () => {
		const t = setup({ pictures: [ureter], finder: () => noPicture("x"), drawer: () => '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' });
		t.service.write(CHAT_ID);
		await t.service.idle();
		assert.match(t.service.status(CHAT_ID).run?.message ?? "", /0 of 1 new picture added; 1 couldn't be found, so it was left out\./);
	});

	it("skips every new picture, quietly, when no vision model is set — and the recap is still written", async () => {
		const t = setup({ pictures: [stone] });
		t.service.write(CHAT_ID);
		await t.service.idle();
		assert.equal(t.service.status(CHAT_ID).run?.error, undefined);
		assert.match(t.service.status(CHAT_ID).run?.message ?? "", /couldn't be found/);
		assert.ok(fs.existsSync(t.notePath(NOTE)));
	});

	it("a stop during the picture search keeps nothing", async () => {
		const t = setup({ pictures: [stone], finder: (_input, signal) => new Promise<FigureResult>((_r, rej) => signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))) });
		t.service.write(CHAT_ID);
		await new Promise((r) => setTimeout(r, 15));
		t.service.stop(CHAT_ID);
		await t.service.idle();
		assert.equal(t.service.status(CHAT_ID).run?.error, "Stopped. Nothing was saved.");
		assert.equal(t.recapStore.get(CHAT_ID), null);
	});

	it("asks for nothing when the writer asks for no pictures: the finder is never called", async () => {
		const t = setup({ finder: () => finderImage("aaaa3333aaaa3333aaaa3333.png") });
		t.service.write(CHAT_ID);
		await t.service.idle();
		assert.equal(t.finderCalls.length, 0);
	});
});

describe("Session recap — refreshing", () => {
	it("rewrites the generated part from the whole session and keeps what the learner wrote under My notes", async () => {
		const t = setup();
		t.service.write(CHAT_ID);
		await t.service.idle();
		const mine = `${DEFAULT_MY_NOTES}Remember the thiazide table. [[Something of mine]]\n`;
		const before = fs.readFileSync(t.notePath(NOTE), "utf-8");
		fs.writeFileSync(t.notePath(NOTE), `${splitMyNotes(before).generated}${MY_NOTES_MARKER}\n${mine}`);

		t.setChat({ messages: [...sessionMessages(), teacher("m10", "One more point: spironolactone spares potassium."), user("m11", "Thanks.")] });
		assert.equal(t.service.status(CHAT_ID).recap?.newMessages, 2, "the status counts what was added after the recap was written");
		t.service.write(CHAT_ID);
		await t.service.idle();

		const after = fs.readFileSync(t.notePath(NOTE), "utf-8");
		assert.match(after, /written 2 time\(s\)/);
		assert.equal(splitMyNotes(after).mine, mine);
		assert.equal(t.writes(), 2);
		assert.match(t.seen[1]!.transcript.text, /spironolactone spares potassium/);
		assert.equal(fs.readdirSync(t.notePath("Session recaps")).length, 1, "still one note per session");
	});

	it("says how far the session has moved on since the recap", async () => {
		const t = setup();
		t.service.write(CHAT_ID);
		await t.service.idle();
		t.setChat({ messages: [...sessionMessages(), user("m10", "Another question."), teacher("m11", "Another answer.")] });
		assert.equal(t.service.status(CHAT_ID).recap?.newMessages, 2);
	});

	it("moves the note, with My notes, when the session is renamed and the recap is refreshed", async () => {
		const t = setup();
		t.service.write(CHAT_ID);
		await t.service.idle();
		const before = fs.readFileSync(t.notePath(NOTE), "utf-8");
		fs.writeFileSync(t.notePath(NOTE), `${splitMyNotes(before).generated}${MY_NOTES_MARKER}\n## My notes\n\nkeep me\n`);
		t.setChat({ title: "Diuretics: loop and thiazide" });
		t.service.write(CHAT_ID);
		await t.service.idle();
		assert.equal(fs.existsSync(t.notePath(NOTE)), false);
		const moved = t.notePath(`${SESSION_RECAPS_DIR}/2026-11-10 Diuretics- loop and thiazide.md`);
		assert.ok(fs.readFileSync(moved, "utf-8").includes("keep me"));
	});
});

describe("Session recap — the app's copy and the vault", () => {
	it("rebuilds an emptied vault from the app's own copy without calling the model", async () => {
		const t = setup();
		t.service.write(CHAT_ID);
		await t.service.idle();
		fs.rmSync(path.join(vaultDir, "LearnHarness"), { recursive: true, force: true });
		const callsBefore = t.writes();
		t.obsidian.run();
		assert.equal(t.writes(), callsBefore);
		const text = fs.readFileSync(t.notePath(NOTE), "utf-8");
		assert.match(text, /## Self-test/);
		assert.equal(fs.readdirSync(t.notePath("Attachments")).length, 2);
	});

	it("rebuilds in a new vault folder too", async () => {
		const t = setup();
		t.service.write(CHAT_ID);
		await t.service.idle();
		const moved = path.join(dir, "vault-2");
		fs.mkdirSync(moved);
		fs.renameSync(path.join(vaultDir, "LearnHarness"), path.join(moved, "LearnHarness-old"));
		const other = createObsidianSync({
			readSettings: () => ({ version: 1, obsidian: { vaultPath: moved } }),
			graphStore: { readNodes: () => [], readChains: () => [], readSources: () => [] },
			reviewStore: createReviewStore(path.join(dir, "review-x")),
			recapStore: t.recapStore,
			makeVault: createVault,
			revision: () => 1,
			now: () => new Date(T0),
			suggest: () => null,
			setTimer: (() => 0) as never,
			clearTimer: () => {},
			state: newSyncState(),
		});
		other.run();
		assert.ok(fs.existsSync(path.join(moved, "LearnHarness", NOTE)));
	});

	it("never removes a recap note, even when the session or its recap record is gone", async () => {
		const t = setup();
		t.service.write(CHAT_ID);
		await t.service.idle();
		fs.rmSync(path.join(dir, `recaps-${setups}`, "sessions"), { recursive: true, force: true });
		const report = t.obsidian.run();
		assert.equal(report.state, "idle");
		assert.equal(t.obsidian.state.lastReport?.removed, 0);
		assert.ok(fs.existsSync(t.notePath(NOTE)));
	});

	it("keeps two sessions with the same title and day in two notes", async () => {
		const t = setup();
		t.service.write(CHAT_ID);
		await t.service.idle();
		t.recapStore.put({ ...t.recapStore.get(CHAT_ID)!, chatId: "chat_zzz_other2", generatedAt: T0 }, []);
		t.obsidian.run();
		const names = fs.readdirSync(t.notePath("Session recaps")).sort();
		assert.equal(names.length, 2);
		assert.ok(names.includes("2026-11-10 Loop diuretics.md"));
	});

	it("leaves the learner's own notes in the same folder alone and never reuses their name", async () => {
		fs.mkdirSync(path.join(vaultDir, "LearnHarness", "Session recaps"), { recursive: true });
		fs.writeFileSync(path.join(vaultDir, "LearnHarness", "Session recaps", "2026-11-10 Loop diuretics.md"), "my own note, no header");
		const t = setup();
		t.service.write(CHAT_ID);
		await t.service.idle();
		assert.equal(fs.readFileSync(t.notePath(NOTE), "utf-8"), "my own note, no header");
		const names = fs.readdirSync(t.notePath("Session recaps"));
		assert.equal(names.length, 2);
	});
});

describe("Session recap — plain refusals", () => {
	it("points at Settings → Obsidian when no vault folder is set, and calls no model", () => {
		const t = setup({ vault: null });
		const out = t.service.write(CHAT_ID);
		assert.ok(!out.ok && out.code === "no_vault" && out.status === 409);
		assert.match(out.error, /Settings → Obsidian/);
		assert.equal(t.writes(), 0);
		assert.deepEqual(t.service.status(CHAT_ID).vault, { configured: false });
	});

	it("says why a vault folder can't be used", () => {
		const t = setup({ vault: path.join(dir, "nope") });
		const out = t.service.write(CHAT_ID);
		assert.ok(!out.ok && out.code === "vault_problem");
		assert.equal(t.writes(), 0);
	});

	it("refuses a session that has taught nothing yet, without spending anything", () => {
		const t = setup({ messages: [user("m1", "Hi")] });
		const out = t.service.write(CHAT_ID);
		assert.ok(!out.ok && out.code === "nothing_to_recap" && out.status === 422);
		assert.equal(t.writes(), 0);
	});

	it("refuses an unknown session and a practice session", () => {
		const t = setup({ kind: "practice" });
		const unknown = t.service.write("chat_nope_nope");
		assert.ok(!unknown.ok && unknown.status === 404);
		const practice = t.service.write(CHAT_ID);
		assert.ok(!practice.ok && practice.code === "practice_session");
	});

	it("uses the 503 envelopes when no model is set or its key is missing", () => {
		assert.throws(() => setup({ engine: () => undefined }).service.write(CHAT_ID), ModelsNotConfiguredError);
		assert.throws(() => setup({ keyMissing: true }).service.write(CHAT_ID), ProviderKeyMissingError);
		assert.equal(ROLE_SLOT.recapWriter, "strong");
	});

	it("shows the model's failure as one plain line and saves nothing", async () => {
		const t = setup({ fail: "You are not signed in to ChatGPT." });
		t.service.write(CHAT_ID);
		await t.service.idle();
		const status = t.service.status(CHAT_ID);
		assert.equal(status.run?.running, false);
		assert.equal(status.run?.error, "Couldn't write the recap: You are not signed in to ChatGPT.");
		assert.equal(status.recap, null);
		assert.equal(fs.existsSync(t.notePath(NOTE)), false);
		// dismiss clears it; a retry is a fresh run
		assert.equal(t.service.clearResult(CHAT_ID).run, null);
	});

	it("stops a run on request and keeps nothing", async () => {
		const t = setup({ onWrite: (input) => new Promise<void>((r) => input.signal?.addEventListener("abort", () => r())) });
		t.service.write(CHAT_ID);
		await new Promise((r) => setTimeout(r, 10));
		t.service.stop(CHAT_ID);
		await t.service.idle();
		assert.equal(t.service.status(CHAT_ID).run?.error, "Stopped. Nothing was saved.");
		assert.equal(t.recapStore.get(CHAT_ID), null);
	});

	it("keeps the recap and says so when the vault write fails afterwards", async () => {
		const t = setup();
		fs.rmSync(vaultDir, { recursive: true, force: true }); // the vault vanishes between the click and the write
		fs.mkdirSync(vaultDir);
		fs.writeFileSync(path.join(vaultDir, "LearnHarness"), "a file where the app folder should be");
		t.service.write(CHAT_ID);
		await t.service.idle();
		const status = t.service.status(CHAT_ID);
		assert.match(status.run?.error ?? "", /Your recap is saved in LearnHarness, but it couldn't be written into Obsidian yet/);
		assert.ok(t.recapStore.get(CHAT_ID));
	});
});

describe("the recap writer with a scripted model", () => {
	function faux(steps: FauxResponseStep[]): { engine: PiEngine; calls: () => number } {
		const core = createFauxCore({});
		core.setResponses(steps);
		return { engine: { model: core.getModel(), streamFn: core.streamSimple }, calls: () => core.state.callCount };
	}
	const call = (input: unknown) => fauxAssistantMessage([fauxToolCall(SUBMIT_RECAP_TOOL, input as ToolCall["arguments"], { id: "submit-1" })], { stopReason: "toolUse" });

	it("sends a draft that cites turns the session doesn't have back to be fixed, then accepts the fix", async () => {
		const transcript = (await import("../src/core/session-recap.ts")).assembleTranscript(sessionMessages(), { chatId: CHAT_ID, hasCachedFigure: () => true });
		const bad = { summary: "S", topics: [{ title: "T", points: [{ text: "Invented.", turns: [77] }] }] };
		const good = { summary: "S", topics: [{ title: "T", points: [{ text: "Real.", turns: [2] }] }] };
		const { engine, calls } = faux([call(bad), call(good)]);
		const result = await runRecapWriter({ engine, title: "Loop diuretics", transcript, signal: undefined });
		assert.equal(calls(), 2);
		assert.equal(result.draft.topics[0]!.points[0], "Real.");
	});

	it("gives up when the writer never submits", async () => {
		const transcript = (await import("../src/core/session-recap.ts")).assembleTranscript(sessionMessages(), { chatId: CHAT_ID, hasCachedFigure: () => true });
		const { engine } = faux([fauxAssistantMessage("I could not.")]);
		await assert.rejects(runRecapWriter({ engine, title: "x", transcript, signal: undefined }), /without submitting a recap/);
	});

	it("tells the writer to use only the session and to write English", () => {
		const prompt = recapWriterInstructions();
		assert.match(prompt, /write only what the session actually covered/i);
		assert.match(prompt, /Write in English/);
		assert.match(prompt, /Do not add a fact, a number, a drug, a dose/);
		assert.match(prompt, /submit_recap/);
	});
});
