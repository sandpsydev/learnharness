/**
 * Session recap — the service (medical fork, docs/medical-spec.md "Session
 * recap"): writes one review note for one teaching session, when the learner
 * clicks the button on that session's screen.
 *
 *   status(chatId)   what the button shows: the vault check, the run in
 *                    progress or its error, and the recap already written
 *                    (with where its note is and how to open it in Obsidian)
 *   write(chatId)    write the recap — or rewrite it from the whole session
 *                    after the session has moved on; the learner's My notes in
 *                    the vault note are kept (the vault sync does that)
 *   stop()           cancel the run in progress
 *
 * A recap is only ever written when asked: one model call per click spends the
 * owner's ChatGPT allowance, so nothing here runs on its own. One run at a time,
 * tracked on globalThis (Next dev gives each route its own module instance).
 *
 * LearnHarness keeps its own copy of every recap (data/recaps/) and the
 * Obsidian note is rendered from it by the vault sync, so a moved or emptied
 * vault is rebuilt without spending anything, and the sync never removes one.
 */

import * as path from "node:path";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { runFigureFinder } from "../agent/subagents/figure-finder.ts";
import { getHeadless } from "../agent/subagents/headless.ts";
import { runVisualMaker } from "../agent/subagents/visual-maker.ts";
import { runRecapWriter as realRunRecapWriter, type RecapWriterInput, type RecapWriterResult } from "../agent/subagents/recapwriter.ts";
import type { FigureResult, FigureToolInput, ObsidianStatus, RecapFigure, RecapPhase, RecapPictureRequest, RecapRunState, RecapStatus, SessionRecap } from "../core/contracts.ts";
import type { ChatRecord } from "../core/contracts.ts";
import { OBSIDIAN_APP_FOLDER } from "../core/obsidian.ts";
import type { RecapStore } from "../core/ports.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError, ROLE_SLOT, type UserSettings } from "../core/settings.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { assembleTranscript, figureAssetName, sessionDateOf, transcriptTooLong, type RecapFigureSource, type ValidatedTopic } from "../core/session-recap.ts";
import { vaultProblem } from "../store/obsidian-vault.ts";
import { recapStore } from "../store/recaps.ts";
import { readSessionFigure } from "./figures.ts";
import { PATHS } from "../../config.ts";
import { library } from "./library.ts";
import { providerKeyPresent } from "./keys.ts";
import { searchProvider } from "./search.ts";
import { obsidianSync } from "./obsidian.ts";
import { safeSvg } from "./review.ts";
import { stores } from "./stores.ts";

/** The writer's own call is cut off after this long. */
export const RECAP_RUN_LIMIT_MS = 10 * 60_000;
/** One picture's search, and one drawing, are each cut off after this long (the recap carries on without it). */
export const PICTURE_LIMIT_MS = 4 * 60_000;

export type RecapFailure = { ok: false; status: 400 | 404 | 409 | 422; code: string; error: string };
export type RecapOutcome = RecapFailure | { ok: true; status: RecapStatus };

export interface RecapDeps {
	getChat: (chatId: string) => ChatRecord | null;
	recapStore: RecapStore;
	readSettings: () => UserSettings | null;
	/** The recap writer role's engine, or undefined when no model is configured. */
	engine: () => PiEngine | undefined;
	providerKeyMissing: (provider: string) => boolean;
	/** A picture the figure finder cached for the session, or null. */
	readFigure: (chatId: string, file: string) => { bytes: Uint8Array } | null;
	/** Bring the vault in line now (the live sync's immediate run). */
	syncNow: () => ObsidianStatus;
	/** Where the sync put a session's recap note, relative to the app folder. */
	recapPath: (chatId: string) => string | null;
	now: () => Date;
	/** The figure finder's engine (the vision slot), or undefined when none is set: pictures are then skipped. */
	figureEngine?: () => PiEngine | undefined;
	/** The visual maker's engine (the vision slot), or undefined: no drawings. */
	diagramEngine?: () => PiEngine | undefined;
	/** Test seams: the agent calls. */
	runRecapWriter?: (input: RecapWriterInput) => Promise<RecapWriterResult>;
	findFigure?: (input: FigureToolInput, engine: PiEngine, chatId: string, signal: AbortSignal) => Promise<FigureResult>;
	drawDiagram?: (brief: string, engine: PiEngine, signal: AbortSignal) => Promise<string>;
	runLimitMs?: number;
	pictureLimitMs?: number;
	/** Shared run state (globalThis in production). */
	shared?: RecapShared;
}

export interface RecapShared {
	run: RecapRunState | null;
	controller: AbortController | null;
}

const fail = (status: RecapFailure["status"], code: string, error: string): RecapFailure => ({ ok: false, status, code, error });

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function createRecapService(deps: RecapDeps) {
	const shared = deps.shared ?? { run: null, controller: null };
	const runRecapWriter = deps.runRecapWriter ?? realRunRecapWriter;

	function vaultState(): RecapStatus["vault"] {
		const vaultPath = deps.readSettings()?.obsidian?.vaultPath;
		if (!vaultPath) return { configured: false };
		const problem = vaultProblem(vaultPath);
		return problem ? { configured: true, problem } : { configured: true };
	}

	function status(chatId: string): RecapStatus {
		const vaultPath = deps.readSettings()?.obsidian?.vaultPath;
		const recap = deps.recapStore.get(chatId);
		const chat = recap ? deps.getChat(chatId) : null;
		const abs = recap?.notePath && vaultPath ? path.join(vaultPath, OBSIDIAN_APP_FOLDER, ...recap.notePath.split("/")) : undefined;
		return {
			vault: vaultState(),
			busy: shared.run?.running === true,
			run: shared.run && shared.run.chatId === chatId ? { ...shared.run } : null,
			recap: recap
				? {
						generatedAt: recap.generatedAt,
						...(recap.notePath ? { notePath: recap.notePath } : {}),
						...(abs ? { absolutePath: abs, obsidianUrl: `obsidian://open?path=${encodeURIComponent(abs)}` } : {}),
						newMessages: chat ? Math.max(0, chat.messages.length - recap.messageCount) : 0,
						topics: recap.topics.length,
					}
				: null,
		};
	}

	function setPhase(phase: RecapPhase): void {
		if (shared.run) shared.run.phase = phase;
	}

	function finish(run: RecapRunState, error?: string): void {
		run.running = false;
		run.finishedAt = deps.now().toISOString();
		delete run.phase;
		if (error) run.error = error;
		shared.controller = null;
	}

	const credit = (image: NonNullable<FigureResult["image"]>): string => {
		const lead = image.tier === "slides" ? image.title : image.credit;
		return [...new Set([lead, image.licence].map((x) => (typeof x === "string" ? x.trim() : "")).filter((x) => x !== ""))].join(" · ");
	};

	/**
	 * Look for the pictures the writer asked for: a real figure first (the learner's own slides, then the open
	 * sources, through the same finder the lesson uses), a drawing when none fits and the writer gave a brief.
	 * A picture that cannot be found is left out; only a stop ends the run. The caption is always the writer's,
	 * built from what the session said — never the finder's description.
	 */
	async function findPictures(
		chatId: string,
		topics: ValidatedTopic[],
		run: RecapRunState,
		signal: AbortSignal,
	): Promise<{ added: Array<{ topic: number; figure: RecapFigure; file: string; bytes: Uint8Array }>; wanted: number; missed: number }> {
		const requests = topics.flatMap((t, topic) => t.pictures.map((pic) => ({ topic, pic })));
		const out: Array<{ topic: number; figure: RecapFigure; file: string; bytes: Uint8Array }> = [];
		let missed = 0;
		const finderEngine = deps.figureEngine?.();
		const drawingEngine = deps.diagramEngine?.();
		const find = deps.findFigure ?? realFindFigure;
		const draw = deps.drawDiagram ?? realDrawDiagram;
		for (const [i, { topic, pic }] of requests.entries()) {
			if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
			run.current = `Finding a picture: ${pic.concept} (${i + 1} of ${requests.length})`;
			let got: { figure: RecapFigure; file: string; bytes: Uint8Array } | null = null;
			if (finderEngine) {
				try {
					const result = await find(
						{ concept: pic.concept, ...(pic.modality ? { modality: pic.modality } : {}), context: "A picture for a revision note of what this session taught." },
						finderEngine,
						chatId,
						AbortSignal.any([signal, AbortSignal.timeout(deps.pictureLimitMs ?? PICTURE_LIMIT_MS)]),
					);
					const image = result.outcome === "image" ? result.image : undefined;
					const cached = image ? deps.readFigure(chatId, image.file) : null;
					if (image && cached && cached.bytes.byteLength > 0) {
						const file = figureAssetName(chatId, { cacheFile: image.file });
						got = { figure: { file, caption: pic.caption, credit: credit(image) }, file, bytes: cached.bytes };
					}
				} catch (err) {
					if (signal.aborted) throw err;
					console.warn("[recap] picture lookup failed:", err);
				}
			}
			if (!got && pic.diagram && drawingEngine) {
				try {
					const svg = await draw(pic.diagram, drawingEngine, AbortSignal.any([signal, AbortSignal.timeout(deps.pictureLimitMs ?? PICTURE_LIMIT_MS)]));
					if (svg && safeSvg(svg)) {
						const file = figureAssetName(chatId, { svg });
						got = { figure: { file, caption: pic.caption, credit: "" }, file, bytes: new TextEncoder().encode(svg) };
					}
				} catch (err) {
					if (signal.aborted) throw err;
					console.warn("[recap] a diagram couldn't be drawn:", err);
				}
			}
			if (got) out.push({ topic, ...got });
			else missed++;
		}
		delete run.current;
		return { added: out, wanted: requests.length, missed };
	}

	/** The pictures a recap embeds, as files; a figure whose picture is gone is left out. */
	function materialize(chatId: string, topics: ValidatedTopic[], sources: ReadonlyMap<string, RecapFigureSource>): { topics: SessionRecap["topics"]; assets: Array<{ file: string; bytes: Uint8Array }> } {
		const byFile = new Map([...sources.values()].map((s) => [s.file, s]));
		const assets = new Map<string, Uint8Array>();
		const keep = (figure: RecapFigure): boolean => {
			if (assets.has(figure.file)) return true;
			const source = byFile.get(figure.file);
			if (!source) return false;
			if (source.kind === "image" && source.cacheFile) {
				const cached = deps.readFigure(chatId, source.cacheFile);
				if (!cached || cached.bytes.byteLength === 0) return false;
				assets.set(figure.file, cached.bytes);
				return true;
			}
			if (source.kind === "drawn" && source.svg && safeSvg(source.svg)) {
				assets.set(figure.file, new TextEncoder().encode(source.svg));
				return true;
			}
			return false;
		};
		return {
			topics: topics.map(({ pictures: _pictures, ...t }) => ({ ...t, figures: t.figures.filter(keep) })),
			assets: [...assets].map(([file, bytes]) => ({ file, bytes })),
		};
	}

	async function runWrite(engine: PiEngine, chat: ChatRecord, run: RecapRunState, controller: AbortController): Promise<void> {
		try {
			setPhase("reading");
			const messages = chat.messages;
			const transcript = assembleTranscript(messages, { chatId: chat.id, hasCachedFigure: (file) => deps.readFigure(chat.id, file) !== null });
			setPhase("writing");
			const limit = AbortSignal.timeout(deps.runLimitMs ?? RECAP_RUN_LIMIT_MS);
			const result = await runRecapWriter({
				engine,
				title: chat.title,
				transcript,
				signal: AbortSignal.any([controller.signal, limit]),
			});
			// Pictures for the visual points the session taught without one. A failed lookup only leaves the picture out.
			let message: string | undefined;
			const found = result.draft.topics.some((t) => t.pictures.length > 0) ? (setPhase("pictures"), await findPictures(chat.id, result.draft.topics, run, controller.signal)) : null;
			setPhase("saving");
			const { topics, assets } = materialize(chat.id, result.draft.topics, transcript.figures);
			if (found) {
				for (const a of found.added) {
					topics[a.topic]!.figures.push(a.figure);
					assets.push({ file: a.file, bytes: a.bytes });
				}
				if (found.missed > 0) {
					message = `${found.added.length} of ${found.wanted} new picture${found.wanted === 1 ? "" : "s"} added; ${found.missed} couldn't be found, so ${found.missed === 1 ? "it was" : "they were"} left out.`;
				}
			}
			const now = deps.now().toISOString();
			const recap: SessionRecap = {
				chatId: chat.id,
				title: chat.title.trim() || "Session",
				sessionDate: sessionDateOf(chat.createdAt),
				generatedAt: now,
				messageCount: messages.length,
				summary: result.draft.summary,
				...(result.draft.fitsTogether !== "" ? { fitsTogether: result.draft.fitsTogether } : {}),
				highYield: result.draft.highYield,
				understandFirst: result.draft.understandFirst,
				topics,
				misses: result.draft.misses,
				selfTest: result.draft.selfTest,
				usage: result.usage,
			};
			deps.recapStore.put(recap, assets);
			// Into the vault right now, so the learner can open it; the app's copy is already safe.
			const synced = deps.syncNow();
			const notePath = deps.recapPath(chat.id);
			if (notePath) deps.recapStore.put({ ...recap, notePath }, []);
			if (synced.state === "error") {
				if (message) run.message = message;
				finish(run, `Your recap is saved in LearnHarness, but it couldn't be written into Obsidian yet: ${synced.problem ?? "unknown problem"} Click Session recap again once that is fixed (it won't cost anything).`);
				return;
			}
			if (message) run.message = message;
			finish(run);
		} catch (err) {
			if (controller.signal.aborted) finish(run, "Stopped. Nothing was saved.");
			else if (err instanceof Error && err.name === "TimeoutError") finish(run, "The recap took too long and was stopped. Nothing was saved.");
			else finish(run, `Couldn't write the recap: ${errorText(err)}`);
		}
	}

	/** Write (or rewrite) the recap of one session. Returns at once; the run goes on in the background. */
	function write(chatId: unknown): RecapOutcome {
		if (typeof chatId !== "string" || chatId === "") return fail(400, "bad_request", "Say which session to recap.");
		const chat = deps.getChat(chatId);
		if (!chat) return fail(404, "not_found", "That session doesn't exist.");
		if (chat.kind === "practice") return fail(400, "practice_session", "Session recaps are for teaching sessions, not practice sessions.");
		if (shared.run?.running) {
			return fail(409, "recap_busy", shared.run.chatId === chatId ? "This recap is already being written." : "Another session's recap is being written. Wait for it to finish.");
		}
		const vault = vaultState();
		if (!vault.configured) return fail(409, "no_vault", "Set your Obsidian vault folder in Settings → Obsidian first — recaps are written into it.");
		if (vault.problem) return fail(409, "vault_problem", vault.problem);
		const engine = deps.engine();
		if (!engine) throw new ModelsNotConfiguredError([ROLE_SLOT.recapWriter]);
		if (deps.providerKeyMissing(engine.model.provider)) throw new ProviderKeyMissingError(engine.model.provider, [ROLE_SLOT.recapWriter]);

		// Look at the session now, before any call: a session that has taught nothing yet, or is too long, costs nothing to refuse.
		const transcript = assembleTranscript(chat.messages, { chatId: chat.id, hasCachedFigure: (file) => deps.readFigure(chat.id, file) !== null });
		if (transcript.teacherTurns === 0) return fail(422, "nothing_to_recap", "This session hasn't covered anything yet — there is nothing to recap. Come back after the teacher has taught something.");
		if (transcriptTooLong(transcript)) return fail(422, "too_long", "This session is too long to recap in one go.");

		const controller = new AbortController();
		const run: RecapRunState = { chatId, running: true, startedAt: deps.now().toISOString(), phase: "reading" };
		shared.run = run;
		shared.controller = controller;
		void runWrite(engine, chat, run, controller);
		return { ok: true, status: status(chatId) };
	}

	function stop(chatId: string): RecapOutcome {
		if (shared.run?.running && shared.run.chatId === chatId) shared.controller?.abort();
		return { ok: true, status: status(chatId) };
	}

	/** Forget a finished run's result (the popover's dismiss). */
	function clearResult(chatId: string): RecapStatus {
		if (shared.run && !shared.run.running && shared.run.chatId === chatId) shared.run = null;
		return status(chatId);
	}

	/** Wait for the current run to end (tests). */
	async function idle(): Promise<void> {
		for (let i = 0; i < 2000 && shared.run?.running; i++) await new Promise((r) => setTimeout(r, 5));
	}

	return { status, write, stop, clearResult, idle };
}

async function realFindFigure(input: FigureToolInput, engine: PiEngine, chatId: string, signal: AbortSignal): Promise<FigureResult> {
	return runFigureFinder(input, {
		engine,
		env: {
			chatId,
			cacheRoot: PATHS.figures,
			...(library.reader.hasBooks() ? { library: { reader: library.reader, pdfPath: (bookId: string) => stores.libraryStore.pdfPath(bookId) } } : {}),
			search: searchProvider,
			headless: getHeadless,
		},
		abortSignal: signal,
	});
}

async function realDrawDiagram(brief: string, engine: PiEngine, signal: AbortSignal): Promise<string> {
	return (await runVisualMaker({ brief }, { engine, abortSignal: signal })).svg;
}

/** An engine for a role, or undefined when the slot is empty, its key is gone, or it can't be built. */
function optionalEngine(role: "figureFinder" | "visualMaker"): PiEngine | undefined {
	const spec = resolveRoleSpec(role, stores.settingsStore.readSettings());
	if (!spec || !providerKeyPresent(spec.provider)) return undefined;
	try {
		return piEngineForSpec(spec, false);
	} catch {
		return undefined;
	}
}

interface RecapGlobal {
	__lhRecapShared?: RecapShared;
}
const g = globalThis as typeof globalThis & RecapGlobal;

/** The wired service the route uses. */
export const recapService = createRecapService({
	getChat: (chatId) => stores.chatStore.getChat(chatId),
	recapStore,
	readSettings: () => stores.settingsStore.readSettings(),
	// Learner-triggered, so a foreground engine (not a background run).
	engine: () => {
		const spec = resolveRoleSpec("recapWriter", stores.settingsStore.readSettings());
		return spec ? piEngineForSpec(spec, false) : undefined;
	},
	providerKeyMissing: (provider) => !providerKeyPresent(provider),
	figureEngine: () => optionalEngine("figureFinder"),
	diagramEngine: () => optionalEngine("visualMaker"),
	readFigure: (chatId, file) => readSessionFigure(chatId, file),
	syncNow: () => obsidianSync.run(),
	recapPath: (chatId) => obsidianSync.recapPath(chatId),
	now: () => new Date(),
	shared: (g.__lhRecapShared ??= { run: null, controller: null }),
});
