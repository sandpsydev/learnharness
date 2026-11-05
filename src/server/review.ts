/**
 * Review mode — the service (medical fork, docs/medical-spec.md "Obsidian
 * copy and Review mode"): writes illness scripts on request.
 *
 *   writeOne   the learner names one illness ("acute pancreatitis")
 *   writeAll   the do-all button: list the illnesses in the graph, then write
 *              a script for each, one at a time, skipping up-to-date ones
 *   stop       stops after cancelling the script in progress
 *
 * A script only ever gets written when asked (it spends the owner's ChatGPT
 * allowance): nothing here runs on its own. When the graph changes, an
 * existing script is merely MARKED out of date (its note says so, and the
 * Review panel offers Refresh).
 *
 * One run at a time, tracked on globalThis (Next dev gives each route its own
 * module instance). Progress is a plain state object the panel polls.
 */

import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { getHeadless, type HeadlessApi } from "../agent/subagents/headless.ts";
import {
	listIllnesses as realListIllnesses,
	runScriptwriter as realRunScriptwriter,
	type ScriptwriterInput,
	type ScriptwriterResult,
} from "../agent/subagents/scriptwriter.ts";
import { runVisualMaker } from "../agent/subagents/visual-maker.ts";
import type { LibraryReader } from "../agent/library/searcher.ts";
import type {
	CatalogueIllness,
	IllnessCatalogue,
	IllnessScript,
	ReviewPhase,
	ReviewRunState,
	ReviewStatus,
	ScriptImage,
	ScriptListItem,
	ScriptSection,
} from "../core/contracts.ts";
import { getGraph } from "../core/graph.ts";
import {
	buildBasis,
	collectSources,
	graphFingerprint,
	illnessTerms,
	scriptFreshness,
	scriptSlug,
	systemsOf,
	type ValidatedDraft,
} from "../core/illness-script.ts";
import type { GraphStore, LibraryStore, ReviewStore, VerifyStore } from "../core/ports.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError, ROLE_SLOT, type UserSettings } from "../core/settings.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { vaultProblem } from "../store/obsidian-vault.ts";
import { reviewStore } from "../store/review.ts";
import { providerKeyPresent } from "./keys.ts";
import { library } from "./library.ts";
import { obsidianSync } from "./obsidian.ts";
import { stores } from "./stores.ts";

/** Resolution of a library page rendered into a note: sharp enough to read slide text, small enough to keep a vault light. */
export const PAGE_IMAGE_DPI = 100;
/** One script is cut off after this long. */
export const SCRIPT_RUN_LIMIT_MS = 15 * 60_000;
/** Stop a do-all run after this many failures in a row (a broken sign-in fails every script). */
export const MAX_CONSECUTIVE_FAILURES = 3;

export type ReviewFailure = { ok: false; status: 400 | 409 | 422 | 503; code: string; error: string };
export type ReviewOutcome = ReviewFailure | { ok: true; status: ReviewStatus };

export interface ReviewDeps {
	graphStore: Pick<GraphStore, "readNodes" | "readChains">;
	reviewStore: ReviewStore;
	verifyStore: Pick<VerifyStore, "listItems" | "getItem">;
	libraryStore: Pick<LibraryStore, "listBooks" | "pdfPath">;
	libraryReader: LibraryReader | undefined;
	readSettings: () => UserSettings | null;
	/** The scriptwriter role's engine, or undefined when no model is configured. */
	engine: () => PiEngine | undefined;
	/** The visual-maker role's engine for app-drawn diagrams, or undefined to skip them. */
	diagramEngine: () => PiEngine | undefined;
	providerKeyMissing: (provider: string) => boolean;
	headless: () => HeadlessApi;
	/** Called after a script is saved, so the vault copy updates. */
	onSaved: () => void;
	now: () => Date;
	/** Test seams: the agent calls. */
	runScriptwriter?: (input: ScriptwriterInput) => Promise<ScriptwriterResult>;
	listIllnesses?: typeof realListIllnesses;
	makeDiagram?: (brief: string, engine: PiEngine, signal: AbortSignal | undefined) => Promise<string>;
	runLimitMs?: number;
	/** Shared run state (globalThis in production). */
	shared?: ReviewShared;
}

export interface ReviewShared {
	run: ReviewRunState | null;
	controller: AbortController | null;
}

const fail = (status: ReviewFailure["status"], code: string, error: string): ReviewFailure => ({ ok: false, status, code, error });

const isAbort = (err: unknown): boolean => err instanceof Error && err.name === "AbortError";

function titleCase(s: string): string {
	const t = s.replace(/\s+/g, " ").trim();
	return t === "" ? t : t[0]!.toUpperCase() + t.slice(1);
}

/** SVG from a model is shown through an <img>, which never runs scripts, but a clean file is still the rule. */
export function safeSvg(svg: string): boolean {
	return /<svg[\s>]/i.test(svg) && !/<script|<foreignObject|javascript:|\son\w+\s*=/i.test(svg);
}

export function createReviewService(deps: ReviewDeps) {
	const shared = deps.shared ?? { run: null, controller: null };
	const runScriptwriter = deps.runScriptwriter ?? realRunScriptwriter;
	const listIllnesses = deps.listIllnesses ?? realListIllnesses;

	// ── what the panel shows ──────────────────────────────────────────────

	function vaultState(): ReviewStatus["vault"] {
		const path = deps.readSettings()?.obsidian?.vaultPath;
		if (!path) return { configured: false };
		const problem = vaultProblem(path);
		return problem ? { configured: true, problem } : { configured: true };
	}

	function status(): ReviewStatus {
		const graph = getGraph(deps.graphStore);
		const scripts: ScriptListItem[] = deps.reviewStore.listScripts().map((s) => {
			const fresh = scriptFreshness(s, graph);
			return {
				slug: s.slug,
				title: s.title,
				generatedAt: s.generatedAt,
				freshness: fresh.freshness,
				reasons: fresh.reasons,
				claims: s.sections.reduce((n, sec) => n + sec.claims.length, 0),
				gaps: s.sections.reduce((n, sec) => n + sec.gaps.length, 0),
				images: s.sections.reduce((n, sec) => n + sec.images.length, 0),
			};
		});
		scripts.sort((a, b) => a.title.localeCompare(b.title));
		const catalogue = deps.reviewStore.readCatalogue();
		return {
			vault: vaultState(),
			scripts,
			catalogue: catalogue ? { count: catalogue.illnesses.length, builtAt: catalogue.builtAt, outdated: catalogue.graphFp !== graphFingerprint(graph.nodes) } : null,
			run: shared.run ? { ...shared.run, failed: [...shared.run.failed] } : null,
		};
	}

	// ── preconditions ─────────────────────────────────────────────────────

	function precondition(): ReviewFailure | { engine: PiEngine } {
		if (shared.run?.running) return fail(409, "review_busy", "Illness scripts are already being written — stop that run or wait for it to finish.");
		const vault = vaultState();
		if (!vault.configured) return fail(409, "no_vault", "Set your Obsidian vault folder in Settings → Obsidian first — scripts are written into it.");
		if (vault.problem) return fail(409, "vault_problem", vault.problem);
		const engine = deps.engine();
		if (!engine) throw new ModelsNotConfiguredError([ROLE_SLOT.scriptwriter]);
		if (deps.providerKeyMissing(engine.model.provider)) throw new ProviderKeyMissingError(engine.model.provider, [ROLE_SLOT.scriptwriter]);
		return { engine };
	}

	// ── writing one script ────────────────────────────────────────────────

	function setPhase(phase: ReviewPhase, current?: string): void {
		if (!shared.run) return;
		shared.run.phase = phase;
		if (current !== undefined) shared.run.current = current;
	}

	/** Page images and diagrams for a validated draft, as files plus the sections that embed them. */
	async function makeImages(slug: string, draft: ValidatedDraft, signal: AbortSignal | undefined): Promise<{ sections: ScriptSection[]; assets: Array<{ file: string; bytes: Uint8Array }> }> {
		const assets: Array<{ file: string; bytes: Uint8Array }> = [];
		const images = new Map<string, ScriptImage[]>();
		const add = (sectionId: string, image: ScriptImage): void => void images.set(sectionId, [...(images.get(sectionId) ?? []), image]);

		// Pages of the learner's own library, rendered from the library's own copy of the PDF.
		const done = new Set<string>();
		for (const req of draft.pageImages) {
			if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
			const file = `${slug}--${req.bookId}-p${req.page}.png`;
			if (!done.has(file)) {
				try {
					const [rendered] = await deps.headless().renderPdfPages(deps.libraryStore.pdfPath(req.bookId), [req.page], { dpi: PAGE_IMAGE_DPI });
					if (!rendered?.png?.byteLength) continue;
					assets.push({ file, bytes: new Uint8Array(rendered.png) });
					done.add(file);
				} catch (err) {
					console.warn(`[review] couldn't render ${req.label}:`, err);
					continue;
				}
			}
			add(req.sectionId, { kind: "page", file, caption: req.caption, source: { bookId: req.bookId, page: req.page, label: req.label } });
		}

		// Diagrams drawn by the visual-maker, when a vision model is set.
		const diagramEngine = draft.diagrams.length > 0 ? deps.diagramEngine() : undefined;
		let n = 0;
		for (const req of diagramEngine ? draft.diagrams : []) {
			if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
			try {
				const svg = deps.makeDiagram
					? await deps.makeDiagram(req.brief, diagramEngine!, signal)
					: (await runVisualMaker({ brief: req.brief }, { engine: diagramEngine, abortSignal: signal })).svg;
				if (!svg || !safeSvg(svg)) continue;
				const file = `${slug}--diagram-${++n}.svg`;
				assets.push({ file, bytes: new TextEncoder().encode(svg) });
				add(req.sectionId, { kind: "diagram", file, caption: req.caption });
			} catch (err) {
				if (isAbort(err)) throw err;
				console.warn("[review] a diagram couldn't be drawn:", err);
			}
		}
		return { sections: draft.sections.map((s) => ({ ...s, images: images.get(s.id) ?? [] })), assets };
	}

	async function writeScript(
		engine: PiEngine,
		illness: { title: string; aliases?: string[]; nodeIds?: string[] },
		signal: AbortSignal,
	): Promise<IllnessScript> {
		const slug = scriptSlug(illness.title);
		if (slug === "") throw new Error("That isn't an illness name.");
		const graph = getGraph(deps.graphStore);
		const byId = new Map(graph.nodes.map((n) => [n.id, n]));
		const startNodes = (illness.nodeIds ?? []).map((id) => byId.get(id)).filter((n) => n !== undefined);

		setPhase("gathering", illness.title);
		const result = await runScriptwriter({
			engine,
			graphStore: deps.graphStore,
			verifyStore: deps.verifyStore,
			library: deps.libraryReader,
			libraryTitles: deps.libraryStore.listBooks().filter((b) => b.status === "ready").map((b) => b.title),
			illness: illness.title,
			startNodes,
			signal,
		});

		setPhase("drawing");
		const { sections, assets } = await makeImages(slug, result.draft, signal);

		setPhase("saving");
		// The learner's name for it keeps the script's identity; the writer's title is used when it names the same thing.
		const title = scriptSlug(result.draft.title) === slug ? result.draft.title : titleCase(illness.title);
		const aliases = [...new Set([...(illness.aliases ?? []), ...result.draft.aliases])].filter((a) => a.toLowerCase() !== title.toLowerCase());
		const basisIds = new Set([...result.draft.nodeIds, ...startNodes.map((n) => n.id)]);
		const script: IllnessScript = {
			slug,
			title,
			aliases,
			systems: systemsOf(basisIds, byId),
			generatedAt: deps.now().toISOString(),
			sections,
			basis: buildBasis(basisIds, graph, illnessTerms(title, aliases)),
			sources: collectSources(sections, result.seen),
			usage: result.usage,
		};
		deps.reviewStore.putScript(script, assets);
		deps.onSaved();
		return script;
	}

	// ── runs ──────────────────────────────────────────────────────────────

	function begin(kind: ReviewRunState["kind"], total: number): { run: ReviewRunState; controller: AbortController } {
		const controller = new AbortController();
		const run: ReviewRunState = { kind, running: true, stopping: false, startedAt: deps.now().toISOString(), total, written: 0, skipped: 0, failed: [] };
		shared.run = run;
		shared.controller = controller;
		return { run, controller };
	}

	function finish(run: ReviewRunState, message?: string): void {
		run.running = false;
		run.finishedAt = deps.now().toISOString();
		delete run.current;
		delete run.phase;
		if (message) run.message = message;
		shared.controller = null;
	}

	/** One script under the per-script time limit and the run's stop signal. */
	async function guarded(engine: PiEngine, illness: Parameters<typeof writeScript>[1], runSignal: AbortSignal): Promise<IllnessScript> {
		const limit = AbortSignal.timeout(deps.runLimitMs ?? SCRIPT_RUN_LIMIT_MS);
		return writeScript(engine, illness, AbortSignal.any([runSignal, limit]));
	}

	const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

	async function runOne(engine: PiEngine, title: string, run: ReviewRunState, controller: AbortController): Promise<void> {
		try {
			const catalogue = deps.reviewStore.readCatalogue();
			const known = catalogue?.illnesses.find((i) => scriptSlug(i.title) === scriptSlug(title));
			const script = await guarded(engine, { title, ...(known ? { aliases: known.aliases, nodeIds: known.nodeIds } : {}) }, controller.signal);
			run.written++;
			finish(run, `Wrote the script for ${script.title}.`);
		} catch (err) {
			if (controller.signal.aborted) finish(run, "Stopped. Nothing was saved for the script in progress.");
			else {
				run.failed.push({ title, error: errorText(err) });
				finish(run, `Couldn't write the script for ${title}: ${errorText(err)}`);
			}
		}
	}

	async function runAll(engine: PiEngine, run: ReviewRunState, controller: AbortController): Promise<void> {
		try {
			setPhase("listing");
			const graph = getGraph(deps.graphStore);
			const fp = graphFingerprint(graph.nodes);
			let catalogue: IllnessCatalogue | null = deps.reviewStore.readCatalogue();
			if (!catalogue || catalogue.graphFp !== fp) {
				if (graph.nodes.length === 0) {
					finish(run, "Your graph is empty — there are no illnesses to write scripts for yet.");
					return;
				}
				const illnesses: CatalogueIllness[] = await listIllnesses({
					engine,
					graphStore: deps.graphStore,
					signal: controller.signal,
				});
				catalogue = { builtAt: deps.now().toISOString(), graphFp: fp, illnesses };
				deps.reviewStore.writeCatalogue(catalogue);
			}
			run.total = catalogue.illnesses.length;
			if (catalogue.illnesses.length === 0) {
				finish(run, "No illness in your graph has enough notes yet for a script.");
				return;
			}
			let streak = 0;
			for (const illness of catalogue.illnesses) {
				if (controller.signal.aborted) break;
				run.current = illness.title;
				const existing = deps.reviewStore.getScript(scriptSlug(illness.title));
				if (existing && scriptFreshness(existing, getGraph(deps.graphStore)).freshness === "current") {
					run.skipped++;
					continue;
				}
				try {
					await guarded(engine, illness, controller.signal);
					run.written++;
					streak = 0;
				} catch (err) {
					if (controller.signal.aborted) break;
					run.failed.push({ title: illness.title, error: errorText(err) });
					if (++streak >= MAX_CONSECUTIVE_FAILURES) {
						finish(run, `Stopped after ${MAX_CONSECUTIVE_FAILURES} failures in a row: ${errorText(err)}`);
						return;
					}
				}
			}
			if (controller.signal.aborted) {
				finish(run, `Stopped. ${run.written} written, ${run.skipped} already up to date.`);
			} else {
				finish(run, `Done: ${run.written} written, ${run.skipped} already up to date${run.failed.length > 0 ? `, ${run.failed.length} failed` : ""}.`);
			}
		} catch (err) {
			if (controller.signal.aborted) finish(run, "Stopped.");
			else finish(run, `The run stopped: ${errorText(err)}`);
		}
	}

	/** Ask for one illness's script. Returns at once; the run goes on in the background. */
	function writeOne(illness: unknown): ReviewOutcome {
		const title = typeof illness === "string" ? illness.replace(/\s+/g, " ").trim() : "";
		if (title === "" || title.length > 120 || scriptSlug(title) === "") return fail(400, "bad_request", "Say which illness, in a few words — for example “acute pancreatitis”.");
		const ready = precondition();
		if ("ok" in ready) return ready;
		const { run, controller } = begin("one", 1);
		run.current = title;
		void runOne(ready.engine, title, run, controller);
		return { ok: true, status: status() };
	}

	/** The do-all button. */
	function writeAll(): ReviewOutcome {
		const ready = precondition();
		if ("ok" in ready) return ready;
		const { run, controller } = begin("all", 0);
		void runAll(ready.engine, run, controller);
		return { ok: true, status: status() };
	}

	function stop(): ReviewOutcome {
		if (!shared.run?.running) return { ok: true, status: status() };
		shared.run.stopping = true;
		shared.run.message = "Stopping…";
		shared.controller?.abort();
		return { ok: true, status: status() };
	}

	/** Forget a finished run's result (the panel's dismiss). */
	function clearResult(): ReviewStatus {
		if (shared.run && !shared.run.running) shared.run = null;
		return status();
	}

	/** Wait for the current run to end (tests). */
	async function idle(): Promise<void> {
		for (let i = 0; i < 2000 && shared.run?.running; i++) await new Promise((r) => setTimeout(r, 5));
	}

	return { status, writeOne, writeAll, stop, clearResult, idle };
}

interface ReviewGlobal {
	__lhReviewShared?: ReviewShared;
}
const g = globalThis as typeof globalThis & ReviewGlobal;

/** The wired service the route uses. */
export const reviewService = createReviewService({
	graphStore: stores.graphStore,
	reviewStore,
	verifyStore: stores.verifyStore,
	libraryStore: stores.libraryStore,
	libraryReader: library.reader,
	readSettings: () => stores.settingsStore.readSettings(),
	// Learner-triggered, so a foreground engine (not a background run).
	engine: () => {
		const spec = resolveRoleSpec("scriptwriter", stores.settingsStore.readSettings());
		return spec ? piEngineForSpec(spec, false) : undefined;
	},
	diagramEngine: () => {
		const spec = resolveRoleSpec("visualMaker", stores.settingsStore.readSettings());
		if (!spec || !providerKeyPresent(spec.provider)) return undefined;
		try {
			return piEngineForSpec(spec, false);
		} catch {
			return undefined;
		}
	},
	providerKeyMissing: (provider) => !providerKeyPresent(provider),
	headless: getHeadless,
	onSaved: () => obsidianSync.notify(),
	now: () => new Date(),
	shared: (g.__lhReviewShared ??= { run: null, controller: null }),
});

