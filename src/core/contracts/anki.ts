/**
 * Anki export contracts (docs/medical-spec.md Phase 5).
 *
 * A learner asks for cards on a session, on selected graph nodes, or (later)
 * on a library section. A background sub-agent drafts them into an AnkiDraft;
 * the learner reviews, edits and deletes in the review panel; only then does
 * a push send them to a running Anki desktop through AnkiConnect.
 *
 * Pure types + tiny pure helpers (browser-safe: the review panel imports
 * this file too). The organ-system list is NOT redefined here: the deck of a
 * card comes from `DECK_BY_SYSTEM`, a Record keyed by the shared OrganSystem
 * id from contracts/graph.ts, so adding a system there is a compile error
 * here until it gets a deck.
 */

import { isOrganSystem, sanitizeSystems, type OrganSystem } from "./graph.ts";
import type { JobUsage } from "./jobs.ts";

// ─── decks ──────────────────────────────────────────────────────────────────

/** Parent deck every export lands under. */
export const ANKI_ROOT_DECK = "LearnHarness";

/** The deck name (below the root) of each organ system. */
export const DECK_BY_SYSTEM: Readonly<Record<OrganSystem, string>> = {
	cardiovascular: "Cardio",
	respiratory: "Respiratory",
	renal: "Renal",
	gi: "GI",
	endocrine: "Endocrine",
	reproductive: "Reproductive",
	neurology: "Neuro",
	psychiatry: "Psych",
	musculoskeletal: "MSK",
	dermatology: "Derm",
	"haem-onc": "HaemOnc",
	"id-immunology": "ID-Immunology",
	general: "General",
};

/** `LearnHarness::Cardio` for a system id. */
export function deckForSystem(system: OrganSystem): string {
	return `${ANKI_ROOT_DECK}::${DECK_BY_SYSTEM[system]}`;
}

// ─── cards ──────────────────────────────────────────────────────────────────

/** The four card shapes (spec Phase 5). */
export const CARD_TYPES = [
	{ id: "cloze", label: "Cloze" },
	{ id: "basic", label: "Basic Q/A" },
	{ id: "mechanism", label: "Mechanism “why”" },
	{ id: "vignette", label: "Mini-vignette" },
] as const;

/** What a card is about; the id doubles as the `lh::type::<id>` tag. */
export const CARD_KINDS = [
	{ id: "mechanism", label: "Mechanism" },
	{ id: "ddx", label: "Differential" },
	{ id: "labs", label: "Labs" },
	{ id: "approach", label: "Approach" },
	{ id: "management", label: "Management" },
	{ id: "memorise", label: "Memorise" },
] as const;

export type CardType = (typeof CARD_TYPES)[number]["id"];
export type CardKind = (typeof CARD_KINDS)[number]["id"];

/** The source a management card carries when nothing in the material cites one. */
export const UNVERIFIED_SOURCE = "unverified";

/** What happened to one card on the last push. */
export interface CardPushResult {
	status: "added" | "duplicate" | "failed";
	/** Plain-English reason for a skipped or failed card. */
	message?: string;
}

/** One drafted card, as the review panel shows and edits it. */
export interface AnkiCard {
	/** Local id ("card_…"), stable across edits. */
	id: string;
	type: CardType;
	kind: CardKind;
	/** The organ system the agent chose: its deck is `deckForSystem(system)`. */
	system: OrganSystem;
	/** Short topic label; becomes the `lh::topic::<slug>` tag. */
	topic: string;
	/** Question / stem / cloze text. The duplicate guard compares this field. */
	front: string;
	/** Answer. For a cloze card this is the optional "extra" shown beneath. */
	back: string;
	/** Management cards: the citation tag (guideline + year, book + page) or "unverified". */
	source?: string;
	/** Present once a push has tried this card. */
	push?: CardPushResult;
}

// ─── drafts ─────────────────────────────────────────────────────────────────

/** Where the material for a draft comes from. */
export type AnkiOrigin =
	| { kind: "session"; chatId: string }
	| { kind: "nodes"; nodeIds: string[] }
	/** SEAM for the PDF library (`med-library`, not merged yet): `ref` is an
	 *  opaque handle that task decides (book + page range). Nothing resolves
	 *  it today; the service answers "not available yet". */
	| { kind: "library"; ref: string };

export type AnkiDraftStatus = "generating" | "ready" | "error";

export interface AnkiDraft {
	/** "anki_" + base36 time + short uuid. */
	id: string;
	origin: AnkiOrigin;
	/** Stable key of the origin: finds the draft again for the same session / node set. */
	originKey: string;
	/** What the panel calls the material ("Renal tubular acidosis", "3 nodes"). */
	title: string;
	status: AnkiDraftStatus;
	/** Latest human-readable progress line while generating. */
	activity: string;
	error?: string;
	cards: AnkiCard[];
	/** Sessions the material came from; each card gets `lh::session::<id>` tags. */
	sessionIds: string[];
	/** Money channel: accumulated token usage of the drafting run (absent until a model call lands). */
	usage?: JobUsage;
	createdAt: string;
	updatedAt: string;
}

/** Stable key for an origin (sorted node ids, so selection order never matters). */
export function originKeyOf(origin: AnkiOrigin): string {
	if (origin.kind === "session") return `session:${origin.chatId}`;
	if (origin.kind === "nodes") return `nodes:${[...new Set(origin.nodeIds)].sort().join(",")}`;
	return `library:${origin.ref}`;
}

// ─── sanitizing (model output and PUT bodies) ───────────────────────────────

function lookup<T extends string>(list: ReadonlyArray<{ id: T; label: string }>, raw: unknown): T | undefined {
	if (typeof raw !== "string") return undefined;
	const norm = (v: string) => v.trim().toLowerCase().replace(/[\s_/-]+/g, "-");
	const wanted = norm(raw);
	if (wanted === "") return undefined;
	return list.find((e) => e.id === wanted || norm(e.label) === wanted)?.id;
}

/** A card type from a loose string ("Basic Q/A", "mechanism-why", "Cloze"). */
export function sanitizeCardType(raw: unknown): CardType | undefined {
	const exact = lookup(CARD_TYPES, raw);
	if (exact) return exact;
	if (typeof raw !== "string") return undefined;
	const v = raw.trim().toLowerCase();
	if (v.startsWith("mechanism")) return "mechanism";
	if (v.startsWith("basic")) return "basic";
	if (v.startsWith("vignette") || v.startsWith("mini")) return "vignette";
	return undefined;
}

export function sanitizeCardKind(raw: unknown): CardKind | undefined {
	return lookup(CARD_KINDS, raw);
}

/** One organ system from a loose string, or undefined. */
export function sanitizeOneSystem(raw: unknown): OrganSystem | undefined {
	return sanitizeSystems([raw])[0];
}

/** The type a missing or unknown value falls back to for a kind. */
export function defaultTypeForKind(kind: CardKind): CardType {
	return kind === "mechanism" ? "mechanism" : "basic";
}

/** True when the text holds at least one cloze deletion `{{c1::…}}`. */
export function hasClozeDeletion(text: string): boolean {
	return /\{\{c\d+::[\s\S]+?\}\}/.test(text);
}

/** A problem with the card that would make Anki reject or botch it, or null. */
export function cardProblem(card: Pick<AnkiCard, "type" | "front" | "back">): string | null {
	if (card.front.trim() === "") return "The front is empty.";
	if (card.type === "cloze") {
		if (!hasClozeDeletion(card.front)) return "A cloze card needs a deletion like {{c1::answer}} in the front.";
		return null;
	}
	if (card.back.trim() === "") return "The back is empty.";
	return null;
}

/**
 * Clean one card from untrusted input (a model submission or the review
 * panel's PUT). Strict about shape — returns null when the card is unusable
 * (no text) — and tolerant about values: unknown type/kind/system fall back
 * to sensible defaults instead of failing the whole batch. `keepEmpty` keeps
 * a card whose front is blank (the review panel mid-edit); a push then
 * reports it as failed with a reason.
 */
export function sanitizeCard(raw: unknown, fallbackSystem: OrganSystem = "general", keepEmpty = false): AnkiCard | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	const front = typeof r.front === "string" ? r.front.trim() : "";
	const back = typeof r.back === "string" ? r.back.trim() : "";
	if (front === "" && !keepEmpty) return null;
	const kind = sanitizeCardKind(r.kind) ?? "memorise";
	const type = sanitizeCardType(r.type) ?? defaultTypeForKind(kind);
	const system = isOrganSystem(r.system) ? r.system : (sanitizeOneSystem(r.system) ?? fallbackSystem);
	const topic = typeof r.topic === "string" && r.topic.trim() !== "" ? r.topic.trim().slice(0, 80) : "general";
	const id = typeof r.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(r.id) ? r.id : newCardId();
	const rawSource = typeof r.source === "string" ? r.source.trim() : "";
	const card: AnkiCard = { id, type, kind, system, topic, front, back };
	if (kind === "management") card.source = rawSource !== "" ? rawSource.slice(0, 200) : UNVERIFIED_SOURCE;
	else if (rawSource !== "") card.source = rawSource.slice(0, 200);
	return card;
}

export function newCardId(): string {
	return `card_${Math.random().toString(36).slice(2, 10)}`;
}

// ─── tags and the Anki note ─────────────────────────────────────────────────

/** Anki tags cannot hold spaces; keep them short, lowercase and plain. */
export function tagSlug(text: string): string {
	const slug = text
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
	return slug === "" ? "misc" : slug;
}

/** At most this many `lh::session::` tags per card (a big node selection can span many sessions). */
export const MAX_SESSION_TAGS = 5;

/** `lh::topic::…`, `lh::type::…`, `lh::session::<id>…` (spec Phase 5). Chat ids are already tag-safe and kept verbatim. */
export function cardTags(card: Pick<AnkiCard, "topic" | "kind">, sessionIds: readonly string[]): string[] {
	return [
		`lh::topic::${tagSlug(card.topic)}`,
		`lh::type::${card.kind}`,
		...sessionIds.slice(0, MAX_SESSION_TAGS).map((id) => `lh::session::${/^[A-Za-z0-9_-]+$/.test(id) ? id : tagSlug(id)}`),
	];
}

/** Plain text → the HTML Anki fields hold: escaped, line breaks kept. Cloze
 *  markers `{{c1::…}}` contain no characters that need escaping. */
export function toAnkiHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\r?\n/g, "<br>");
}

/** The back of a card as sent: the answer, then the source line for cards that carry one. */
export function backWithSource(card: Pick<AnkiCard, "back" | "source">): string {
	const source = card.source?.trim();
	if (!source) return card.back;
	return card.back.trim() === "" ? `Source: ${source}` : `${card.back}\n\nSource: ${source}`;
}

/** Normalised front, for the within-batch duplicate check. */
export function frontKey(front: string): string {
	return front.trim().replace(/\s+/g, " ").toLowerCase();
}

/** The Anki note type and field names a card is sent as. */
export function noteShape(card: Pick<AnkiCard, "type" | "front" | "back" | "source">): {
	modelName: "Basic" | "Cloze";
	fields: Record<string, string>;
} {
	const back = toAnkiHtml(backWithSource(card));
	if (card.type === "cloze") return { modelName: "Cloze", fields: { Text: toAnkiHtml(card.front), "Back Extra": back } };
	return { modelName: "Basic", fields: { Front: toAnkiHtml(card.front), Back: back } };
}
