/**
 * THE VERIFY LOOP'S SERVER SIDE (medical fork, spec "Evidence sources for the
 * Changing tier"): what happens to the Expert AI queue after the teacher
 * writes it. The browser extension reaches these functions through the
 * loopback API (verify-api.ts); the app itself never contacts UpToDate.
 *
 *   queueSnapshot / markAsked / dismissItem — the queue the extension serves.
 *   receiveAnswer   — store the learner's returned answer (durable first),
 *                     then deliverAnswer in the background.
 *   deliverAnswer   — cross-check the PMIDs/DOIs through PubMed, then hand
 *                     the teacher a brief (compare, correct, cite, offer
 *                     Anki). Idempotent per item.
 *   receiveHighlight / deliverHighlight — the same for highlighted text.
 *
 * DELIVERY SEAM (named in the PR): a returned answer reaches the session
 * through the existing wake pipeline (server/jobs.ts) as a finished
 * "research" job whose brief is the answer — so queueing while the teacher
 * is mid-turn, waiting for an unanswered quiz, restarts, and crash recovery
 * all behave exactly like a researched brief. A dedicated message kind can
 * replace this later without touching the queue or the API.
 */

import {
	buildAnswerBrief,
	buildHighlightBrief,
	buildSubagentSteer,
	extractCitationIds,
	VERIFY_LIMITS,
	type CitationCheck,
	type JobRecord,
	type ResearchResult,
	type VerifyAnswer,
	type VerifyHighlight,
	type VerifyItem,
	type VerifyReference,
} from "../core/contracts.ts";
import { fetchPubmedRecords } from "../agent/tools/literature.ts";
import { deliverJobResult } from "./jobs.ts";
import { stores } from "./stores.ts";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Injection seams (tests run with no network). */
export interface VerifyDeps {
	fetchFn?: FetchLike;
	/** Hands a finished steer to the session. Default: the wake pipeline. */
	deliver?: typeof deliverJobResult;
	now?: () => Date;
}

/** The whole PubMed cross-check may take this long; past it, say so. */
const CROSSCHECK_BUDGET_MS = 25_000;

// ─── extension liveness (read by the evidence_sources tool) ─────────────────

interface LhVerifyGlobal {
	__lhVerifyLastSeen?: string;
}

/** The API calls this on every authenticated request. globalThis, because
 *  the API server and the routes are separate module instances. */
export function noteExtensionContact(now: Date = new Date()): void {
	(globalThis as typeof globalThis & LhVerifyGlobal).__lhVerifyLastSeen = now.toISOString();
}

export function extensionLastSeen(): string | null {
	return (globalThis as typeof globalThis & LhVerifyGlobal).__lhVerifyLastSeen ?? null;
}

// ─── the queue the extension serves ─────────────────────────────────────────

export interface QueueEntry {
	id: string;
	chatId: string;
	chatTitle: string;
	prompt: string;
	status: VerifyItem["status"];
	createdAt: string;
}

/** Questions the extension should offer: queued first, then asked (the
 *  learner may need to re-run one whose page was closed). Oldest first. */
export function queueSnapshot(): QueueEntry[] {
	const titles = new Map(stores.chatStore.listChats().map((c) => [c.id, c.title]));
	return stores.verifyStore
		.listItems({ status: ["queued", "asked"] })
		.filter((i) => titles.has(i.chatId))
		.map((i) => ({
			id: i.id,
			chatId: i.chatId,
			chatTitle: titles.get(i.chatId) ?? "",
			prompt: i.prompt,
			status: i.status,
			createdAt: i.createdAt,
		}));
}

/** The next question after `afterId` ("Send & ask next"). Only `queued`
 *  ones: an `asked` item is already in flight. The same session's questions
 *  come first (the lesson that just got its answer), then anyone's oldest. */
export function nextQueued(afterId?: string): QueueEntry | null {
	const queued = queueSnapshot().filter((e) => e.status === "queued" && e.id !== afterId);
	const chatId = afterId ? stores.verifyStore.getItem(afterId)?.chatId : undefined;
	return queued.find((e) => e.chatId === chatId) ?? queued[0] ?? null;
}

export type VerifyOutcome<T> = { ok: true; value: T } | { ok: false; code: "not_found" | "invalid" | "conflict"; message: string };

export function markAsked(id: string): VerifyOutcome<VerifyItem> {
	const item = stores.verifyStore.getItem(id);
	if (!item) return { ok: false, code: "not_found", message: `No queued question ${id}.` };
	if (item.status === "answered" || item.status === "dismissed") {
		return { ok: false, code: "conflict", message: `Question ${id} is already ${item.status}.` };
	}
	const next = stores.verifyStore.updateItem(id, { status: "asked", askedAt: new Date().toISOString() });
	return { ok: true, value: next ?? item };
}

export function dismissItem(id: string): VerifyOutcome<VerifyItem> {
	const item = stores.verifyStore.getItem(id);
	if (!item) return { ok: false, code: "not_found", message: `No queued question ${id}.` };
	if (item.status === "answered") return { ok: false, code: "conflict", message: `Question ${id} is already answered.` };
	return { ok: true, value: stores.verifyStore.updateItem(id, { status: "dismissed" }) ?? item };
}

// ─── payload validation (shared by the API and tests) ───────────────────────

function cleanReferences(raw: unknown): VerifyReference[] | null {
	if (raw === undefined) return [];
	if (!Array.isArray(raw) || raw.length > VERIFY_LIMITS.maxReferences) return null;
	const out: VerifyReference[] = [];
	for (const r of raw) {
		if (!r || typeof r !== "object") return null;
		const { url, title } = r as { url?: unknown; title?: unknown };
		if (typeof url !== "string" || !/^https?:\/\//i.test(url) || url.length > 2000) return null;
		if (title !== undefined && typeof title !== "string") return null;
		out.push({ url, ...(title ? { title: title.slice(0, 300) } : {}) });
	}
	return out;
}

function cleanText(raw: unknown, max: number): string | null {
	if (typeof raw !== "string") return null;
	const text = raw.trim();
	return text.length > 0 && text.length <= max ? text : null;
}

function httpUrl(raw: unknown): string | undefined | null {
	if (raw === undefined) return undefined;
	return typeof raw === "string" && /^https?:\/\//i.test(raw) && raw.length <= 2000 ? raw : null;
}

// ─── returned answers ───────────────────────────────────────────────────────

/** Store the learner's returned answer. Durable BEFORE anything slow runs:
 *  the caller then fires deliverAnswer in the background. Re-sending an
 *  already-answered question is a conflict, not a second delivery. */
export function receiveAnswer(id: string, body: unknown, now: Date = new Date()): VerifyOutcome<VerifyItem> {
	const item = stores.verifyStore.getItem(id);
	if (!item) return { ok: false, code: "not_found", message: `No queued question ${id}.` };
	if (item.status === "answered") return { ok: false, code: "conflict", message: `Question ${id} was already answered.` };
	if (!body || typeof body !== "object") return { ok: false, code: "invalid", message: "Body must be a JSON object." };
	const { text, references, sourceUrl } = body as { text?: unknown; references?: unknown; sourceUrl?: unknown };
	const answerText = cleanText(text, VERIFY_LIMITS.answerChars);
	if (!answerText) {
		return { ok: false, code: "invalid", message: `"text" must be a non-empty string up to ${VERIFY_LIMITS.answerChars} characters.` };
	}
	const refs = cleanReferences(references);
	if (!refs) return { ok: false, code: "invalid", message: `"references" must be an array of {url, title?} with http(s) urls (max ${VERIFY_LIMITS.maxReferences}).` };
	const source = httpUrl(sourceUrl);
	if (source === null) return { ok: false, code: "invalid", message: '"sourceUrl" must be an http(s) URL.' };
	const answer: VerifyAnswer = {
		text: answerText,
		references: refs,
		...(source ? { sourceUrl: source } : {}),
		receivedAt: now.toISOString(),
	};
	const next = stores.verifyStore.updateItem(id, { status: "answered", answer });
	return { ok: true, value: next ?? item };
}

/** PubMed cross-check of every PMID/DOI in the answer and its reference
 *  links. A lookup that cannot run is reported as failed — never as a pass. */
async function crosscheck(
	answer: VerifyAnswer,
	fetchFn: FetchLike | undefined,
): Promise<{ checks: CitationCheck[]; failed: boolean }> {
	const ids = extractCitationIds(answer.text, ...answer.references.map((r) => r.url), ...answer.references.map((r) => r.title ?? ""));
	if (ids.pmids.length === 0 && ids.dois.length === 0) return { checks: [], failed: false };
	try {
		const lookup = await Promise.race([
			fetchPubmedRecords(ids, fetchFn),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("PubMed cross-check timed out")), CROSSCHECK_BUDGET_MS).unref()),
		]);
		const checks: CitationCheck[] = [];
		for (const pmid of ids.pmids) {
			const rec = lookup.records.find((r) => r.pmid === pmid);
			checks.push({ kind: "pmid", id: pmid, found: !lookup.missingPmids.includes(pmid), ...(rec ? { title: rec.title, journal: rec.journal, year: rec.year } : {}) });
		}
		for (const doi of ids.dois) {
			const rec = lookup.records.find((r) => r.doi === doi);
			checks.push({ kind: "doi", id: doi, found: !lookup.missingDois.includes(doi), ...(rec ? { title: rec.title, journal: rec.journal, year: rec.year } : {}) });
		}
		return { checks, failed: false };
	} catch (err) {
		console.error("[verify] PubMed cross-check unavailable:", err instanceof Error ? err.message : err);
		return { checks: [], failed: true };
	}
}

/** Queue a finished brief for a session (see DELIVERY SEAM, above).
 *  Idempotent per `key`: a repeat finds the job and re-offers only what is
 *  still undelivered. Returns the job id. */
function deliverBrief(
	chatId: string,
	key: string,
	question: string,
	context: string,
	brief: string,
	sources: ResearchResult["sources"],
	deliver: typeof deliverJobResult,
): string {
	const { jobStore } = stores;
	const existing = jobStore.findJobByToolCallId(chatId, key);
	const result: ResearchResult = { brief, sources };
	let job: JobRecord = existing ?? jobStore.createJob({ kind: "research", chatId, toolCallId: key, input: { question, context }, activity: "evidence received" });
	if (job.status === "running" && !job.result) {
		// No awaits between create and finish: no worker, nothing to recover.
		job = jobStore.updateJob(job.id, {
			result,
			status: "done",
			activity: "finished",
			delivery: { kind: "result", status: "pending" },
		}) ?? job;
	}
	if (job.delivery?.status === "pending") {
		void deliver(buildSubagentSteer(job, (job.result as ResearchResult | undefined) ?? result)).catch((err: unknown) => {
			console.error(`[verify ${key}] pending delivery:`, err);
		});
	}
	return job.id;
}

function sourcesFor(refs: readonly VerifyReference[], checks: readonly CitationCheck[], extra?: VerifyReference): ResearchResult["sources"] {
	const seen = new Set<string>();
	const out: ResearchResult["sources"] = [];
	const add = (title: string, url: string) => {
		if (!seen.has(url)) {
			seen.add(url);
			out.push({ title, url });
		}
	};
	if (extra) add(extra.title ?? extra.url, extra.url);
	for (const r of refs) add(r.title ?? r.url, r.url);
	for (const c of checks) {
		if (c.found && c.kind === "pmid") add(c.title ?? `PMID ${c.id}`, `https://pubmed.ncbi.nlm.nih.gov/${c.id}/`);
	}
	return out;
}

/** Cross-check an answered item's citations and hand the teacher its brief.
 *  Safe to call again (crash recovery): the job is found by key. */
export async function deliverAnswer(id: string, deps: VerifyDeps = {}): Promise<VerifyItem | null> {
	const item = stores.verifyStore.getItem(id);
	if (!item?.answer || item.status !== "answered") return item;
	if (!stores.chatStore.getChat(item.chatId)) return item; // the session is gone
	const checked = item.citationChecks ? { checks: item.citationChecks, failed: false } : await crosscheck(item.answer, deps.fetchFn);
	const brief = buildAnswerBrief(item, item.answer, checked.checks, checked.failed);
	const sources = sourcesFor(item.answer.references, checked.checks, item.answer.sourceUrl ? { url: item.answer.sourceUrl, title: "UpToDate Expert AI" } : undefined);
	const jobId = deliverBrief(item.chatId, `verify_${item.id}`, item.prompt, "UpToDate Expert AI answer returned by the learner", brief, sources, deps.deliver ?? deliverJobResult);
	return stores.verifyStore.updateItem(id, { deliveryJobId: jobId, ...(checked.failed ? {} : { citationChecks: checked.checks }) });
}

// ─── highlights ─────────────────────────────────────────────────────────────

/** The session a highlight lands in: the one named, else the most recently
 *  active teaching session. */
function highlightTarget(chatId: unknown): string | null {
	if (typeof chatId === "string" && stores.chatStore.getChat(chatId)) return chatId;
	const recent = stores.chatStore.listChats().find((c) => c.kind !== "practice");
	return recent?.id ?? null;
}

export function receiveHighlight(body: unknown, now: Date = new Date()): VerifyOutcome<VerifyHighlight> {
	if (!body || typeof body !== "object") return { ok: false, code: "invalid", message: "Body must be a JSON object." };
	const { text, url, title, references, chatId } = body as Record<string, unknown>;
	const highlighted = cleanText(text, VERIFY_LIMITS.highlightChars);
	if (!highlighted) return { ok: false, code: "invalid", message: `"text" must be a non-empty string up to ${VERIFY_LIMITS.highlightChars} characters.` };
	const page = httpUrl(url);
	if (!page) return { ok: false, code: "invalid", message: '"url" must be the page\'s http(s) URL.' };
	if (title !== undefined && typeof title !== "string") return { ok: false, code: "invalid", message: '"title" must be a string.' };
	const refs = cleanReferences(references);
	if (!refs) return { ok: false, code: "invalid", message: `"references" must be an array of {url, title?} with http(s) urls (max ${VERIFY_LIMITS.maxReferences}).` };
	const target = highlightTarget(chatId);
	if (!target) return { ok: false, code: "conflict", message: "There is no session to send this to — start one in LearnHarness first." };
	return {
		ok: true,
		value: stores.verifyStore.addHighlight({
			chatId: target,
			text: highlighted,
			url: page,
			...(title ? { title: title.slice(0, 300) } : {}),
			references: refs,
			receivedAt: now.toISOString(),
		}),
	};
}

export function deliverHighlight(id: string, deps: VerifyDeps = {}): VerifyHighlight | null {
	const h = stores.verifyStore.getHighlight(id);
	if (!h || !stores.chatStore.getChat(h.chatId)) return h;
	const brief = buildHighlightBrief(h);
	const jobId = deliverBrief(h.chatId, `highlight_${h.id}`, `Highlighted text from ${h.url}`, "Text the learner highlighted in their browser", brief, sourcesFor(h.references, [], { url: h.url, title: h.title }), deps.deliver ?? deliverJobResult);
	return stores.verifyStore.updateHighlight(id, { deliveryJobId: jobId });
}

// ─── startup recovery ───────────────────────────────────────────────────────

/** Re-offer anything answered but never handed to a session (the process
 *  died between the store write and the delivery). The wake pipeline owns
 *  everything after that point. */
export async function redeliverPending(deps: VerifyDeps = {}): Promise<void> {
	for (const item of stores.verifyStore.listItems({ status: ["answered"] })) {
		if (!item.deliveryJobId) await deliverAnswer(item.id, deps).catch((e: unknown) => console.error("[verify] redelivery failed:", e));
	}
}
