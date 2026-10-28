"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import {
	CARD_KINDS,
	CARD_TYPES,
	ORGAN_SYSTEMS,
	ANKI_ROOT_DECK,
	cardProblem,
	deckForSystem,
	originKeyOf,
	type AnkiCard,
	type AnkiDraft,
	type AnkiOrigin,
	type CardKind,
	type CardType,
	type OrganSystem,
} from "@/src/core";

/**
 * "Make Anki cards" (docs/medical-spec.md Phase 5): the review panel.
 *
 * Opening it asks for cards for one origin (a session, or the selected graph
 * nodes). A background agent drafts them; this panel polls the draft, lets
 * the learner edit or delete every card and change its deck, and only then
 * pushes them to the running Anki desktop. Closing the panel never loses a
 * draft: drafting continues in the background and the draft is found again
 * the next time the same session / nodes are opened.
 *
 * `AnkiReviewBody` is the pure, props-driven view (SSR-pinned in tests);
 * `AnkiDialog` owns the fetching, polling and autosave.
 */

const POLL_MS = 1500;
const SAVE_DEBOUNCE_MS = 700;

const field =
	"w-full rounded-sm border border-border/70 bg-background px-2 py-1.5 text-xs leading-relaxed text-foreground outline-none focus:border-foreground/40";
const select =
	"rounded-sm border border-border/70 bg-background px-1.5 py-1 text-xs text-foreground outline-none focus:border-foreground/40";

export type AnkiPhase = "starting" | "generating" | "ready" | "error";

export interface PushSummaryView {
	added: number;
	duplicate: number;
	failed: number;
}

/** The one-line result of a push, in plain words. Exported pure for pins. */
export function pushSummaryLine(s: PushSummaryView): string {
	const parts = [`Added ${s.added} ${s.added === 1 ? "card" : "cards"}`];
	if (s.duplicate > 0) parts.push(`skipped ${s.duplicate} already in Anki`);
	if (s.failed > 0) parts.push(`${s.failed} could not be added`);
	return parts.join(", ") + ".";
}

function CardEditor({
	card,
	disabled,
	onChange,
	onDelete,
}: {
	card: AnkiCard;
	disabled: boolean;
	onChange: (next: AnkiCard) => void;
	onDelete: () => void;
}) {
	const added = card.push?.status === "added";
	const problem = added ? null : cardProblem(card);
	const lock = disabled || added;
	return (
		<li data-testid="anki-card" data-card-id={card.id} className="rounded-md border border-border/70 p-3">
			<div className="flex flex-wrap items-center gap-2">
				<select
					aria-label="Card type"
					className={select}
					value={card.type}
					disabled={lock}
					onChange={(e) => onChange({ ...card, type: e.target.value as CardType })}
				>
					{CARD_TYPES.map((t) => (
						<option key={t.id} value={t.id}>{t.label}</option>
					))}
				</select>
				<select
					aria-label="Card kind"
					className={select}
					value={card.kind}
					disabled={lock}
					onChange={(e) => {
						const kind = e.target.value as CardKind;
						onChange({ ...card, kind, ...(kind === "management" && !card.source ? { source: "unverified" } : {}) });
					}}
				>
					{CARD_KINDS.map((k) => (
						<option key={k.id} value={k.id}>{k.label}</option>
					))}
				</select>
				<select
					aria-label="Deck"
					className={select}
					value={card.system}
					disabled={lock}
					onChange={(e) => onChange({ ...card, system: e.target.value as OrganSystem })}
				>
					{ORGAN_SYSTEMS.map((s) => (
						<option key={s.id} value={s.id}>{deckForSystem(s.id)}</option>
					))}
				</select>
				<span className="min-w-0 flex-1" />
				{card.push?.status === "added" && <span data-testid="anki-card-added" className="text-xs text-emerald-500">Added to Anki</span>}
				{card.push?.status === "duplicate" && (
					<span data-testid="anki-card-duplicate" className="text-xs text-muted-foreground" title={card.push.message}>Skipped: already in Anki</span>
				)}
				{card.push?.status === "failed" && (
					<span data-testid="anki-card-failed" className="text-xs text-destructive" title={card.push.message}>Failed: {card.push.message}</span>
				)}
				{!added && (
					<button
						type="button"
						data-testid="anki-card-delete"
						onClick={onDelete}
						disabled={disabled}
						className="rounded-sm px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-destructive disabled:opacity-40"
					>
						Delete
					</button>
				)}
			</div>
			<label className="mt-2 block text-[11px] uppercase tracking-wider text-muted-foreground">
				{card.type === "cloze" ? "Text (hide with {{c1::answer}})" : "Front"}
				<textarea
					data-testid="anki-card-front"
					className={`${field} mt-1 min-h-[3.5rem] resize-y normal-case tracking-normal`}
					value={card.front}
					disabled={lock}
					onChange={(e) => onChange({ ...card, front: e.target.value })}
				/>
			</label>
			<label className="mt-2 block text-[11px] uppercase tracking-wider text-muted-foreground">
				{card.type === "cloze" ? "Extra (optional)" : "Back"}
				<textarea
					data-testid="anki-card-back"
					className={`${field} mt-1 min-h-[3.5rem] resize-y normal-case tracking-normal`}
					value={card.back}
					disabled={lock}
					onChange={(e) => onChange({ ...card, back: e.target.value })}
				/>
			</label>
			{card.kind === "management" && (
				<label className="mt-2 block text-[11px] uppercase tracking-wider text-muted-foreground">
					Source (guideline + year, or book + page)
					<input
						data-testid="anki-card-source"
						className={`${field} mt-1 normal-case tracking-normal`}
						value={card.source ?? ""}
						disabled={lock}
						onChange={(e) => onChange({ ...card, source: e.target.value })}
					/>
				</label>
			)}
			{problem && (
				<p data-testid="anki-card-problem" className="mt-2 text-xs text-destructive">{problem}</p>
			)}
		</li>
	);
}

/** The panel's pure body: everything it shows, driven by props. */
export function AnkiReviewBody({
	title,
	phase,
	activity,
	error,
	cards,
	deckOverride,
	pushing,
	pushError,
	summary,
	resumed,
	onCardChange,
	onCardDelete,
	onDeckOverride,
	onPush,
	onRetry,
	onRedraft,
	onStop,
	onDiscard,
	onClose,
}: {
	title: string;
	phase: AnkiPhase;
	activity: string;
	error: string | null;
	cards: AnkiCard[];
	deckOverride: string;
	pushing: boolean;
	pushError: string | null;
	summary: PushSummaryView | null;
	/** True when an earlier unsent draft was reopened instead of drafting anew. */
	resumed: boolean;
	onCardChange: (next: AnkiCard) => void;
	onCardDelete: (id: string) => void;
	onDeckOverride: (v: string) => void;
	onPush: () => void;
	onRetry: () => void;
	onRedraft: () => void;
	onStop: () => void;
	onDiscard: () => void;
	onClose: () => void;
}) {
	const unsent = cards.filter((c) => c.push?.status !== "added");
	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Make Anki cards"
			data-testid="anki-dialog"
			onClick={(e) => e.stopPropagation()}
			className="flex max-h-[calc(100vh-4rem)] w-[48rem] max-w-[calc(100vw-2rem)] flex-col rounded-xl border bg-card p-5 shadow-xl"
		>
			<h2 className="text-sm font-semibold">Anki cards</h2>
			<p className="mt-0.5 truncate text-xs text-muted-foreground" data-testid="anki-title">{title}</p>

			{(phase === "starting" || phase === "generating") && (
				<div data-testid="anki-generating" className="mt-4 text-xs text-muted-foreground">
					<p>{phase === "starting" ? "Starting…" : `${activity || "Drafting cards"}…`}</p>
					<p className="mt-1">Nothing is sent to Anki until you review the cards and press Send. You can close this; drafting carries on in the background and the cards will be here when you reopen it.</p>
					<div className="mt-3 flex justify-end gap-2">
						<button type="button" data-testid="anki-stop" onClick={onStop} className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground">Stop</button>
						<button type="button" data-testid="anki-close" onClick={onClose} className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground">Close</button>
					</div>
				</div>
			)}

			{phase === "error" && (
				<div role="alert" data-testid="anki-error" className="mt-4 rounded-sm border border-border/60 px-3 py-2 text-xs">
					<p className="text-foreground">{error ?? "Something went wrong."}</p>
					<div className="mt-3 flex justify-end gap-2">
						<button type="button" data-testid="anki-retry" onClick={onRetry} className="rounded-sm border border-border px-3 py-1.5 text-xs hover:bg-accent">Try again</button>
						<button type="button" data-testid="anki-close" onClick={onClose} className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground">Close</button>
					</div>
				</div>
			)}

			{phase === "ready" && (
				<>
					{resumed && (
						<p data-testid="anki-resumed" className="mt-3 text-xs text-muted-foreground">
							These are cards you drafted earlier and haven’t sent yet.{" "}
							<button type="button" data-testid="anki-redraft" onClick={onRedraft} className="underline underline-offset-2 hover:text-foreground">Draft new ones instead</button>
						</p>
					)}
					{cards.length === 0 ? (
						<p data-testid="anki-empty" className="mt-4 text-xs text-muted-foreground">No cards came out of this material. There may be nothing worth a flashcard in it yet.</p>
					) : (
						<ul className="mt-3 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
							{cards.map((card) => (
								<CardEditor
									key={card.id}
									card={card}
									disabled={pushing}
									onChange={onCardChange}
									onDelete={() => onCardDelete(card.id)}
								/>
							))}
						</ul>
					)}
					{pushError && (
						<p role="alert" data-testid="anki-push-error" className="mt-3 rounded-sm border border-border/60 px-3 py-2 text-xs text-foreground">{pushError}</p>
					)}
					{summary && <p data-testid="anki-summary" className="mt-3 text-xs text-foreground">{pushSummaryLine(summary)}</p>}
					<div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
						<label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground">
							<span className="shrink-0">Deck</span>
							<input
								data-testid="anki-deck-override"
								className={`${field} min-w-0`}
								placeholder={`Each card’s own deck (${ANKI_ROOT_DECK}::…) — or type one deck for all`}
								value={deckOverride}
								disabled={pushing}
								onChange={(e) => onDeckOverride(e.target.value)}
							/>
						</label>
						<button type="button" data-testid="anki-discard" onClick={onDiscard} disabled={pushing} className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground hover:text-destructive disabled:opacity-40">Discard draft</button>
						<button type="button" data-testid="anki-close" onClick={onClose} disabled={pushing} className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40">Close</button>
						<button
							type="button"
							data-testid="anki-push"
							onClick={onPush}
							disabled={pushing || unsent.length === 0}
							className="rounded-sm bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80 disabled:opacity-40"
						>
							{pushing ? "Sending…" : `Send ${unsent.length} ${unsent.length === 1 ? "card" : "cards"} to Anki`}
						</button>
					</div>
				</>
			)}
		</div>
	);
}

async function errorText(res: Response): Promise<string> {
	try {
		const body = (await res.json()) as { error?: unknown };
		if (typeof body.error === "string" && body.error !== "") return body.error;
	} catch {
		/* not JSON */
	}
	return `Request failed (${res.status}).`;
}

export function AnkiDialog({ origin, onClose }: { origin: AnkiOrigin | null; onClose: () => void }) {
	const [draft, setDraft] = useState<AnkiDraft | null>(null);
	const [cards, setCards] = useState<AnkiCard[]>([]);
	const [phase, setPhase] = useState<AnkiPhase>("starting");
	const [error, setError] = useState<string | null>(null);
	const [resumed, setResumed] = useState(false);
	const [deckOverride, setDeckOverride] = useState("");
	const [pushing, setPushing] = useState(false);
	const [pushError, setPushError] = useState<string | null>(null);
	const [summary, setSummary] = useState<PushSummaryView | null>(null);
	const backdropDismiss = useBackdropDismiss(() => {
		if (!pushing) onClose();
	});
	const draftId = useRef<string | null>(null);
	const dirty = useRef(false);
	const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const cardsRef = useRef<AnkiCard[]>([]);
	cardsRef.current = cards;
	const originKey = origin ? originKeyOf(origin) : null;

	const adopt = useCallback((d: AnkiDraft) => {
		draftId.current = d.id;
		setDraft(d);
		if (d.status === "ready") {
			setPhase("ready");
			setCards(d.cards);
		} else if (d.status === "error") {
			setPhase("error");
			setError(d.error ?? "Drafting failed.");
		} else {
			setPhase("generating");
		}
	}, []);

	const startNew = useCallback(async () => {
		if (!origin) return;
		setPhase("starting");
		setError(null);
		setResumed(false);
		setSummary(null);
		setPushError(null);
		try {
			const res = await fetch("/api/anki/drafts", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ origin }),
			});
			if (!res.ok) {
				setError(await errorText(res));
				setPhase("error");
				return;
			}
			adopt(((await res.json()) as { draft: AnkiDraft }).draft);
		} catch {
			setError("Couldn’t reach the app. Try again.");
			setPhase("error");
		}
	}, [origin, adopt]);

	// Opening: reuse a running or unsent draft for this origin, else start one.
	useEffect(() => {
		if (!origin || !originKey) return;
		let cancelled = false;
		draftId.current = null;
		dirty.current = false;
		setDraft(null);
		setCards([]);
		setDeckOverride("");
		void (async () => {
			try {
				const res = await fetch(`/api/anki/drafts?originKey=${encodeURIComponent(originKey)}`);
				if (res.ok) {
					const { drafts } = (await res.json()) as { drafts: AnkiDraft[] };
					const reusable = drafts.find(
						(d) => d.status === "generating" || (d.status === "ready" && d.cards.some((c) => c.push?.status !== "added")),
					);
					if (reusable && !cancelled) {
						adopt(reusable);
						setResumed(reusable.status === "ready");
						return;
					}
				}
			} catch {
				/* fall through to a fresh draft */
			}
			if (!cancelled) await startNew();
		})();
		return () => {
			cancelled = true;
		};
		// Re-runs only when the origin changes; `origin`, `adopt` and `startNew` follow it.
	}, [originKey]);

	// Poll while drafting.
	useEffect(() => {
		const id = draft?.id;
		if (phase !== "generating" || !id) return;
		const timer = setInterval(() => {
			void fetch(`/api/anki/drafts/${id}`)
				.then((r) => (r.ok ? (r.json() as Promise<{ draft: AnkiDraft }>) : null))
				.then((body) => body && adopt(body.draft))
				.catch(() => undefined);
		}, POLL_MS);
		return () => clearInterval(timer);
	}, [phase, draft?.id, adopt]);

	const save = useCallback(async (): Promise<boolean> => {
		const id = draftId.current;
		if (!id) return true;
		dirty.current = false;
		try {
			const res = await fetch(`/api/anki/drafts/${id}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ cards: cardsRef.current }),
			});
			return res.ok;
		} catch {
			return false;
		}
	}, []);

	const scheduleSave = useCallback(() => {
		dirty.current = true;
		if (saveTimer.current) clearTimeout(saveTimer.current);
		saveTimer.current = setTimeout(() => void save(), SAVE_DEBOUNCE_MS);
	}, [save]);

	// Closing flushes pending edits.
	const close = useCallback(() => {
		if (saveTimer.current) clearTimeout(saveTimer.current);
		if (dirty.current) void save();
		onClose();
	}, [onClose, save]);

	useEffect(() => {
		if (!origin) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape" && !pushing) {
				e.preventDefault();
				e.stopPropagation();
				close();
			}
		};
		// Capture phase: when opened over another dialog (Settings → Library),
		// this Esc must close only the panel, before that dialog's own listener runs.
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, [origin, pushing, close]);

	const push = async () => {
		const id = draftId.current;
		if (!id || pushing) return;
		setPushing(true);
		setPushError(null);
		setSummary(null);
		if (saveTimer.current) clearTimeout(saveTimer.current);
		try {
			if (!(await save())) {
				setPushError("Couldn’t save your edits, so nothing was sent. Try again.");
				return;
			}
			const res = await fetch(`/api/anki/drafts/${id}/push`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ deck: deckOverride }),
			});
			if (!res.ok) {
				setPushError(await errorText(res));
				return;
			}
			const body = (await res.json()) as { draft: AnkiDraft; summary: PushSummaryView };
			setCards(body.draft.cards);
			setDraft(body.draft);
			setSummary(body.summary);
		} catch {
			setPushError("Couldn’t reach the app. Try again.");
		} finally {
			setPushing(false);
		}
	};

	const discard = async () => {
		const id = draftId.current;
		if (id) await fetch(`/api/anki/drafts/${id}`, { method: "DELETE" }).catch(() => undefined);
		draftId.current = null;
		dirty.current = false;
		onClose();
	};

	const stop = async () => {
		const id = draftId.current;
		if (id) await fetch(`/api/anki/drafts/${id}/stop`, { method: "POST" }).catch(() => undefined);
	};

	const redraft = async () => {
		const id = draftId.current;
		if (id) await fetch(`/api/anki/drafts/${id}`, { method: "DELETE" }).catch(() => undefined);
		draftId.current = null;
		setCards([]);
		await startNew();
	};

	if (!origin) return null;

	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {...backdropDismiss}>
			<AnkiReviewBody
				title={draft?.title ?? (origin.kind === "nodes" ? `${origin.nodeIds.length} nodes` : origin.kind === "library" ? "Library section" : "Session")}
				phase={phase}
				activity={draft?.activity ?? ""}
				error={error}
				cards={cards}
				deckOverride={deckOverride}
				pushing={pushing}
				pushError={pushError}
				summary={summary}
				resumed={resumed}
				onCardChange={(next) => {
					setCards((prev) => prev.map((c) => (c.id === next.id ? next : c)));
					scheduleSave();
				}}
				onCardDelete={(id) => {
					setCards((prev) => prev.filter((c) => c.id !== id));
					scheduleSave();
				}}
				onDeckOverride={setDeckOverride}
				onPush={() => void push()}
				onRetry={() => void startNew()}
				onRedraft={() => void redraft()}
				onStop={() => void stop()}
				onDiscard={() => void discard()}
				onClose={close}
			/>
		</div>,
		document.body,
	);
}
