/**
 * Evidence-verification contracts — the Expert AI question queue, the
 * highlights the browser extension sends back, and the pure helpers around
 * them (medical fork, spec "Evidence sources for the Changing tier").
 *
 * THE LOOP (owner's design): the teacher writes self-contained, generic
 * questions into a queue; the learner's browser extension runs them ONE AT A
 * TIME, by the learner's click, in the learner's own logged-in UpToDate
 * Expert AI tab, and sends each answer (text + reference links) back through
 * the loopback API (src/server/verify-api.ts, docs/verify-api.md). The app
 * itself NEVER contacts UpToDate. Management claims taught before their
 * check are provisional; when the answer arrives the teacher is steered to
 * compare, correct, and cite.
 *
 * Pure types + tiny pure helpers (browser-safe, no imports).
 */

// ─── The queue ──────────────────────────────────────────────────────────────

/** queued → asked (the extension filled the prompt in) → answered (the
 *  learner sent the answer back). dismissed = the learner skipped it. */
export type VerifyStatus = "queued" | "asked" | "answered" | "dismissed";

/** A source returned by the learner. Inspected UpToDate topic cards carry
 * title + section but no link; legacy URL references remain valid. */
export interface VerifyReference {
	title?: string;
	url?: string;
	type?: string;
	section?: string;
	pmid?: string;
	doi?: string;
}

/** Shared validation for the extension and local API; never invent a URL. */
export function cleanVerifyReferences(raw: unknown): VerifyReference[] | null {
	if (raw === undefined) return [];
	if (!Array.isArray(raw) || raw.length > VERIFY_LIMITS.maxReferences) return null;
	const out: VerifyReference[] = [];
	for (const value of raw) {
		if (!value || typeof value !== "object") return null;
		const ref: VerifyReference = {};
		for (const field of ["title", "url", "type", "section", "pmid", "doi"] as const) {
			const text = value[field];
			if (text === undefined) continue;
			if (typeof text !== "string" || !text.trim() || text.length > 2000) return null;
			ref[field] = text.trim();
		}
		if (!ref.url && !ref.title) return null;
		if (ref.url) {
			try { if (!["http:", "https:"].includes(new URL(ref.url).protocol)) return null; } catch { return null; }
		}
		if (ref.pmid && !/^\d{4,9}$/.test(ref.pmid)) return null;
		if (ref.doi && !/^10\.\d{4,9}\/\S+$/i.test(ref.doi)) return null;
		out.push(ref);
	}
	return out;
}

export function formatVerifyReference(ref: VerifyReference): string {
	return [ref.type ? `(${ref.type})` : "", ref.title, ref.section, ref.url,
		ref.pmid ? `PMID ${ref.pmid}` : "", ref.doi ? `DOI ${ref.doi}` : ""].filter(Boolean).join(" — ");
}

/** The learner's returned Expert AI answer. */
export interface VerifyAnswer {
	text: string;
	references: VerifyReference[];
	/** The page the answer was sent from, when the extension says. */
	sourceUrl?: string;
	/** ISO timestamp the app received it. */
	receivedAt: string;
}

/** One PubMed cross-check of an ID found in an answer. */
export interface CitationCheck {
	kind: "pmid" | "doi";
	id: string;
	/** True when PubMed returned a record for it. */
	found: boolean;
	title?: string;
	journal?: string;
	year?: string;
}

export interface VerifyItem {
	id: string;
	chatId: string;
	/** The self-contained, generic question for Expert AI. */
	prompt: string;
	/** The management claim being taught PROVISIONALLY while this waits —
	 *  what the teacher will compare against the answer when it arrives. */
	provisionalClaim?: string;
	status: VerifyStatus;
	createdAt: string;
	updatedAt: string;
	askedAt?: string;
	answer?: VerifyAnswer;
	/** PubMed cross-check of the PMIDs/DOIs found in the answer. */
	citationChecks?: CitationCheck[];
	/** The job record that carries the answer to the teacher (set once the
	 *  delivery to the session has been queued). */
	deliveryJobId?: string;
}

/** Text the learner highlighted on any page and sent to the app. */
export interface VerifyHighlight {
	id: string;
	/** The session it was delivered to. */
	chatId: string;
	text: string;
	/** The page it came from. */
	url: string;
	title?: string;
	references: VerifyReference[];
	receivedAt: string;
	deliveryJobId?: string;
}

// ─── Limits (the API contract's numbers) ────────────────────────────────────

export const VERIFY_LIMITS = {
	/** Longest prompt the teacher may queue (Expert AI's own box is short). */
	promptChars: 1500,
	/** Longest returned answer / highlight the app accepts. */
	answerChars: 60_000,
	highlightChars: 20_000,
	maxReferences: 100,
	/** Most questions one verify_queue call may add. */
	perCall: 12,
} as const;

// ─── The no-identifiers guard ───────────────────────────────────────────────
//
// Expert AI's page warns "Do not input any personal data, including PHI".
// The PROMPT rule is primary (the teacher never writes identifiers, even when
// the learner mentions a real patient); this is the cheap mechanical backstop
// that bounces the obvious shapes back to the teacher to rewrite. It is a
// guard, not a guarantee — a name written as an ordinary word cannot be
// detected by pattern.

const IDENTIFIER_PATTERNS: Array<{ re: RegExp; problem: string }> = [
	{ re: /[\w.+-]+@[\w-]+\.[\w.-]+/, problem: "contains an email address" },
	{
		re: /(?:\+?\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]\d{3,4}[\s.-]\d{3,4}/,
		problem: "contains a phone-number-like sequence",
	},
	{ re: /\d{6,}/, problem: "contains a long digit run (hospital number / ID number / phone)" },
	{
		re: /\b(?:HN|MRN|AN|NHS|CPR|SSN)\b\s*[:#.-]?\s*\d/i,
		problem: "contains a hospital / record number",
	},
	{
		re: /\b(?:hospital|medical record|patient|national id|passport)\s*(?:number|no\.?|id|#)/i,
		problem: "mentions a hospital / record / ID number",
	},
	{ re: /\b(?:DOB|date of birth|born on)\b/i, problem: "contains a date of birth" },
	{
		re: /\b\d{1,2}[/.-]\d{1,2}[/.-](?:\d{2}|\d{4})\b/,
		problem: "contains a calendar date (dates of care can identify a patient)",
	},
	{
		re: /\b(?:Mr|Mrs|Ms|Miss|Khun|Nong)\.?\s+[A-Z][a-z]+/,
		problem: "appears to name a person",
	},
	{ re: /(?:นาย|นาง|นางสาว|คุณ)\s*[฀-๿]{2,}/, problem: "appears to name a person" },
	{
		re: /\b(?:patient|pt)\s+(?:named|called)\s+\S+/i,
		problem: "appears to name the patient",
	},
];

/** Why a prompt may not go to Expert AI as written (empty = looks clean). */
export function identifierProblems(prompt: string): string[] {
	const problems: string[] = [];
	for (const { re, problem } of IDENTIFIER_PATTERNS) {
		if (re.test(prompt) && !problems.includes(problem)) problems.push(problem);
	}
	return problems;
}

/** Every reason a queued prompt is refused (empty = acceptable). */
export function verifyPromptProblems(prompt: string): string[] {
	const problems: string[] = [];
	const trimmed = prompt.trim();
	if (trimmed.length === 0) problems.push("prompt is empty");
	if (trimmed.length > VERIFY_LIMITS.promptChars) {
		problems.push(`prompt is ${trimmed.length} characters; keep it under ${VERIFY_LIMITS.promptChars}`);
	}
	for (const p of identifierProblems(trimmed)) {
		problems.push(`${p} — Expert AI forbids personal data. Rewrite it generic ("a 58-year-old man…").`);
	}
	return problems;
}

// ─── Citation ids in returned text ──────────────────────────────────────────

const PMID_RES = [
	/\bPMID\s*[:#]?\s*(\d{4,9})\b/gi,
	/pubmed\.ncbi\.nlm\.nih\.gov\/(\d{4,9})/gi,
	/ncbi\.nlm\.nih\.gov\/pubmed\/(\d{4,9})/gi,
];
const DOI_RE = /\b10\.\d{4,9}\/[^\s<>"'\])},;]+/gi;

/** PMIDs and DOIs mentioned anywhere in the given texts (deduped, in
 *  order of first appearance; DOIs lower-cased, trailing punctuation
 *  trimmed). */
export function extractCitationIds(...texts: string[]): { pmids: string[]; dois: string[] } {
	const pmids: string[] = [];
	const dois: string[] = [];
	for (const text of texts) {
		for (const re of PMID_RES) {
			for (const m of text.matchAll(re)) if (m[1] && !pmids.includes(m[1])) pmids.push(m[1]);
		}
		for (const m of text.matchAll(DOI_RE)) {
			const doi = m[0].replace(/[.:;]+$/, "").toLowerCase();
			if (!dois.includes(doi)) dois.push(doi);
		}
	}
	return { pmids, dois };
}

// ─── What the teacher reads when an answer arrives ──────────────────────────

/** The citation form the teacher uses after a correction (spec: "UpToDate
 *  Expert AI, [date]"). */
export function expertAiCitation(isoDate: string): string {
	return `UpToDate Expert AI, ${isoDate.slice(0, 10)}`;
}

/** Offer hook for Anki (spec: "key points are offered for Anki (offer hook
 *  only)"). The learner turns the offer into cards with the session's "Make
 *  Anki cards…" action (docs/medical-spec.md Phase 5); the teacher only
 *  offers and points there, and never makes or sends cards itself. */
export const ANKI_OFFER_INSTRUCTION =
	'Then offer, in one short line, to save the key points for Anki, and say the learner can do it with "Make Anki cards…" (right-click this session in the session list). Offer only — you cannot make or send cards, so do not write cards yourself.';

function checkLine(c: CitationCheck): string {
	const label = c.kind === "pmid" ? `PMID ${c.id}` : `DOI ${c.id}`;
	if (!c.found) return `- ${label}: NOT FOUND in PubMed — treat this citation as unverified.`;
	const where = [c.journal, c.year].filter(Boolean).join(", ");
	return `- ${label}: found — "${c.title ?? "(no title)"}"${where ? ` (${where})` : ""}.`;
}

/** The "PubMed cross-check" section of a brief. `checked` false = the
 *  lookup itself failed (offline / PubMed down): say so, never imply a pass. */
function crosscheckSection(checks: readonly CitationCheck[], lookupFailed: boolean): string {
	if (lookupFailed) {
		return "PubMed cross-check: could not reach PubMed, so the citations above are UNVERIFIED. Say so plainly if you rely on them.";
	}
	if (checks.length === 0) return "PubMed cross-check: the answer cites no PMIDs or DOIs, so there was nothing to cross-check.";
	return `PubMed cross-check of the citations in the answer:\n${checks.map(checkLine).join("\n")}`;
}

/** The brief a returned Expert AI answer becomes in the teacher's session. */
export function buildAnswerBrief(
	item: Pick<VerifyItem, "prompt" | "provisionalClaim">,
	answer: VerifyAnswer,
	checks: readonly CitationCheck[],
	lookupFailed: boolean,
): string {
	const cite = expertAiCitation(answer.receivedAt);
	const refs =
		answer.references.length > 0
			? answer.references.map((r) => `- ${formatVerifyReference(r)}`).join("\n")
			: "(none sent)";
	return [
		`UpToDate Expert AI answered a question you queued (received ${answer.receivedAt.slice(0, 10)}). The learner ran it and sent the answer back.`,
		`Question asked:\n${item.prompt}`,
		item.provisionalClaim
			? `What you taught provisionally while waiting:\n${item.provisionalClaim}`
			: "You did not record a provisional claim for this question.",
		`Expert AI's answer:\n${answer.text}`,
		`Sources it gave (UpToDate topics are cited by title and section; inline source IDs are omitted because their mapping to these sources is unknown):\n${refs}`,
		crosscheckSection(checks, lookupFailed),
		[
			"What to do now: compare the answer with what you taught. If anything differs, correct it plainly in this reply and cite it as " +
				`"${cite}". If it agrees, say the provisional claim is now confirmed (cite the same way).`,
			"Expert AI is an experimental Gen-AI pilot — if a reference it cites was NOT FOUND above, say that claim stays unverified instead of presenting it as settled.",
			ANKI_OFFER_INSTRUCTION,
		].join(" "),
	].join("\n\n");
}

/** The brief a highlight becomes. */
export function buildHighlightBrief(h: Pick<VerifyHighlight, "text" | "url" | "title" | "references" | "receivedAt">): string {
	const refs =
		h.references.length > 0
			? h.references.map((r) => `- ${formatVerifyReference(r)}`).join("\n")
			: "(none sent)";
	return [
		`The learner highlighted this text in their browser and sent it to you (${h.receivedAt.slice(0, 10)}).`,
		`Page: ${h.title ? `${h.title} — ` : ""}${h.url}`,
		`Highlighted text:\n${h.text}`,
		`Reference links on the page:\n${refs}`,
		"What to do now: use it as evidence for whatever you are teaching. Cite it by page title and URL. If it changes something you taught, say so and correct it; if you cannot tell what kind of source the page is, say that rather than treating it as a guideline.",
	].join("\n\n");
}
