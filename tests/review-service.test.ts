/**
 * Review mode, the service (medical fork): asking for one script, the do-all
 * run (progress, stop, skip up-to-date, failures), images, and the whole
 * trip into a real temp vault with the live Obsidian copy. The writer is a
 * fake; nothing here calls a model.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { HeadlessApi } from "../src/agent/subagents/headless.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { ScriptwriterInput, ScriptwriterResult } from "../src/agent/subagents/scriptwriter.ts";
import type { CatalogueIllness, GraphChain, GraphNode } from "../src/core/contracts.ts";
import { SCRIPT_SECTIONS } from "../src/core/contracts.ts";
import { newSeenSources, seenPageKey, validateDraft, type RawScriptDraft } from "../src/core/illness-script.ts";
import { DEFAULT_MY_NOTES } from "../src/core/obsidian.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../src/core/settings.ts";
import { MAX_CONSECUTIVE_FAILURES, createReviewService, safeSvg, type ReviewShared } from "../src/server/review.ts";
import { createObsidianSync, newSyncState } from "../src/server/obsidian.ts";
import { createVault } from "../src/store/obsidian-vault.ts";
import { createReviewStore } from "../src/store/review.ts";

const T0 = "2026-11-05T08:00:00.000Z";
const node = (id: string, name: string, over: Partial<GraphNode> = {}): GraphNode => ({
	id,
	name,
	statement: `${name} is true.`,
	aliases: [],
	createdAt: "2026-10-01T00:00:00.000Z",
	provenance: [],
	...over,
});
const chain = (id: string, premises: string[], conclusion: string): GraphChain => ({ id, premises, conclusion, provenance: [], createdAt: "2026-10-01T00:00:00.000Z" });

const ENGINE = { model: { provider: "openai-codex", id: "fake" }, streamFn: () => undefined } as unknown as PiEngine;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);

let dir: string;
let vaultDir: string;
let setups = 0;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-review-"));
	vaultDir = path.join(dir, "vault");
	fs.mkdirSync(vaultDir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

interface Options {
	vault?: string | null;
	engine?: () => PiEngine | undefined;
	keyMissing?: boolean;
	illnesses?: CatalogueIllness[];
	/** Called inside the fake writer; may return a promise to hold the run open. */
	onWrite?: (title: string, signal: AbortSignal | undefined) => Promise<void> | void;
	diagram?: string | null;
}

function setup(opts: Options = {}) {
	let nodes: GraphNode[] = [
		node("n_gall", "Gallstones block the pancreatic duct", { systems: ["gi"] }),
		node("n_amy", "Serum amylase rises", { systems: ["gi"] }),
		node("n_ins", "Insulin binds its receptor", { systems: ["endocrine"] }),
	];
	let chains: GraphChain[] = [chain("arg_1", ["n_gall"], "n_amy")];
	const graphStore = { readNodes: () => nodes.map((n) => structuredClone(n)), readChains: () => chains.map((c) => structuredClone(c)), readSources: () => [] };
	const reviewStore = createReviewStore(path.join(dir, `review-${++setups}`));
	const vaultPath = opts.vault === undefined ? vaultDir : opts.vault;
	const settings = () => (vaultPath ? { version: 1, obsidian: { vaultPath } } : null);
	const obsidian = createObsidianSync({
		readSettings: settings,
		graphStore,
		reviewStore,
		makeVault: createVault,
		revision: () => 1,
		now: () => new Date(),
		suggest: () => null,
		setTimer: (() => 0) as never,
		clearTimer: () => {},
		state: newSyncState(),
	});
	const written: string[] = [];
	const rendered: Array<{ path: string; pages: number[] }> = [];
	const headless = {
		available: () => true,
		unavailableReason: () => null,
		runDemo: async () => ({ ok: true, consoleErrors: [], pageErrors: [], failedRequests: [] }),
		renderSvg: async () => PNG,
		renderPdfPages: async (p: string, pages: number[]) => (rendered.push({ path: p, pages }), pages.map((page) => ({ page, png: PNG }))),
	} as HeadlessApi;
	const illnesses = opts.illnesses ?? [
		{ title: "Acute pancreatitis", aliases: [], nodeIds: ["n_gall", "n_amy"] },
		{ title: "Diabetes mellitus", aliases: [], nodeIds: ["n_ins", "n_amy"] },
		{ title: "Cholecystitis", aliases: [], nodeIds: ["n_gall", "n_amy"] },
	];
	let listed = 0;
	const shared: ReviewShared = { run: null, controller: null };
	const service = createReviewService({
		graphStore,
		reviewStore,
		verifyStore: { listItems: () => [], getItem: () => null },
		libraryStore: { listBooks: () => [], pdfPath: (id: string) => `/lib/${id}/source.pdf` },
		libraryReader: undefined,
		readSettings: settings,
		engine: opts.engine ?? (() => ENGINE),
		diagramEngine: () => (opts.diagram === undefined ? undefined : ENGINE),
		providerKeyMissing: () => opts.keyMissing === true,
		headless: () => headless,
		onSaved: () => void obsidian.run(),
		now: () => new Date(T0),
		runScriptwriter: async (input: ScriptwriterInput): Promise<ScriptwriterResult> => {
			await opts.onWrite?.(input.illness, input.signal);
			if (input.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
			written.push(input.illness);
			const seen = newSeenSources();
			seen.nodes.set("n_gall", { id: "n_gall", name: "Gallstones block the pancreatic duct" });
			seen.pages.set(seenPageKey("bk_lec", 12), { bookId: "bk_lec", title: "Pancreas lecture", kind: "slidescribe", page: 12 });
			const raw: RawScriptDraft = {
				title: input.illness,
				sections: SCRIPT_SECTIONS.map((s) => ({
					id: s.id,
					claims: [{ text: `${s.title} of ${input.illness}.`, graph: ["n_gall"], ...(s.id === "management" ? { library: [{ book: "Pancreas lecture", page: 12 }] } : {}) }],
					...(s.id === "pathophysiology" ? { images: [{ book: "Pancreas lecture", page: 12, caption: "The cascade" }], diagrams: [{ brief: "Draw the cascade", caption: "Cascade" }] } : {}),
				})),
			};
			const checked = validateDraft(raw, seen);
			assert.ok(checked.ok, checked.ok ? "" : checked.problems.join());
			return { draft: checked.draft, seen, usage: { calls: 2, inputTokens: 10, outputTokens: 5 } };
		},
		listIllnesses: async () => (listed++, illnesses),
		makeDiagram: async () => {
			if (opts.diagram === null) throw new Error("no picture");
			return opts.diagram ?? "";
		},
		shared,
	});
	return {
		service,
		reviewStore,
		obsidian,
		written,
		rendered,
		listed: () => listed,
		setNodes: (n: GraphNode[]) => void (nodes = n),
		setChains: (c: GraphChain[]) => void (chains = c),
		nodes: () => nodes,
		appFile: (rel: string) => path.join(vaultDir, "LearnHarness", rel),
	};
}

const ok = (o: { ok: boolean }): void => assert.ok(o.ok, JSON.stringify(o));

describe("asking for one illness script", () => {
	it("writes the script into the vault, with its images, and reports it in the status", async () => {
		const t = setup({ diagram: "<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'></svg>" });
		const started = t.service.writeOne("  acute   Pancreatitis ");
		ok(started);
		assert.equal(t.service.status().run?.running, true);
		await t.service.idle();

		const status = t.service.status();
		assert.equal(status.run?.running, false);
		assert.equal(status.run?.written, 1);
		assert.match(status.run?.message ?? "", /Wrote the script for acute Pancreatitis|Wrote the script for/);
		assert.deepEqual(status.scripts.map((s) => [s.slug, s.freshness]), [["acute-pancreatitis", "current"]]);

		const note = fs.readFileSync(t.appFile("Illness scripts/acute Pancreatitis (illness script).md"), "utf-8");
		assert.match(note, /^## Management$/m);
		assert.match(note, /!\[\[acute-pancreatitis--bk_lec-p12\.png\|560\]\]/);
		assert.match(note, /!\[\[acute-pancreatitis--diagram-1\.svg\|560\]\]/);
		assert.match(note, /Pancreas lecture, slide 12/);
		assert.deepEqual(fs.readFileSync(t.appFile("Attachments/acute-pancreatitis--bk_lec-p12.png")), PNG);
		assert.match(fs.readFileSync(t.appFile("Attachments/acute-pancreatitis--diagram-1.svg"), "utf-8"), /<svg/);
		assert.deepEqual(t.rendered, [{ path: "/lib/bk_lec/source.pdf", pages: [12] }], "the page is rendered from the library's own PDF copy");
	});

	it("keeps the learner's My notes when the script is written again", async () => {
		const t = setup();
		ok(t.service.writeOne("acute pancreatitis"));
		await t.service.idle();
		const file = t.appFile("Illness scripts/acute pancreatitis (illness script).md");
		fs.writeFileSync(file, fs.readFileSync(file, "utf-8").replace(DEFAULT_MY_NOTES, "## My notes\n\nAsk about Ranson on the ward.\n"));
		ok(t.service.writeOne("Acute pancreatitis"));
		await t.service.idle();
		assert.equal(t.written.length, 2);
		assert.match(fs.readFileSync(file, "utf-8"), /Ask about Ranson on the ward\./);
	});

	it("skips a page image it cannot render and a diagram that is not clean, but still saves the script", async () => {
		const t = setup({ diagram: "<svg><script>alert(1)</script></svg>" });
		ok(t.service.writeOne("acute pancreatitis"));
		await t.service.idle();
		const script = t.reviewStore.getScript("acute-pancreatitis")!;
		assert.deepEqual(script.sections.flatMap((s) => s.images.map((i) => i.kind)), ["page"]);
		assert.equal(safeSvg("<svg><script/></svg>"), false);
		assert.equal(safeSvg("<svg onload='x()'></svg>"), false);
		assert.equal(safeSvg("<svg></svg>"), true);
	});

	it("needs a vault, a model and a sign-in before it spends anything", async () => {
		const noVault = setup({ vault: null });
		const refused = noVault.service.writeOne("acute pancreatitis");
		assert.ok(!refused.ok && refused.status === 409 && refused.code === "no_vault");
		assert.equal(noVault.written.length, 0);

		const missing = setup({ vault: path.join(dir, "nope") });
		const gone = missing.service.writeOne("acute pancreatitis");
		assert.ok(!gone.ok && gone.code === "vault_problem" && /doesn't exist/.test(gone.error));

		assert.throws(() => setup({ engine: () => undefined }).service.writeOne("acute pancreatitis"), ModelsNotConfiguredError);
		assert.throws(() => setup({ keyMissing: true }).service.writeOne("acute pancreatitis"), ProviderKeyMissingError);

		const bad = setup().service.writeOne("   ");
		assert.ok(!bad.ok && bad.status === 400);
		assert.ok(!setup().service.writeOne("x".repeat(200)).ok);
	});

	it("refuses a second run while one is going", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const t = setup({ onWrite: () => gate });
		ok(t.service.writeOne("acute pancreatitis"));
		const second = t.service.writeOne("cholecystitis");
		assert.ok(!second.ok && second.status === 409 && second.code === "review_busy");
		const all = t.service.writeAll();
		assert.ok(!all.ok && all.code === "review_busy");
		release();
		await t.service.idle();
		assert.deepEqual(t.written, ["acute pancreatitis"]);
	});

	it("reports a failed script plainly and saves nothing", async () => {
		const t = setup({
			onWrite: () => {
				throw new Error("The script writer finished without submitting a script.");
			},
		});
		ok(t.service.writeOne("acute pancreatitis"));
		await t.service.idle();
		const run = t.service.status().run!;
		assert.equal(run.written, 0);
		assert.deepEqual(run.failed, [{ title: "acute pancreatitis", error: "The script writer finished without submitting a script." }]);
		assert.match(run.message ?? "", /Couldn't write the script for acute pancreatitis/);
		assert.deepEqual(t.reviewStore.listScripts(), []);
		assert.ok(!fs.existsSync(t.appFile("Illness scripts")) || fs.readdirSync(t.appFile("Illness scripts")).length === 0);
	});
});

describe("writing a script for every illness", () => {
	it("goes one at a time with progress, and skips scripts that are already up to date", async () => {
		const progress: Array<[string | undefined, number, number]> = [];
		let t!: ReturnType<typeof setup>;
		t = setup({
			onWrite: () => {
				const r = t.service.status().run!;
				progress.push([r.current, r.written, r.skipped]);
			},
		});
		ok(t.service.writeOne("Acute pancreatitis"));
		await t.service.idle();
		progress.length = 0;
		t.written.length = 0;

		ok(t.service.writeAll());
		await t.service.idle();
		const run = t.service.status().run!;
		assert.equal(run.kind, "all");
		assert.equal(run.total, 3);
		assert.equal(run.written, 2);
		assert.equal(run.skipped, 1, "acute pancreatitis was already current");
		assert.deepEqual(t.written, ["Diabetes mellitus", "Cholecystitis"]);
		assert.deepEqual(progress, [["Diabetes mellitus", 0, 1], ["Cholecystitis", 1, 1]]);
		assert.match(run.message ?? "", /Done: 2 written, 1 already up to date/);
		assert.equal(t.service.status().scripts.length, 3);
	});

	it("reuses the illness list while the graph is unchanged and builds it again after a change", async () => {
		const t = setup();
		ok(t.service.writeAll());
		await t.service.idle();
		ok(t.service.writeAll());
		await t.service.idle();
		assert.equal(t.listed(), 1);
		assert.equal(t.service.status().catalogue?.outdated, false);
		t.setNodes([...t.nodes(), node("n_new", "A brand new note")]);
		assert.equal(t.service.status().catalogue?.outdated, true);
		ok(t.service.writeAll());
		await t.service.idle();
		assert.equal(t.listed(), 2);
	});

	it("can be stopped: the script in progress is dropped and the rest are not started", async () => {
		let t!: ReturnType<typeof setup>;
		let started = 0;
		t = setup({
			onWrite: async (_title, signal) => {
				started++;
				if (started === 2) {
					t.service.stop();
					assert.equal(t.service.status().run?.stopping, true);
					if (!signal?.aborted) await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
				}
			},
		});
		ok(t.service.writeAll());
		await t.service.idle();
		const run = t.service.status().run!;
		assert.equal(run.running, false);
		assert.equal(run.written, 1);
		assert.match(run.message ?? "", /Stopped\. 1 written/);
		assert.equal(started, 2, "the third was never started");
		assert.deepEqual(t.written, ["Acute pancreatitis"]);
		assert.equal(t.reviewStore.listScripts().length, 1, "the abandoned script was not saved");
	});

	it("keeps going after one failure, but gives up after several in a row", async () => {
		const one = setup({
			onWrite: (title) => {
				if (title === "Diabetes mellitus") throw new Error("boom");
			},
		});
		ok(one.service.writeAll());
		await one.service.idle();
		let run = one.service.status().run!;
		assert.equal(run.written, 2);
		assert.deepEqual(run.failed.map((f) => f.title), ["Diabetes mellitus"]);

		const many = setup({
			illnesses: ["A", "B", "C", "D", "E"].map((t) => ({ title: `Illness ${t}`, aliases: [], nodeIds: ["n_gall", "n_amy"] })),
			onWrite: () => {
				throw new Error("not signed in");
			},
		});
		ok(many.service.writeAll());
		await many.service.idle();
		run = many.service.status().run!;
		assert.equal(run.failed.length, MAX_CONSECUTIVE_FAILURES);
		assert.match(run.message ?? "", /Stopped after 3 failures in a row: not signed in/);
	});

	it("has nothing to do for an empty graph", async () => {
		const t = setup();
		t.setNodes([]);
		ok(t.service.writeAll());
		await t.service.idle();
		assert.match(t.service.status().run?.message ?? "", /graph is empty/);
		assert.equal(t.written.length, 0);
	});
});

describe("scripts after the graph changes", () => {
	it("are marked out of date in the app and in the note, never rewritten on their own", async () => {
		const t = setup();
		ok(t.service.writeOne("acute pancreatitis"));
		await t.service.idle();
		const file = t.appFile("Illness scripts/acute pancreatitis (illness script).md");
		assert.doesNotMatch(fs.readFileSync(file, "utf-8"), /Out of date/);
		assert.equal(t.service.status().scripts[0]!.freshness, "current");

		t.setNodes(t.nodes().map((n) => (n.id === "n_gall" ? { ...n, statement: "Gallstones lodge at the ampulla." } : n)));
		const status = t.service.status();
		assert.equal(status.scripts[0]!.freshness, "outdated");
		assert.match(status.scripts[0]!.reasons.join(), /1 note it was built from changed/);
		assert.equal(t.written.length, 1, "the writer was not called again");

		t.obsidian.run(); // the live copy's next pass
		assert.match(fs.readFileSync(file, "utf-8"), /> \[!warning\] Out of date/);
		assert.equal(t.written.length, 1);

		ok(t.service.writeOne("acute pancreatitis")); // the Refresh button
		await t.service.idle();
		assert.doesNotMatch(fs.readFileSync(file, "utf-8"), /Out of date/);
		assert.equal(t.service.status().scripts[0]!.freshness, "current");
	});

	it("dismiss clears a finished run's result only", async () => {
		const t = setup();
		ok(t.service.writeOne("acute pancreatitis"));
		await t.service.idle();
		assert.ok(t.service.status().run);
		assert.equal(t.service.clearResult().run, null);
	});
});

describe("script notes in the vault", () => {
	it("two scripts that would share a file name each get their own note", async () => {
		const t = setup();
		ok(t.service.writeOne("Crohn's disease"));
		await t.service.idle();
		ok(t.service.writeOne("Crohns disease"));
		await t.service.idle();
		const files = fs.readdirSync(t.appFile("Illness scripts")).sort();
		assert.equal(files.length, 2, files.join());
		assert.notEqual(files[0], files[1]);
	});

	it("a node cannot take a script's file name", async () => {
		const t = setup();
		t.setNodes([...t.nodes(), node("n_same", "Gout (illness script)")]);
		ok(t.service.writeOne("Gout"));
		await t.service.idle();
		assert.ok(fs.existsSync(t.appFile("Illness scripts/Gout (illness script).md")));
		assert.ok(fs.existsSync(t.appFile("Nodes/Gout (illness script) (same).md")), fs.readdirSync(t.appFile("Nodes")).join());
	});
});
