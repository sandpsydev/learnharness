/**
 * AnkiConnect client (docs/medical-spec.md Phase 5 "Delivery").
 *
 * AnkiConnect (add-on 2055492159) serves a small JSON API from a RUNNING Anki
 * desktop at http://127.0.0.1:8765. This module talks to it from the SERVER
 * (a browser request would be blocked by AnkiConnect's CORS rules) and turns
 * "Anki isn't running" into a clear, typed error.
 *
 * Network access is injectable (`fetch` option) so tests never reach the
 * owner's real Anki. As a second fence, under NODE_ENV=test a call that
 * brings no fetch of its own throws instead of touching port 8765.
 *
 * Duplicate guard: before adding anything, every note is checked with
 * AnkiConnect `canAddNotes` using `duplicateScope: "deck"`, so a card whose
 * front already exists in the TARGET deck is skipped, never added twice.
 */

import {
	cardProblem,
	cardTags,
	deckForSystem,
	frontKey,
	noteShape,
	type AnkiCard,
	type CardPushResult,
} from "./contracts/anki.ts";

export const ANKI_CONNECT_URL = "http://127.0.0.1:8765";
/** AnkiConnect API version this client speaks. */
export const ANKI_CONNECT_VERSION = 6;

/** Anki (or the add-on) is not reachable. The message says what to do. */
export class AnkiUnavailableError extends Error {
	constructor(cause?: unknown) {
		super(
			"Can't reach Anki. Open the Anki desktop app and make sure the AnkiConnect add-on (code 2055492159) is installed, then try again.",
			cause === undefined ? undefined : { cause },
		);
		this.name = "AnkiUnavailableError";
	}
}

/** Something answered, but not with a usable AnkiConnect reply. */
export class AnkiConnectError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AnkiConnectError";
	}
}

export interface AnkiClientOptions {
	/** The fetch to use; required under NODE_ENV=test (see file header). */
	fetch?: typeof fetch;
	url?: string;
	signal?: AbortSignal;
}

/** One AnkiConnect action. Resolves to its `result`; throws the typed errors above. */
export async function ankiInvoke<T>(
	action: string,
	params: Record<string, unknown> = {},
	opts: AnkiClientOptions = {},
): Promise<T> {
	if (!opts.fetch && process.env.NODE_ENV === "test") {
		throw new Error("ankiInvoke: tests must inject a fetch — never reach the real AnkiConnect.");
	}
	const doFetch = opts.fetch ?? fetch;
	let res: Response;
	try {
		res = await doFetch(opts.url ?? ANKI_CONNECT_URL, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action, version: ANKI_CONNECT_VERSION, params }),
			signal: opts.signal,
		});
	} catch (err) {
		if (opts.signal?.aborted) throw err;
		throw new AnkiUnavailableError(err);
	}
	if (!res.ok) throw new AnkiConnectError(`AnkiConnect answered HTTP ${res.status}.`);
	let body: unknown;
	try {
		body = await res.json();
	} catch {
		throw new AnkiConnectError("Something answered on the AnkiConnect port, but not with AnkiConnect's reply.");
	}
	if (typeof body !== "object" || body === null || !("error" in body) || !("result" in body)) {
		throw new AnkiConnectError("Something answered on the AnkiConnect port, but not with AnkiConnect's reply.");
	}
	const { result, error } = body as { result: T; error: string | null };
	if (error) throw new AnkiConnectError(`Anki said: ${error}`);
	return result;
}

interface PreparedNote {
	card: AnkiCard;
	deckName: string;
	note: {
		deckName: string;
		modelName: string;
		fields: Record<string, string>;
		tags: string[];
		options: {
			allowDuplicate: false;
			duplicateScope: "deck";
			duplicateScopeOptions: { deckName: string; checkChildren: false; checkAllModels: false };
		};
	};
}

export interface PushOptions extends AnkiClientOptions {
	/** Sessions to tag every card with (`lh::session::<id>`). */
	sessionIds?: readonly string[];
	/** Send every card to this one deck instead of its system's deck. */
	deckOverride?: string;
}

/** Per-card outcome of a push, keyed by card id. */
export type PushOutcome = Map<string, CardPushResult>;

/**
 * Send cards to Anki. Throws AnkiUnavailableError / AnkiConnectError when
 * Anki can't be used at all (before anything is added); otherwise resolves to
 * one result per card: added, skipped as a duplicate, or failed with a reason.
 */
export async function pushCards(cards: readonly AnkiCard[], opts: PushOptions = {}): Promise<PushOutcome> {
	const outcome: PushOutcome = new Map();
	const todo: PreparedNote[] = [];
	const seen = new Set<string>();

	for (const card of cards) {
		if (card.push?.status === "added") {
			outcome.set(card.id, card.push);
			continue;
		}
		const problem = cardProblem(card);
		if (problem) {
			outcome.set(card.id, { status: "failed", message: problem });
			continue;
		}
		const deckName = opts.deckOverride?.trim() || deckForSystem(card.system);
		const key = `${deckName}\u0000${frontKey(card.front)}`;
		if (seen.has(key)) {
			outcome.set(card.id, { status: "duplicate", message: "Another card in this batch has the same front." });
			continue;
		}
		seen.add(key);
		const { modelName, fields } = noteShape(card);
		todo.push({
			card,
			deckName,
			note: {
				deckName,
				modelName,
				fields,
				tags: cardTags(card, opts.sessionIds ?? []),
				options: {
					allowDuplicate: false,
					duplicateScope: "deck",
					duplicateScopeOptions: { deckName, checkChildren: false, checkAllModels: false },
				},
			},
		});
	}
	if (todo.length === 0) return outcome;

	// Reachability and the stock note types first: nothing is created if Anki can't take the cards.
	const version = await ankiInvoke<number>("version", {}, opts);
	if (typeof version !== "number" || version < ANKI_CONNECT_VERSION) {
		throw new AnkiConnectError(`The AnkiConnect add-on is too old (API version ${String(version)}). Update it in Anki.`);
	}
	const models = await ankiInvoke<string[]>("modelNames", {}, opts);
	const missing = [...new Set(todo.map((t) => t.note.modelName))].filter((m) => !models.includes(m));
	if (missing.length > 0) {
		throw new AnkiConnectError(
			`Your Anki has no "${missing.join('" or "')}" note type. LearnHarness uses Anki's built-in "Basic" and "Cloze" note types.`,
		);
	}

	// Decks must exist before the duplicate check can scope to them (createDeck is a no-op for an existing deck).
	for (const deckName of new Set(todo.map((t) => t.deckName))) {
		await ankiInvoke("createDeck", { deck: deckName }, opts);
	}

	const canAdd = await ankiInvoke<boolean[]>("canAddNotes", { notes: todo.map((t) => t.note) }, opts);
	const addable: PreparedNote[] = [];
	todo.forEach((t, i) => {
		if (canAdd[i]) addable.push(t);
		else {
			outcome.set(t.card.id, {
				status: "duplicate",
				message: `A card with this front already exists in ${t.deckName}.`,
			});
		}
	});

	if (addable.length > 0) {
		const ids = await ankiInvoke<(number | null)[]>("addNotes", { notes: addable.map((t) => t.note) }, opts);
		addable.forEach((t, i) => {
			outcome.set(
				t.card.id,
				ids[i] ? { status: "added" } : { status: "failed", message: "Anki refused to add this card." },
			);
		});
	}
	return outcome;
}
