/**
 * THE VERIFY LOOP end to end, with no network and no keys (medical fork):
 * the queue store, the teacher's verify_queue / evidence_sources tools, the
 * loopback API's guard and endpoints, answer delivery through the wake
 * pipeline (PubMed cross-check faked), highlights, and a real socket.
 *
 * Runs under an isolated LH_DATA_DIR (the seam is set before any
 * config-loading import, so every app-module import is dynamic).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-verify-"));
process.env.LH_DATA_DIR = TMP_DATA;
delete process.env.LH_EXTENSION_ORIGIN;
delete process.env.LH_VERIFY_TOKEN;

const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { verifyStore } = await import("../src/store/verify.ts");
const { verifyTools } = await import("../src/agent/tools/verify.ts");
const { createTeacherTools } = await import("../src/agent/tools.ts");
const { composeInstructions } = await import("../src/agent/teacher-agent.ts");
const verifyServer = await import("../src/server/verify.ts");
const api = await import("../src/server/verify-api.ts");
const { setTurnRunner, discardChatDeliveries } = await import("../src/server/jobs.ts");
const { steerDelivered } = await import("../src/core/contracts.ts");

type ToolResult = { details?: unknown; isError?: boolean; content: Array<{ type: string; text?: string }> };

const TOKEN = "t".repeat(64);
const PORT = 47615;
const EXT = `chrome-extension://${"a".repeat(32)}`;
const created: string[] = [];

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});
afterEach(() => {
	for (const id of created.splice(0)) discardChatDeliveries(id);
});

function newChat(title = "Test: verify", kind?: "practice"): string {
	const chat = chatStore.createChat(title, kind);
	chatStore.saveMessages(chat.id, [{ id: "u1", role: "user", content: "teach me", timestamp: 1 } as never]);
	created.push(chat.id);
	return chat.id;
}

function toolCtx(chatId: string, over: { search?: { available: boolean; engine: "tavily" | null; reason: string }; seen?: string | null } = {}) {
	return {
		chatId,
		verifyStore,
		searchStatus: () => over.search ?? { available: false, engine: null, reason: "no search engine configured — set a Tavily or Brave search API key" },
		extensionLastSeen: () => over.seen ?? null,
	};
}

const GOOD_PROMPT =
	"A man in his late fifties with HFrEF (EF 30%) on an ACE inhibitor and beta-blocker, K 4.4, eGFR 55. What is the guideline basis for adding an MRA, and what monitoring is needed?";

async function run(tool: { execute?: (...a: never[]) => unknown } | undefined, input: unknown): Promise<ToolResult> {
	return (await (tool!.execute as (id: string, input: unknown) => Promise<ToolResult>)("call-1", input)) as ToolResult;
}

// ─── the store ───────────────────────────────────────────────────────────────

describe("VerifyStore", () => {
	it("adds, dedupes an identical open prompt, lists oldest first, updates, and dies with its chat", () => {
		const chatId = newChat();
		const [a, b] = verifyStore.addItems(chatId, [{ prompt: "Q1", provisionalClaim: "claim 1" }, { prompt: "Q2" }]);
		assert.equal(a?.status, "queued");
		assert.equal(a?.provisionalClaim, "claim 1");
		const again = verifyStore.addItems(chatId, [{ prompt: "Q1" }]);
		assert.equal(again[0]?.id, a?.id, "an identical queued prompt is not duplicated");
		assert.deepEqual(verifyStore.listItems({ chatId }).map((i) => i.prompt), ["Q1", "Q2"]);

		verifyStore.updateItem(b!.id, { status: "dismissed" });
		assert.deepEqual(verifyStore.listItems({ chatId, status: ["queued"] }).map((i) => i.prompt), ["Q1"]);
		const reopened = verifyStore.addItems(chatId, [{ prompt: "Q2" }]);
		assert.notEqual(reopened[0]?.id, b?.id, "a dismissed prompt can be queued afresh");

		assert.ok(verifyStore.deleteForChat(chatId) >= 3);
		assert.deepEqual(verifyStore.listItems({ chatId }), []);
	});

	it("survives a missing or corrupt file", () => {
		fs.mkdirSync(path.join(TMP_DATA, "verify"), { recursive: true });
		fs.writeFileSync(path.join(TMP_DATA, "verify", "items.json"), "{not json");
		assert.deepEqual(verifyStore.listItems(), []);
		const chatId = newChat();
		assert.equal(verifyStore.addItems(chatId, [{ prompt: "after corruption" }]).length, 1);
	});
});

// ─── the teacher's tools ─────────────────────────────────────────────────────

describe("verify_queue (the teacher's Expert AI queue)", () => {
	it("queues self-contained questions with the provisional claim and reminds the teacher what to do", async () => {
		const chatId = newChat();
		const { verify_queue } = verifyTools(toolCtx(chatId));
		const out = await run(verify_queue, { questions: [{ prompt: GOOD_PROMPT, claim: "Add an MRA at EF ≤ 35%." }] });
		const d = out.details as { queued: Array<{ id: string; claim?: string }>; reminder: string; queue: unknown[] };
		assert.equal(d.queued.length, 1);
		assert.equal(d.queued[0]?.claim, "Add an MRA at EF ≤ 35%.");
		assert.match(d.reminder, /provisional/);
		assert.match(d.reminder, /nothing waits/);
		assert.equal(verifyStore.listItems({ chatId }).length, 1);
	});

	it("with no questions it lists the queue", async () => {
		const chatId = newChat();
		const { verify_queue } = verifyTools(toolCtx(chatId));
		await run(verify_queue, { questions: [{ prompt: GOOD_PROMPT }] });
		const out = await run(verify_queue, {});
		assert.equal((out.details as { queue: unknown[] }).queue.length, 1);
	});

	it("bounces a prompt carrying an identifier, telling the teacher to rewrite it generically", async () => {
		const chatId = newChat();
		const { verify_queue } = verifyTools(toolCtx(chatId));
		const out = await run(verify_queue, { questions: [{ prompt: "Patient HN 4521987, sepsis — which antibiotic first-line?" }] });
		assert.equal(out.isError, true);
		assert.match(out.content[0]!.text!, /Rewrite it generic/);
		assert.deepEqual(verifyStore.listItems({ chatId }), [], "nothing was queued");
	});

	it("a mixed batch queues the clean question and reports the rejected one", async () => {
		const chatId = newChat();
		const { verify_queue } = verifyTools(toolCtx(chatId));
		const out = await run(verify_queue, { questions: [{ prompt: GOOD_PROMPT }, { prompt: "Mr Somchai with AF — anticoagulate?" }] });
		const d = out.details as { queued: unknown[]; rejected: Array<{ problems: string[] }> };
		assert.equal(d.queued.length, 1);
		assert.equal(d.rejected.length, 1);
		assert.equal(verifyStore.listItems({ chatId }).length, 1);
	});
});

describe("evidence_sources (honest routing)", () => {
	it("says plainly that web search is OFF when no key is set, and that the extension has not connected", async () => {
		const chatId = newChat();
		const { evidence_sources } = verifyTools(toolCtx(chatId));
		const d = (await run(evidence_sources, {})).details as {
			webSearch: { available: boolean; reason: string };
			expertAi: { extensionLastSeen: string | null; note: string };
			literature: { available: boolean };
		};
		assert.equal(d.webSearch.available, false);
		assert.match(d.webSearch.reason, /Web search is OFF/);
		assert.match(d.webSearch.reason, /Tavily or Brave search API key/);
		assert.equal(d.expertAi.extensionLastSeen, null);
		assert.match(d.expertAi.note, /has not contacted the app/);
		assert.equal(d.literature.available, true);
	});

	it("reports a live engine and a connected extension", async () => {
		const chatId = newChat();
		const { evidence_sources } = verifyTools(
			toolCtx(chatId, { search: { available: true, engine: "tavily", reason: "search engine: tavily (auto)" }, seen: "2026-10-29T08:00:00.000Z" }),
		);
		const d = (await run(evidence_sources, {})).details as { webSearch: { available: boolean }; expertAi: { extensionLastSeen: string } };
		assert.equal(d.webSearch.available, true);
		assert.equal(d.expertAi.extensionLastSeen, "2026-10-29T08:00:00.000Z");
	});
});

describe("teacher wiring", () => {
	it("the registry holds the Expert AI tools only when the composition root supplies them; literature tools are always on", () => {
		const chatId = newChat();
		const base = { chatId, chatStore, jobStore, spawn: () => {} };
		const bare = Object.keys(createTeacherTools(base));
		assert.ok(!bare.includes("verify_queue"));
		assert.ok(bare.includes("pubmed_search") && bare.includes("pubmed_fetch") && bare.includes("europepmc_search"));
		const wired = Object.keys(createTeacherTools({ ...base, verify: toolCtx(chatId) }));
		assert.ok(wired.includes("verify_queue") && wired.includes("evidence_sources"));
	});

	it("the new tool descriptions address the learner as you/the learner, never he/his/him", () => {
		const chatId = newChat();
		const tools = { ...verifyTools(toolCtx(chatId)), ...createTeacherTools({ chatId, chatStore, jobStore, spawn: () => {} }) };
		for (const name of ["verify_queue", "evidence_sources", "pubmed_search", "pubmed_fetch", "europepmc_search"]) {
			assert.doesNotMatch(tools[name]!.description, /\b(?:he|his|him|himself)\b/i, name);
		}
	});

	it("the teacher's prompt routes by question type and carries the rules the tools cannot enforce", () => {
		const prompt = composeInstructions("teacher");
		for (const needle of ["UpToDate Expert AI", "verify_queue", "evidence_sources", "pubmed_search", "provisional", "self-contained", "Never put a name", "Web search is off"]) {
			assert.ok(prompt.includes(needle), `teacher prompt mentions ${needle}`);
		}
		// The merged prompt rules: no third-person pronouns for the learner; a
		// citation tag only for a source actually read this session.
		assert.doesNotMatch(prompt, /\b(?:he|his|him|himself)\b/i);
		assert.ok(prompt.includes("only for a source you have actually read in this session"));
		assert.ok(prompt.includes("unverified, from memory"));
	});
});

// ─── the API guard ───────────────────────────────────────────────────────────

function req(over: Partial<import("../src/server/verify-api.ts").ApiRequest> & { path: string }) {
	const { headers, ...rest } = over;
	return {
		method: "GET",
		...rest,
		headers: { host: `127.0.0.1:${PORT}`, origin: EXT, authorization: `Bearer ${TOKEN}`, ...headers },
	} as import("../src/server/verify-api.ts").ApiRequest;
}
const ctx = { port: PORT, token: TOKEN };
const call = (over: Parameters<typeof req>[0], c: Partial<typeof ctx> & Record<string, unknown> = {}) => api.handleVerifyRequest(req(over), { ...ctx, ...c });
const json = (r: { body: string }) => JSON.parse(r.body) as Record<string, any>;

describe("API guard", () => {
	it("refuses a Host that is not loopback (DNS rebinding)", async () => {
		const r = await call({ path: "/v1/queue", headers: { host: "evil.example:47615" } });
		assert.equal(r.status, 403);
		assert.equal(json(r).error.code, "bad_host");
	});

	it("refuses any web-page Origin even with the right token", async () => {
		for (const origin of ["https://evil.example", "http://localhost:3000", "null", "chrome-extension://short"]) {
			const r = await call({ path: "/v1/queue", headers: { origin } });
			assert.equal(r.status, 403, origin);
			assert.equal(json(r).error.code, "bad_origin");
			assert.equal(r.headers["access-control-allow-origin"], undefined, "a refused origin is never echoed back");
		}
	});

	it("can be pinned to exactly one extension id", async () => {
		const pinned = `chrome-extension://${"b".repeat(32)}`;
		assert.equal((await call({ path: "/v1/queue" }, { pinnedOrigin: pinned })).status, 403);
		assert.equal((await call({ path: "/v1/queue", headers: { origin: pinned } }, { pinnedOrigin: pinned })).status, 200);
	});

	it("needs the pairing token on everything but ping", async () => {
		for (const authorization of [undefined, "Bearer wrong", `Bearer ${"t".repeat(63)}`, TOKEN]) {
			const r = await call({ path: "/v1/queue", headers: { authorization } });
			assert.equal(r.status, 401, String(authorization));
			assert.equal(json(r).error.code, "unauthorized");
		}
		const ping = json(await call({ path: "/v1/ping", headers: { authorization: undefined } }));
		assert.deepEqual(ping, { ok: true, app: "learnharness", apiVersion: 1, authenticated: false });
		assert.equal(json(await call({ path: "/v1/ping" })).authenticated, true);
	});

	it("answers a preflight only for extension origins", async () => {
		const ok = await call({ method: "OPTIONS", path: "/v1/queue", headers: { authorization: undefined } });
		assert.equal(ok.status, 204);
		assert.equal(ok.headers["access-control-allow-origin"], EXT);
		assert.match(ok.headers["access-control-allow-headers"]!, /authorization/);
		const bad = await call({ method: "OPTIONS", path: "/v1/queue", headers: { origin: "https://evil.example" } });
		assert.equal(bad.status, 403);
	});

	it("POST must be JSON", async () => {
		const r = await call({ method: "POST", path: "/v1/highlights", body: "{}", headers: { "content-type": "text/plain" } });
		assert.equal(r.status, 415);
		const bad = await call({ method: "POST", path: "/v1/highlights", body: "{nope", headers: { "content-type": "application/json" } });
		assert.equal(bad.status, 400);
	});

	it("unknown endpoints are 404 JSON", async () => {
		const r = await call({ path: "/v1/nope" });
		assert.equal(r.status, 404);
		assert.equal(json(r).ok, false);
	});

	it("an authenticated call is noted as extension contact", async () => {
		await call({ path: "/v1/queue" }, { now: () => new Date("2026-10-29T10:00:00.000Z") });
		assert.equal(verifyServer.extensionLastSeen(), "2026-10-29T10:00:00.000Z");
	});
});

// ─── the loop: queue → ask → answer → teacher ────────────────────────────────

const NCBI_XML = `<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>10471</PMID><Article><Journal><JournalIssue><PubDate><Year>1999</Year></PubDate></JournalIssue><Title>NEJM</Title></Journal><ArticleTitle>RALES trial</ArticleTitle></Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="doi">10.1056/nejm199909023411001</ArticleId></ArticleIdList></PubmedData></PubmedArticle></PubmedArticleSet>`;

function fakeNcbi(down = false) {
	return async (input: string): Promise<Response> => {
		if (down) return new Response("down", { status: 503 });
		const url = new URL(input);
		if (url.pathname.endsWith("esearch.fcgi")) {
			// Only the RALES DOI is known to the fake PubMed.
			const known = (url.searchParams.get("term") ?? "").toLowerCase().includes("10.1056/nejm199909023411001");
			return Response.json({ esearchresult: { idlist: known ? ["10471"] : [] } });
		}
		return new Response(url.searchParams.get("id")?.split(",").includes("10471") ? NCBI_XML : "<PubmedArticleSet></PubmedArticleSet>");
	};
}

describe("the verify loop", () => {
	it("serves the queue with session titles, marks asked, and takes the answer back", async () => {
		const chatId = newChat("Heart failure");
		verifyStore.addItems(chatId, [{ prompt: "Q-first", provisionalClaim: "claim A" }, { prompt: "Q-second" }]);

		const queue = json(await call({ path: "/v1/queue" })).items as Array<{ id: string; prompt: string; chatTitle: string; status: string }>;
		const mine = queue.filter((i) => i.prompt.startsWith("Q-"));
		assert.deepEqual(mine.map((i) => i.prompt), ["Q-first", "Q-second"]);
		assert.equal(mine[0]?.chatTitle, "Heart failure");

		const asked = await call({ method: "POST", path: `/v1/queue/${mine[0]!.id}/asked`, body: "{}", headers: { "content-type": "application/json" } });
		assert.equal(json(asked).status, "asked");

		const steers: Array<{ id: string; content: string }> = [];
		const deps = { fetchFn: fakeNcbi(), deliver: async (s: { id: string; content: string }) => void steers.push(s) } as never;
		const answered = await call(
			{
				method: "POST",
				path: `/v1/queue/${mine[0]!.id}/answer`,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					text: "Add an MRA when EF ≤ 35% despite ACEi + beta-blocker (PMID 10471; PMID 99999999).",
					references: [{ title: "RALES", url: "https://doi.org/10.1056/NEJM199909023411001" }],
					sourceUrl: "https://ai.uptodate.com/chat/1",
				}),
			},
			{ deps },
		);
		assert.equal(answered.status, 200);
		const body = json(answered);
		assert.equal(body.status, "answered");
		assert.equal(body.next.prompt, "Q-second", "Send & ask next: the reply carries the next queued question");
		await answered.background;

		// Stored durably, with the cross-check and the delivery link.
		const item = verifyStore.getItem(mine[0]!.id)!;
		assert.equal(item.status, "answered");
		assert.ok(item.deliveryJobId);
		assert.deepEqual(item.citationChecks?.map((c) => [c.kind, c.id, c.found]), [["pmid", "10471", true], ["pmid", "99999999", false], ["doi", "10.1056/nejm199909023411001", true]]);

		// The teacher's brief.
		assert.equal(steers.length, 1);
		const brief = steers[0]!.content;
		assert.match(brief, /Q-first/);
		assert.match(brief, /claim A/, "the provisional claim comes back to be compared");
		assert.match(brief, /Add an MRA when EF/);
		assert.match(brief, /PMID 10471: found — "RALES trial" \(NEJM, 1999\)/);
		assert.match(brief, /PMID 99999999: NOT FOUND in PubMed/);
		assert.match(brief, /UpToDate Expert AI, \d{4}-\d{2}-\d{2}/);
		assert.match(brief, /offer, in one short line, to save the key points for Anki/);

		// It rides the research-brief steer: a finished job with the answer + sources.
		const job = jobStore.getJob(item.deliveryJobId!)!;
		assert.equal(job.kind, "research");
		assert.equal(job.status, "done");
		const result = job.result as { brief: string; sources: Array<{ url: string }> };
		assert.ok(result.sources.some((s) => s.url === "https://ai.uptodate.com/chat/1"));
		assert.ok(result.sources.some((s) => s.url === "https://pubmed.ncbi.nlm.nih.gov/10471/"));

		// Answering twice is a conflict; the first answer stands.
		const twice = await call({ method: "POST", path: `/v1/queue/${mine[0]!.id}/answer`, headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "again" }) });
		assert.equal(twice.status, 409);
	});

	it("PubMed down → the brief says UNVERIFIED and the checks are not cached as a pass", async () => {
		const chatId = newChat();
		const [item] = verifyStore.addItems(chatId, [{ prompt: "Q-offline" }]);
		const steers: Array<{ content: string }> = [];
		verifyServer.receiveAnswer(item!.id, { text: "Per PMID 10471 …" });
		await verifyServer.deliverAnswer(item!.id, { fetchFn: fakeNcbi(true), deliver: (async (s: { content: string }) => void steers.push(s)) as never });
		assert.match(steers[0]!.content, /could not reach PubMed, so the citations above are UNVERIFIED/);
		assert.equal(verifyStore.getItem(item!.id)!.citationChecks, undefined);
	});

	it("validates answers: empty text, bad references, unknown id", async () => {
		const chatId = newChat();
		const [item] = verifyStore.addItems(chatId, [{ prompt: "Q-validate" }]);
		const post = (id: string, body: unknown) =>
			call({ method: "POST", path: `/v1/queue/${id}/answer`, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		assert.equal((await post(item!.id, { text: "   " })).status, 400);
		assert.equal((await post(item!.id, { text: "ok", references: [{ url: "javascript:alert(1)" }] })).status, 400);
		assert.equal((await post(item!.id, { text: "ok", references: "nope" })).status, 400);
		assert.equal((await post(item!.id, { text: "ok", sourceUrl: "file:///etc/passwd" })).status, 400);
		assert.equal((await post("vq_missing", { text: "ok" })).status, 404);
		assert.equal(verifyStore.getItem(item!.id)!.status, "queued", "invalid answers change nothing");
	});

	it("dismiss skips a question and moves on", async () => {
		const chatId = newChat();
		const [a, b] = verifyStore.addItems(chatId, [{ prompt: "Q-skip-a" }, { prompt: "Q-skip-b" }]);
		const r = await call({ method: "POST", path: `/v1/queue/${a!.id}/dismiss`, body: "{}", headers: { "content-type": "application/json" } });
		assert.equal(json(r).status, "dismissed");
		assert.equal(verifyStore.getItem(a!.id)!.status, "dismissed");
		assert.ok(json(r).next === null || typeof json(r).next.id === "string");
		assert.equal(verifyStore.getItem(b!.id)!.status, "queued");
	});

	it("an answered-but-undelivered item is re-offered on startup (crash recovery)", async () => {
		const chatId = newChat();
		const [item] = verifyStore.addItems(chatId, [{ prompt: "Q-crash" }]);
		verifyServer.receiveAnswer(item!.id, { text: "answer stored, then the app died" });
		assert.equal(verifyStore.getItem(item!.id)!.deliveryJobId, undefined);
		const steers: unknown[] = [];
		await verifyServer.redeliverPending({ fetchFn: fakeNcbi(), deliver: (async (s: unknown) => void steers.push(s)) as never });
		assert.ok(verifyStore.getItem(item!.id)!.deliveryJobId);
		assert.equal(steers.length, 1);
		// …and doing it again does not create a second job.
		const jobsBefore = jobStore.listJobs(chatId).length;
		await verifyServer.deliverAnswer(item!.id, { fetchFn: fakeNcbi(), deliver: (async () => {}) as never });
		assert.equal(jobStore.listJobs(chatId).length, jobsBefore);
	});

	it("rides the REAL wake pipeline: the answer lands in the session and the job is acknowledged", async () => {
		const chatId = newChat("Wake");
		const [item] = verifyStore.addItems(chatId, [{ prompt: "Q-wake", provisionalClaim: "taught claim" }]);
		let wakes = 0;
		// A fake wake turn that persists its steers like the real handler.
		setTurnRunner(async (cid, input) => {
			wakes++;
			const record = chatStore.getChat(cid)!;
			if (input.type === "steers") {
				chatStore.saveMessages(cid, [...record.messages, ...input.steers.filter((s) => !steerDelivered(record.messages, s.id))]);
			}
			return 200;
		});
		verifyServer.receiveAnswer(item!.id, { text: "Wake answer." });
		await verifyServer.deliverAnswer(item!.id, { fetchFn: fakeNcbi() });
		const jobId = verifyStore.getItem(item!.id)!.deliveryJobId!;
		const started = Date.now();
		while (jobStore.getJob(jobId)!.delivery?.status !== "delivered") {
			if (Date.now() - started > 10_000) throw new Error("timeout waiting for delivery");
			await new Promise((r) => setTimeout(r, 25));
		}
		assert.equal(wakes, 1);
		const messages = chatStore.getChat(chatId)!.messages as Array<{ role: string; customType?: string; content: unknown }>;
		const marker = messages.find((m) => m.role === "custom" && m.customType === "subagent-steer");
		assert.ok(marker, "the brief is in the session as a steer marker");
		assert.match(String(marker.content), /Wake answer\./);
		assert.match(String(marker.content), /taught claim/);
	});
});

// ─── highlights ──────────────────────────────────────────────────────────────

describe("highlights", () => {
	const post = (body: unknown, c: Record<string, unknown> = {}) =>
		call({ method: "POST", path: "/v1/highlights", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, c);

	it("lands in the named session, or the most recent teaching session (never practice)", async () => {
		const teach = newChat("Teach one");
		await new Promise((r) => setTimeout(r, 5));
		const practice = newChat("Practice", "practice");
		const steers: Array<{ content: string }> = [];
		const deps = { deliver: (async (s: { content: string }) => void steers.push(s)) as never };

		const viaDefault = await post({ text: "Target BP < 130/80.", url: "https://example.org/g", title: "Guideline" }, { deps });
		assert.equal(viaDefault.status, 200);
		await viaDefault.background;
		const chosen = json(viaDefault).chatId as string;
		assert.notEqual(chosen, practice);
		assert.equal(chatStore.getChat(chosen)?.kind ?? "teach", "teach");
		assert.match(steers[0]!.content, /Target BP < 130\/80\./);
		assert.match(steers[0]!.content, /Guideline — https:\/\/example\.org\/g/);

		const named = await post({ text: "Named.", url: "https://example.org/n", chatId: teach }, { deps });
		await named.background;
		assert.equal(json(named).chatId, teach);
	});

	it("validates the payload", async () => {
		newChat();
		assert.equal((await post({ text: "", url: "https://x.org" })).status, 400);
		assert.equal((await post({ text: "ok", url: "ftp://x.org" })).status, 400);
		assert.equal((await post({ text: "ok", url: "https://x.org", references: [{ url: "nope" }] })).status, 400);
		assert.equal((await post("a string")).status, 400);
	});
});

// ─── a real socket ───────────────────────────────────────────────────────────

function rawRequest(port: number, headers: Record<string, string>, pathname = "/v1/ping"): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const r = http.request({ host: "127.0.0.1", port, path: pathname, method: "GET", headers }, (res) => {
			let body = "";
			res.on("data", (c) => (body += c));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
		});
		r.on("error", reject);
		r.end();
	});
}

describe("the listener", () => {
	it("binds to loopback only and enforces the guard over a real socket", async () => {
		const handle = await api.startVerifyApi({ port: 0, token: TOKEN });
		assert.ok(handle, "started on an ephemeral port");
		try {
			const port = handle.port;
			assert.equal(api.verifyApiHandle()?.port, port);
			const good = await rawRequest(port, { host: `127.0.0.1:${port}`, origin: EXT, authorization: `Bearer ${TOKEN}` });
			assert.equal(good.status, 200);
			assert.equal(JSON.parse(good.body).authenticated, true);

			const page = await rawRequest(port, { host: `127.0.0.1:${port}`, origin: "https://evil.example", authorization: `Bearer ${TOKEN}` });
			assert.equal(page.status, 403);
			const rebinding = await rawRequest(port, { host: `evil.example:${port}`, origin: EXT, authorization: `Bearer ${TOKEN}` });
			assert.equal(rebinding.status, 403);
			const noToken = await rawRequest(port, { host: `127.0.0.1:${port}`, origin: EXT }, "/v1/queue");
			assert.equal(noToken.status, 401);

			// Not reachable on a non-loopback address of this machine.
			const external = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
			if (external) {
				await assert.rejects(
					new Promise((resolve, reject) => {
						const r = http.request({ host: external.address, port, path: "/v1/ping", timeout: 2000 }, resolve);
						r.on("error", reject);
						r.on("timeout", () => reject(new Error("timeout")));
						r.end();
					}),
				);
			}
			assert.equal(await api.startVerifyApi({ port: 0 }), handle, "starting twice reuses the listener");
		} finally {
			await handle.close();
		}
		assert.equal(api.verifyApiHandle(), null);
	});

	it("a taken port leaves the app running without the extension API", async () => {
		const first = await api.startVerifyApi({ port: 0, token: TOKEN });
		assert.ok(first);
		const taken = first.port;
		// Simulate a second instance: clear our own slot, then try the same port.
		(globalThis as { __lhVerifyApi?: unknown }).__lhVerifyApi = undefined;
		const second = await api.startVerifyApi({ port: taken, token: TOKEN });
		assert.equal(second, null);
		await first.close();
	});

	it("the pairing token is minted once, kept private, and stable", () => {
		const a = api.pairingToken();
		assert.match(a, /^[0-9a-f]{48}$/);
		assert.equal(api.pairingToken(), a);
		const mode = fs.statSync(path.join(TMP_DATA, "verify", "pairing.json")).mode & 0o777;
		assert.equal(mode, 0o600);
	});
});

// ─── the line the spec draws ─────────────────────────────────────────────────

describe("the app never queries UpToDate", () => {
	it("no app source names the Expert AI host — only the learner's extension ever talks to it", () => {
		const root = path.resolve(import.meta.dirname, "..");
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (/\.(ts|tsx|cjs|mjs|js|md)$/.test(entry.name) && /uptodate\.com/i.test(fs.readFileSync(full, "utf-8"))) offenders.push(path.relative(root, full));
			}
		};
		for (const dir of ["src", "app", "components", "electron"]) walk(path.join(root, dir));
		assert.deepEqual(offenders, []);
	});
});
