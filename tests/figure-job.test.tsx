/**
 * The `figure` job as a whole (medical fork) — zero network:
 *
 *   1. the job runner: dispatch input → finder → result → steer; the failure
 *      shapes (no model, no wiring) still steer, so the teacher learns the outcome
 *   2. the tool: server-executed ack, schema, who holds it (the teacher; not the
 *      prober or the practice agent), the settings toggle
 *   3. the lesson card: picture + caption + credit + licence + source link, links
 *      only, nothing found, failed; safe links; phone-width classes
 *   4. the picture route and the session cleanup
 *   5. the prompt rules
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React; // tsx classic-JSX shim (see render-cards.test.tsx)

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { Value } from "typebox/value";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { renderToStaticMarkup } from "react-dom/server";
import { PATHS } from "../config.ts";
import { GET as getFigure } from "../app/api/figures/[chatId]/[file]/route.ts";
import { ChatActionsContext } from "../components/chat.tsx";
import { FigureOutputCard } from "../components/artifacts/figure-card.tsx";
import { SubagentSteerCard } from "../components/artifacts/steer-card.tsx";
import type { PiEngine } from "../src/agent/models.ts";
import { composeInstructions } from "../src/agent/teacher-agent.ts";
import { figureKey, writeCachedFigure } from "../src/agent/figures/cache.ts";
import { figureModelOverride, createJobRunner } from "../src/agent/subagents/runner.ts";
import { createProberTools, createTeacherTools } from "../src/agent/tools.ts";
import { figureInputSchema, jobTools } from "../src/agent/tools/jobs.ts";
import { practiceTools } from "../src/agent/tools/practice.ts";
import {
	buildAbortSteer,
	buildSubagentSteer,
	isSubagentFailure,
	type FigureImage,
	type FigureResult,
	type SteerMessage,
} from "../src/core/contracts.ts";
import { projectView as projectNative } from "../src/core/view.ts";
import { TOGGLEABLE_TOOLS } from "../src/core/pending.ts";
import { ROLE_SLOT as SLOTS } from "../src/core/settings.ts";
import { deleteChatSession } from "../src/server/chats.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { PNG } from "./figure-fixtures.ts";

const createdChats: string[] = [];
const createdJobs: string[] = [];
after(() => {
	for (const id of createdJobs) jobStore.deleteJobsForChat(id);
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* already gone */
		}
		fs.rmSync(path.join(PATHS.figures, id), { recursive: true, force: true });
	}
});

function newChat(title: string): string {
	const chat = chatStore.createChat(title);
	createdChats.push(chat.id);
	createdJobs.push(chat.id);
	return chat.id;
}

function scripted(turns: Array<[string, unknown]>[]): PiEngine {
	const steps: FauxResponseStep[] = turns.map((calls, i) =>
		fauxAssistantMessage(
			calls.map(([name, input], j) => fauxToolCall(name, input as ToolCall["arguments"], { id: `fc_${i}_${j}` })),
			{ stopReason: "toolUse" },
		),
	);
	steps.push(fauxAssistantMessage("done"));
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

function testRunner(extra: Partial<Parameters<typeof createJobRunner>[0]> = {}) {
	const steers: SteerMessage[] = [];
	const runner = createJobRunner({
		chatStore,
		jobStore,
		deliver: async (steer) => {
			steers.push(steer);
			const jobId = (steer.details as { jobId: string }).jobId;
			const job = jobStore.getJob(jobId);
			if (job && job.status === "running") {
				const failed = job.result ? isSubagentFailure(job.kind, job.result as never) : true;
				jobStore.updateJob(jobId, { status: failed ? "error" : "done", activity: failed ? "failed" : "delivered" });
			}
		},
		...extra,
	});
	return { steers, runner };
}

const COMMONS_IMG = "https://upload.wikimedia.org/wikipedia/commons/thumb/8/81/Apical_pneumothorax.png/1000px-Apical_pneumothorax.png";
const fixture = (name: string): string => fs.readFileSync(path.join(import.meta.dirname, "fixtures", "figures", name), "utf-8");
const network: typeof fetch = (async (input: RequestInfo | URL) => {
	const url = String(input);
	if (url.startsWith("https://commons.wikimedia.org/w/api.php")) return new Response(fixture("commons-search.json"), { status: 200, headers: { "content-type": "application/json" } });
	if (url === COMMONS_IMG) return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
	throw new Error(`unrouted fetch: ${url}`);
}) as typeof fetch;

const headless = () => {
	throw new Error("no renderer needed");
};

describe("the figure job runner", () => {
	it("dispatch input → finder → saved result → steer the teacher can read", async () => {
		const chatId = newChat("Test: figure job");
		const job = jobStore.createJob({ kind: "figure", chatId, toolCallId: "call-fig-1", input: { concept: "left apical pneumothorax" } });
		figureModelOverride.current = scripted([
			[["commons_search", { query: "pneumothorax" }]],
			[["look", { id: "c1" }]],
			[["show_image", { id: "c1", shows: "A left apical pneumothorax.", key_feature: "the pleural line", confident: true }]],
		]);
		const { steers, runner } = testRunner({ figureEnv: () => ({ cacheRoot: PATHS.figures, fetchImpl: network, headless }) });
		try {
			await runner.runJob(job.id);
		} finally {
			figureModelOverride.current = undefined;
		}
		const saved = jobStore.getJob(job.id)!;
		assert.equal(saved.status, "done");
		const result = saved.result as FigureResult;
		assert.equal(result.outcome, "image");
		assert.equal(result.image?.licence, "CC BY-SA 4.0");
		assert.ok(fs.existsSync(path.join(PATHS.figures, chatId, result.image!.file)), "the picture is cached under the session");

		const steer = steers[0]!;
		assert.equal((steer.details as { kind: string }).kind, "figure");
		assert.match(steer.content as string, /real figure is now shown in the lesson/i);
		assert.match(steer.content as string, /Key feature to point at: the pleural line/);
		assert.equal(steer.id, `steer_${job.id}`);
	});

	it("a missing model still steers: the teacher learns no picture is coming", async () => {
		const chatId = newChat("Test: figure job without a model");
		const job = jobStore.createJob({ kind: "figure", chatId, toolCallId: "call-fig-2", input: { concept: "x" } });
		const { steers, runner } = testRunner({ engineFor: () => undefined, figureEnv: () => ({ cacheRoot: PATHS.figures, headless }) });
		await runner.runJob(job.id);
		assert.equal(jobStore.getJob(job.id)!.status, "error");
		assert.match(steers[0]!.content as string, /^Figure failed:/);
		assert.match(steers[0]!.content as string, /No picture is coming/);
		assert.match(steers[0]!.content as string, /do not draw it/);
	});

	it("without figure wiring the job fails honestly instead of guessing", async () => {
		const chatId = newChat("Test: figure job unwired");
		const job = jobStore.createJob({ kind: "figure", chatId, toolCallId: "call-fig-3", input: { concept: "x" } });
		figureModelOverride.current = scripted([]);
		const { steers, runner } = testRunner();
		try {
			await runner.runJob(job.id);
		} finally {
			figureModelOverride.current = undefined;
		}
		assert.match((jobStore.getJob(job.id)!.result as FigureResult).brief, /^Figure failed:/);
		assert.equal(steers.length, 1);
	});

	it("a request with no concept fails instead of searching for nothing", async () => {
		const chatId = newChat("Test: figure job empty");
		const job = jobStore.createJob({ kind: "figure", chatId, toolCallId: "call-fig-4", input: { concept: "  " } });
		figureModelOverride.current = scripted([]);
		const { runner } = testRunner({ figureEnv: () => ({ cacheRoot: PATHS.figures, headless }) });
		try {
			await runner.runJob(job.id);
		} finally {
			figureModelOverride.current = undefined;
		}
		assert.equal(jobStore.getJob(job.id)!.status, "error");
	});

	it("steer texts: a link-only or empty result tells the teacher what to do; an abort is acknowledged", () => {
		const links: FigureResult = {
			concept: "c",
			outcome: "link",
			caption: "",
			keyFeature: "",
			links: [{ title: "T", url: "https://www.nejm.org/x", source: "High-tier journal", note: "n" }],
			brief: "No picture is shown in the lesson (journal). Give the learner these links…",
		};
		const steer = buildSubagentSteer({ id: "j1", kind: "figure", toolCallId: "t" }, links);
		assert.equal(steer.content, links.brief);
		assert.equal(isSubagentFailure("figure", links), false);
		assert.equal(isSubagentFailure("figure", { ...links, brief: "Figure failed: boom" }), true);
		assert.match(buildAbortSteer({ id: "j1", kind: "figure", toolCallId: "t" }).content as string, /figure search was aborted/);
	});

	it("figure draws the vision slot's model (it looks at the candidates)", () => {
		assert.equal(SLOTS.figureFinder, "vision");
	});
});

describe("the figure tool", () => {
	it("is server-executed with a fire-and-forget ack and a tight schema", async () => {
		const chatId = newChat("Test: figure tool");
		const spawned: unknown[] = [];
		const tools = jobTools({ chatId, jobStore, spawn: (_job, input) => void spawned.push(input) });
		const ack = (await tools.figure!.execute!("call-fig-ack", { concept: "papilloedema on fundoscopy", modality: "fundus" } as never, undefined as never)) as { content: Array<{ text: string }> };
		assert.match(ack.content[0]!.text, /^Dispatched \(job /);
		assert.match(ack.content[0]!.text, /fire-and-forget/);
		assert.deepEqual(spawned, [{ concept: "papilloedema on fundoscopy", modality: "fundus" }]);
		assert.equal(Value.Check(figureInputSchema, { concept: "c" }), true);
		assert.equal(Value.Check(figureInputSchema, { modality: "m" }), false, "a concept is required");
		assert.match(String(tools.figure!.description), /never draws/);
	});

	it("is a teacher tool, toggleable in settings; not the prober's or the practice agent's", () => {
		const chatId = newChat("Test: figure registries");
		const base = { chatId, chatStore, jobStore, spawn: () => {} };
		assert.ok("figure" in createTeacherTools(base));
		assert.ok(!("figure" in createTeacherTools(base, { figure: false })), "the settings toggle removes it");
		assert.ok(!("figure" in createProberTools({ ...base, deliver: () => {} })));
		assert.ok(!("figure" in practiceTools({ chatId, chatStore, graphNodes: () => [], jobs: { chatId, jobStore, spawn: () => {} } } as never)));
		assert.ok((TOGGLEABLE_TOOLS as readonly string[]).includes("figure"));
	});
});

// ─── the card ────────────────────────────────────────────────────────────────

const image = (over: Partial<FigureImage> = {}): FigureImage => ({
	file: "0123456789abcdef01234567.png",
	mime: "image/png",
	tier: "commons",
	source: "Wikimedia Commons",
	sourceUrl: "https://commons.wikimedia.org/wiki/File:Apical_pneumothorax.png",
	title: "Apical pneumothorax.png",
	credit: "Jane Roe, via Wikimedia Commons",
	licence: "CC BY-SA 4.0",
	licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0",
	...over,
});

const imageResult = (over: Partial<FigureResult> = {}): FigureResult => ({
	concept: "left apical pneumothorax",
	outcome: "image",
	image: image(),
	caption: "Apical pneumothorax on CT and chest X-ray.",
	keyFeature: "the thin pleural line at the apex",
	links: [],
	brief: "A real figure is now shown…",
	...over,
});

const inChat = (node: React.ReactNode) => (
	<ChatActionsContext.Provider value={{ chatId: "chat_abc_123", syncFromServer: async () => {}, sendText: () => {}, openSetup: () => {} }}>{node}</ChatActionsContext.Provider>
);

describe("the figure card", () => {
	it("shows the picture with caption, key feature, credit, licence link and source link", () => {
		const html = renderToStaticMarkup(inChat(<FigureOutputCard output={imageResult()} />));
		assert.match(html, /src="\/api\/figures\/chat_abc_123\/0123456789abcdef01234567\.png"/);
		assert.match(html, /alt="Apical pneumothorax on CT and chest X-ray\."/);
		assert.match(html, /Apical pneumothorax on CT and chest X-ray\./);
		assert.match(html, /Look for: <\/span>the thin pleural line at the apex/);
		assert.match(html, /Jane Roe, via Wikimedia Commons/);
		assert.match(html, /href="https:\/\/creativecommons\.org\/licenses\/by-sa\/4\.0"[^>]*>CC BY-SA 4\.0/);
		assert.match(html, /href="https:\/\/commons\.wikimedia\.org\/wiki\/File:Apical_pneumothorax\.png"[^>]*>Apical pneumothorax\.png/);
		assert.ok(!html.includes("javascript:"));
	});

	it("works at phone width: the picture never exceeds the column and tall ones are capped", () => {
		const html = renderToStaticMarkup(inChat(<FigureOutputCard output={imageResult()} />));
		const img = /<img[^>]*>/.exec(html)![0];
		assert.match(img, /max-w-full/);
		assert.match(img, /h-auto/);
		assert.match(img, /max-h-\[75vh\]/);
		assert.match(html, /break-words/, "long credit lines wrap instead of overflowing");
	});

	it("a lecture slide shows the lecture name and no outside link", () => {
		const slide = imageResult({
			image: image({ tier: "slides", source: "Your lecture slides", sourceUrl: undefined, title: "Acute chest pain, slide 7", credit: "From your library: Acute chest pain", licence: "Your own lecture material", licenceUrl: undefined }),
		});
		const html = renderToStaticMarkup(inChat(<FigureOutputCard output={slide} />));
		assert.match(html, /Acute chest pain, slide 7/);
		assert.match(html, /From your library: Acute chest pain/);
		assert.match(html, /Your own lecture material/);
		assert.ok(!/<a [^>]*href="https:\/\/commons/.test(html));
	});

	it("link-only result lists each page with its one-line note; only https links are clickable", () => {
		const links: FigureResult = {
			concept: "c",
			outcome: "link",
			caption: "",
			keyFeature: "",
			links: [
				{ title: "Spontaneous pneumothorax", url: "https://www.nejm.org/doi/full/10.1056/NEJMicm1", source: "High-tier journal", note: "Look at the pleural line in panel A." },
				{ title: "Evil", url: "javascript:alert(1)", source: "x", note: "n" },
				{ title: "Plain http", url: "http://radiopaedia.org/x", source: "x", note: "n" },
			],
			brief: "…",
		};
		const html = renderToStaticMarkup(inChat(<FigureOutputCard output={links} />));
		assert.match(html, /link only/);
		assert.match(html, /href="https:\/\/www\.nejm\.org\/doi\/full\/10\.1056\/NEJMicm1"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
		assert.match(html, /Look at the pleural line in panel A\./);
		assert.ok(!html.includes("javascript:") && !html.includes("Plain http") && !html.includes("Evil"));
		assert.ok(!html.includes("<img"), "no picture for a link-only result");
	});

	it("nothing found and failed are quiet and honest", () => {
		const none = renderToStaticMarkup(inChat(<FigureOutputCard output={{ ...imageResult(), outcome: "none", image: undefined }} />));
		assert.match(none, /No figure found for/);
		const failed = renderToStaticMarkup(inChat(<FigureOutputCard output={{ ...imageResult(), outcome: "none", image: undefined, brief: "Figure failed: No model configured" }} />));
		assert.match(failed, /failed/);
		assert.match(failed, /No model configured/);
		assert.match(renderToStaticMarkup(<FigureOutputCard output={undefined} />), /could not be displayed/);
	});

	it("the delivered steer renders the card (and nothing of the model-facing text)", () => {
		const steer = buildSubagentSteer({ id: "jf", kind: "figure", toolCallId: "cf" }, imageResult());
		const html = renderToStaticMarkup(inChat(<SubagentSteerCard message={projectNative([steer])[0] as never} />));
		assert.match(html, /data-testid="figure-card"/);
		assert.ok(!html.includes("Teach with it"), "protocol glue stays out of the lesson");
	});
});

// ─── the route and the cleanup ───────────────────────────────────────────────

describe("the picture route", () => {
	const ctx = (chatId: string, file: string) => ({ params: Promise.resolve({ chatId, file }) });

	it("serves a cached picture with safe headers, and 404s anything that is not one", async () => {
		const chatId = newChat("Test: figure route");
		const key = figureKey("route-test", chatId);
		const written = writeCachedFigure(PATHS.figures, chatId, key, "image/png", PNG);
		const res = await getFigure(new Request("http://x/"), ctx(chatId, written.file));
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("content-type"), "image/png");
		assert.equal(res.headers.get("x-content-type-options"), "nosniff");
		assert.match(res.headers.get("content-security-policy") ?? "", /sandbox/);
		assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [...PNG]);

		for (const [c, f] of [
			[chatId, "ffffffffffffffffffffffff.png"],
			[chatId, "../../../etc/passwd"],
			[chatId, `${key}.svg`],
			["../chat_x_y", written.file],
			["chat_other_1", written.file],
		] as const) {
			assert.equal((await getFigure(new Request("http://x/"), ctx(c, f))).status, 404, `${c}/${f}`);
		}
	});

	it("deleting a session deletes its pictures", async () => {
		const chatId = newChat("Test: figure cleanup");
		writeCachedFigure(PATHS.figures, chatId, figureKey("cleanup", chatId), "image/png", PNG);
		assert.ok(fs.existsSync(path.join(PATHS.figures, chatId)));
		const outcome = await deleteChatSession(chatId, "preserve-graph");
		assert.equal(outcome.ok, true);
		assert.equal(fs.existsSync(path.join(PATHS.figures, chatId)), false);
	});
});

// ─── the prompt ──────────────────────────────────────────────────────────────

describe("the teacher's figure rules", () => {
	const teacher = composeInstructions("teacher");

	it("name the source order, the three outcomes, and the no-drawing rule", () => {
		for (const text of [
			"`figure`",
			"the learner's own lecture slides",
			"Radiopaedia",
			"copyrighted: link only",
			"point at the key feature",
			"Never \"as you can see\" about a picture that is not there",
			"Never draw anatomy or how anything looks",
		]) {
			assert.ok(teacher.includes(text), `missing: ${text}`);
		}
	});

	it("the prober does not hear about it", () => {
		const prober = composeInstructions("prober");
		assert.ok(!prober.includes("`figure`"));
	});
});
