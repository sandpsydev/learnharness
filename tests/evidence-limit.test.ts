/**
 * The evidence budget (medical fork): the teacher may start at most
 * EVIDENCE_LIMITS.researchJobs web research jobs and queue at most
 * EVIDENCE_LIMITS.expertAiQuestions Expert AI questions per LEARNER message.
 * Fakes only — no model, no web, no Expert AI, no app data.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-evidence-"));
process.env.LH_DATA_DIR = TMP_DATA;
after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const { EVIDENCE_LIMITS, RESEARCH_LIMIT_NOTE, evidenceBudgetFor } = await import("../src/agent/evidence-budget.ts");
const { jobTools } = await import("../src/agent/tools/jobs.ts");
const { verifyTools } = await import("../src/agent/tools/verify.ts");
const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { createFauxCore } = await import("@earendil-works/pi-ai");

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { JobRecord } from "../src/core/contracts.ts";
import type { ChatStore, JobStore, VerifyStore } from "../src/core/ports.ts";

type ToolResult = { details?: unknown; isError?: boolean };

// ─── fakes ───────────────────────────────────────────────────────────────────

function fakeJobStore(): JobStore & { all: JobRecord[] } {
	const all: JobRecord[] = [];
	return {
		all,
		createJob(init) {
			const job = { id: `job_${all.length + 1}`, kind: init.kind, chatId: init.chatId, toolCallId: init.toolCallId, status: "running" } as JobRecord;
			all.push(job);
			return job;
		},
		getJob: (id) => all.find((j) => j.id === id) ?? null,
		updateJob: () => null,
		listJobs: () => all,
		findJobByToolCallId: (_chatId, toolCallId) => all.find((j) => j.toolCallId === toolCallId) ?? null,
		deleteJobsForChat: () => 0,
	};
}

function fakeVerifyStore(): VerifyStore & { prompts: string[] } {
	const prompts: string[] = [];
	const item = (prompt: string, i: number) => ({ id: `v${i}`, chatId: "c", status: "queued", prompt }) as never;
	return {
		prompts,
		listItems: () => prompts.map(item),
		addItems: (_chatId: string, items: Array<{ prompt: string }>) =>
			items.map((q) => {
				prompts.push(q.prompt);
				return item(q.prompt, prompts.length);
			}),
	} as unknown as VerifyStore & { prompts: string[] };
}

const OVERVIEW_TOPICS = ["axillary surgery", "post-mastectomy radiotherapy", "contraindications to breast conservation", "neoadjuvant by subtype", "endocrine and HER2 therapy"];

const question = (i: number) => ({
	prompt: `A woman in her fifties with early breast cancer, question ${i}: what is the guideline basis for the management choice and the evidence behind it?`,
});

function research(tools: ReturnType<typeof jobTools>, id: string, topic = "axillary surgery"): Promise<ToolResult> {
	return tools.research!.execute!(id, { question: `ESMO / NCCN: ${topic}` } as never) as Promise<ToolResult>;
}

function queue(tools: ReturnType<typeof verifyTools>, id: string, n: number): Promise<ToolResult> {
	return tools.verify_queue!.execute!(id, { questions: Array.from({ length: n }, (_, i) => question(i + 1)) } as never) as Promise<ToolResult>;
}

function verifyWith(store: VerifyStore, evidence?: ReturnType<typeof evidenceBudgetFor>) {
	return verifyTools({ chatId: "c", verifyStore: store, searchStatus: () => ({ available: true, engine: "tavily", reason: "" }) as never, extensionLastSeen: () => null, evidence });
}

// ─── transcript builders ─────────────────────────────────────────────────────

const user = (text: string): AgentMessage => ({ id: `u_${text}`, role: "user", content: text, timestamp: 1 }) as never;
const steer = (jobId: string): AgentMessage =>
	({ id: `steer_${jobId}`, role: "custom", customType: "subagent-steer", content: "research brief", display: true, details: {}, timestamp: 2 }) as never;
const callOf = (id: string, name: string, args: unknown): AgentMessage =>
	({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], timestamp: 3 }) as never;
const resultOf = (toolCallId: string, toolName: string, details: unknown, isError = false): AgentMessage =>
	({ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "ok" }], details, isError, timestamp: 4 }) as never;

/** What the transcript looks like after the teacher spent its research allowance. */
function spentResearch(n: number): AgentMessage[] {
	return Array.from({ length: n }, (_, i) => [callOf(`r${i}`, "research", { question: "q" }), resultOf(`r${i}`, "research", `Dispatched (job job_${i})`)]).flat();
}

// ─── the limits ──────────────────────────────────────────────────────────────

describe("the named limits", () => {
	it("are the plain-English defaults: 2 research jobs and 2 Expert AI questions per learner message", () => {
		assert.equal(EVIDENCE_LIMITS.researchJobs, 2);
		assert.equal(EVIDENCE_LIMITS.expertAiQuestions, 2);
	});
});

describe("research jobs per learner message", () => {
	it("under the limit, every call starts a job", async () => {
		const jobStore = fakeJobStore();
		const spawned: JobRecord[] = [];
		const tools = jobTools({ chatId: "c", jobStore, spawn: (job) => void spawned.push(job), evidence: evidenceBudgetFor([user("basic overview of breast cancer")]) });
		for (let i = 0; i < EVIDENCE_LIMITS.researchJobs; i++) {
			const out = await research(tools, `r${i}`);
			assert.match(String(out.details), /^Dispatched \(job job_/);
		}
		assert.equal(spawned.length, EVIDENCE_LIMITS.researchJobs);
	});

	it("the owner's overview request: 5 research calls start 2 jobs, the other 3 start nothing and return the note", async () => {
		const jobStore = fakeJobStore();
		const spawned: JobRecord[] = [];
		const tools = jobTools({ chatId: "c", jobStore, spawn: (job) => void spawned.push(job), evidence: evidenceBudgetFor([user("basic overview of breast cancer")]) });
		const outs: ToolResult[] = [];
		for (const [i, topic] of OVERVIEW_TOPICS.entries()) outs.push(await research(tools, `r${i}`, topic));
		assert.equal(spawned.length, 2, "only the first two jobs ever start");
		assert.equal(jobStore.all.length, 2, "and only two job records exist");
		for (const out of outs.slice(0, 2)) assert.match(String(out.details), /^Dispatched/);
		for (const out of outs.slice(2)) {
			assert.equal(out.details, RESEARCH_LIMIT_NOTE);
			assert.ok(!out.isError, "guidance, not a failure — the teacher carries on teaching");
		}
		assert.match(RESEARCH_LIMIT_NOTE, /Nothing was started/);
		assert.match(RESEARCH_LIMIT_NOTE, /Teach from what you already have/);
		assert.match(RESEARCH_LIMIT_NOTE, /specific gap/);
	});

	it("a repeat of an already-started call is not a new job and does not use the allowance", async () => {
		const jobStore = fakeJobStore();
		const spawned: JobRecord[] = [];
		const tools = jobTools({ chatId: "c", jobStore, spawn: (job) => void spawned.push(job), evidence: evidenceBudgetFor([user("hi")]) });
		await research(tools, "r0");
		await research(tools, "r1");
		const again = await research(tools, "r1");
		assert.match(String(again.details), /^Dispatched \(job job_2\)/, "the existing job answers the repeat, even at the limit");
		assert.equal(spawned.length, 2);
	});

	it("the other job tools (demo, visual, figure, pdf) are not counted", async () => {
		const jobStore = fakeJobStore();
		const tools = jobTools({ chatId: "c", jobStore, spawn: () => {}, evidence: evidenceBudgetFor([user("x"), ...spentResearch(2)]) });
		const out = (await tools.demo!.execute!("d1", { title: "t", brief: "b" } as never)) as ToolResult;
		assert.match(String(out.details), /^Dispatched/);
		assert.equal(((await research(tools, "r9")) as ToolResult).details, RESEARCH_LIMIT_NOTE);
	});

	it("without a budget (prober, practice, bare contexts) nothing is limited", async () => {
		const jobStore = fakeJobStore();
		const tools = jobTools({ chatId: "c", jobStore, spawn: () => {} });
		for (let i = 0; i < 5; i++) await research(tools, `r${i}`);
		assert.equal(jobStore.all.length, 5);
	});
});

describe("Expert AI questions per learner message", () => {
	it("under the limit, the questions are queued", async () => {
		const store = fakeVerifyStore();
		const tools = verifyWith(store, evidenceBudgetFor([user("hi")]));
		const out = await queue(tools, "v1", EVIDENCE_LIMITS.expertAiQuestions);
		const d = out.details as { queued: unknown[]; notQueued?: unknown; limit?: unknown; reminder?: string };
		assert.equal(d.queued.length, 2);
		assert.equal(d.notQueued, undefined);
		assert.equal(d.limit, undefined);
		assert.match(d.reminder ?? "", /provisional/);
	});

	it("the owner's overview request: 6 questions queue the first 2 and say plainly that 4 were not", async () => {
		const store = fakeVerifyStore();
		const tools = verifyWith(store, evidenceBudgetFor([user("basic overview of breast cancer")]));
		const out = await queue(tools, "v1", 6);
		const d = out.details as { queued: Array<{ prompt: string }>; notQueued: string[]; limit: string };
		assert.equal(d.queued.length, 2);
		assert.deepEqual(store.prompts, [question(1).prompt, question(2).prompt], "the first questions, in order");
		assert.equal(d.notQueued.length, 4);
		assert.match(d.limit, /2 queued, 4 NOT queued/);
		assert.match(d.limit, /Teach from what you already have/);
	});

	it("once the allowance is used, a later call queues nothing and returns the note", async () => {
		const store = fakeVerifyStore();
		const tools = verifyWith(store, evidenceBudgetFor([user("hi")]));
		await queue(tools, "v1", 2);
		const out = await queue(tools, "v2", 3);
		const d = out.details as { queued: unknown[]; notQueued: unknown[]; limit: string; reminder?: string };
		assert.equal(d.queued.length, 0);
		assert.equal(d.notQueued.length, 3);
		assert.match(d.limit, /0 queued, 3 NOT queued/);
		assert.equal(d.reminder, undefined, "no provisional reminder when nothing was queued");
		assert.equal(store.prompts.length, 2, "nothing more reached the queue");
	});

	it("listing the queue and a bounced question never use the allowance", async () => {
		const store = fakeVerifyStore();
		const tools = verifyWith(store, evidenceBudgetFor([user("hi")]));
		await tools.verify_queue!.execute!("v0", {} as never);
		const bounced = (await tools.verify_queue!.execute!("v1", { questions: [{ prompt: "Patient HN 4521987, sepsis — which antibiotic first-line?" }] } as never)) as ToolResult;
		assert.equal(bounced.isError, true);
		const out = await queue(tools, "v2", 2);
		assert.equal((out.details as { queued: unknown[] }).queued.length, 2);
	});

	it("without a budget nothing is limited", async () => {
		const store = fakeVerifyStore();
		const out = await queue(verifyWith(store), "v1", 6);
		assert.equal((out.details as { queued: unknown[] }).queued.length, 6);
	});
});

describe("the counter resets with the next learner message — and only then", () => {
	it("job results waking the teacher do NOT reset it", async () => {
		const history = [user("overview please"), ...spentResearch(2), steer("job_0"), steer("job_1")];
		const tools = jobTools({ chatId: "c", jobStore: fakeJobStore(), spawn: () => {}, evidence: evidenceBudgetFor(history) });
		assert.equal((await research(tools, "later")).details, RESEARCH_LIMIT_NOTE);
	});

	it("the next learner message gives a fresh allowance", async () => {
		const history = [user("overview please"), ...spentResearch(2), steer("job_0"), user("go deeper on radiotherapy")];
		const jobStore = fakeJobStore();
		const tools = jobTools({ chatId: "c", jobStore, spawn: () => {}, evidence: evidenceBudgetFor(history) });
		assert.match(String((await research(tools, "a")).details), /^Dispatched/);
		assert.match(String((await research(tools, "b")).details), /^Dispatched/);
		assert.equal((await research(tools, "c")).details, RESEARCH_LIMIT_NOTE);
		assert.equal(jobStore.all.length, 2);
	});

	it("Expert AI questions already queued since the last learner message count; earlier ones do not", async () => {
		const queuedTurn = (id: string, n: number): AgentMessage[] => [
			callOf(id, "verify_queue", { questions: [] }),
			resultOf(id, "verify_queue", { queued: Array.from({ length: n }, (_, i) => ({ id: `${id}${i}` })) }),
		];
		const spent = verifyWith(fakeVerifyStore(), evidenceBudgetFor([user("a"), ...queuedTurn("q1", 2), steer("x")]));
		assert.equal(((await queue(spent, "v", 1)).details as { queued: unknown[] }).queued.length, 0);
		const fresh = verifyWith(fakeVerifyStore(), evidenceBudgetFor([user("a"), ...queuedTurn("q1", 2), user("b"), ...queuedTurn("q2", 1)]));
		assert.equal(((await queue(fresh, "v", 3)).details as { queued: unknown[] }).queued.length, 1, "one of the two was used since the last learner message");
	});

	it("a quiz answer is learner input and resets it", async () => {
		const quizAnswer = resultOf("quiz1", "quiz", {
			kind: "quiz",
			questionText: "Which?",
			dontKnow: false,
			answers: [{ text: "A" }],
			answeredAt: "2026-11-22T00:00:00.000Z",
		});
		const history = [user("overview"), ...spentResearch(2), callOf("quiz1", "quiz", {}), quizAnswer];
		const tools = jobTools({ chatId: "c", jobStore: fakeJobStore(), spawn: () => {}, evidence: evidenceBudgetFor(history) });
		assert.match(String((await research(tools, "a")).details), /^Dispatched/);
	});

	it("failed (invalid-input) calls in the transcript do not count", async () => {
		const history = [user("overview"), callOf("r0", "research", {}), resultOf("r0", "research", "bad input", true)];
		const tools = jobTools({ chatId: "c", jobStore: fakeJobStore(), spawn: () => {}, evidence: evidenceBudgetFor(history) });
		assert.match(String((await research(tools, "a")).details), /^Dispatched/);
		assert.match(String((await research(tools, "b")).details), /^Dispatched/);
	});
});

describe("the teacher agent wires the budget from the saved transcript", () => {
	function teacherTools(messages: AgentMessage[]) {
		const faux = createFauxCore({});
		const jobStore = fakeJobStore();
		const verifyStore = fakeVerifyStore();
		const agent = createTeacherAgent(
			{
				chatId: "c",
				chatStore: { getChat: () => null, saveMessages: () => {} } as unknown as ChatStore,
				jobStore,
				spawn: () => {},
				verify: { verifyStore, searchStatus: () => ({ available: true, engine: "tavily", reason: "" }) as never, extensionLastSeen: () => null },
			},
			{ engine: { model: faux.getModel(), streamFn: faux.streamSimple }, messages },
		);
		const byName = (name: string) => agent.state.tools.find((t) => t.name === name)!;
		return { byName, jobStore, verifyStore };
	}

	it("a fresh learner message: 5 research calls + 6 questions start 2 jobs and queue 2", async () => {
		const { byName, jobStore, verifyStore } = teacherTools([user("basic overview of breast cancer")]);
		for (const [i, topic] of OVERVIEW_TOPICS.entries()) await byName("research").execute(`r${i}`, { question: topic } as never);
		await byName("verify_queue").execute("v1", { questions: Array.from({ length: 6 }, (_, i) => question(i + 1)) } as never);
		assert.equal(jobStore.all.length, 2);
		assert.equal(verifyStore.prompts.length, 2);
	});

	it("woken by a job result after the allowance was spent, it is still limited", async () => {
		const { byName, jobStore } = teacherTools([user("overview"), ...spentResearch(2), steer("job_0")]);
		const out = (await byName("research").execute("late", { question: "more" } as never)) as ToolResult;
		assert.equal(out.details, RESEARCH_LIMIT_NOTE);
		assert.equal(jobStore.all.length, 0);
	});
});
