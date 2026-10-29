"use client";

/**
 * The capture inbox's client side (Phase 8 Pocket mode): the shared hook, the
 * rows, the Mac home's "Tonight's questions" panel and the capture box the
 * phone page uses. Text only, by design — there is no attach control anywhere
 * here (owner decision, patient privacy).
 */

import type { CaptureItem } from "@/src/core";
import { MAX_CAPTURE_CHARS } from "@/src/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, PlayIcon, Trash2Icon } from "lucide-react";
import { OPENING_PROMPT_FAILURE, stashOpeningPrompt } from "@/components/opening-prompt";
import { selectedModelUnavailable, useModelSetup } from "@/components/setup-cta";

const REFRESH_MS = 15_000;

/** The reminder on every capture box (owner decision: patient privacy). */
export const NO_PATIENT_IDENTIFIERS = "No patient identifiers — no names, hospital numbers or dates of birth.";
const SETUP_FIRST = "Set up your models on the Mac first, then try again.";

export function useCaptures(initialConfigured = true) {
	const router = useRouter();
	const { catalog, configured, zeroKeys } = useModelSetup(initialConfigured);
	const [captures, setCaptures] = useState<CaptureItem[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			const res = await fetch("/api/captures?status=open", { cache: "no-store" });
			if (!res.ok) return;
			setCaptures(((await res.json()) as { captures: CaptureItem[] }).captures);
		} catch {
			/* offline or server restarting — the next refresh catches up */
		}
	}, []);

	useEffect(() => {
		void refresh();
		const timer = setInterval(() => void refresh(), REFRESH_MS);
		const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			clearInterval(timer);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [refresh]);

	const act = useCallback(async (id: string, run: () => Promise<Response>) => {
		setBusyId(id);
		setError(null);
		try {
			if (!(await run()).ok) throw new Error("failed");
			await refresh();
		} catch {
			setError("That didn't work. Try again.");
		} finally {
			setBusyId(null);
		}
	}, [refresh]);

	const add = useCallback(async (text: string): Promise<CaptureItem | null> => {
		setError(null);
		try {
			const res = await fetch("/api/captures", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ text }),
			});
			const body = (await res.json()) as { capture?: CaptureItem; error?: string };
			if (!res.ok || !body.capture) {
				setError(body.error ?? "Couldn't save that. Try again.");
				return null;
			}
			await refresh();
			return body.capture;
		} catch {
			setError("Couldn't save that. Try again.");
			return null;
		}
	}, [refresh]);

	const markDone = useCallback((id: string) =>
		act(id, () => fetch(`/api/captures/${id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "done" }),
		})), [act]);

	const remove = useCallback((id: string) =>
		act(id, () => fetch(`/api/captures/${id}`, { method: "DELETE" })), [act]);

	/** Start a teaching session on a capture, then open it. */
	const start = useCallback(async (id: string) => {
		if (catalog) {
			const strong = catalog.slots.strong?.model;
			if (!configured || zeroKeys || selectedModelUnavailable(catalog, strong ? `${strong.provider}:${strong.id}` : undefined)) {
				setError(SETUP_FIRST);
				return;
			}
		}
		setBusyId(id);
		setError(null);
		try {
			const res = await fetch(`/api/captures/${id}/start`, { method: "POST" });
			const body = (await res.json()) as { id?: unknown; text?: unknown };
			if (!res.ok || typeof body.id !== "string" || typeof body.text !== "string" || !/^[A-Za-z0-9_-]+$/.test(body.id)) {
				throw new Error("start failed");
			}
			if (!stashOpeningPrompt(body.id, body.text)) throw new Error("stash failed");
			router.push(`/chat/${body.id}`);
		} catch {
			setError(OPENING_PROMPT_FAILURE);
			setBusyId(null);
		}
	}, [catalog, configured, zeroKeys, router]);

	return { captures, error, busyId, add, markDone, remove, start, refresh };
}

type CaptureActions = Pick<ReturnType<typeof useCaptures>, "markDone" | "remove" | "start" | "busyId">;

const ROW_BUTTON =
	"flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-md border border-border bg-card px-3 font-ui text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-40";

/** One capture: the text, then Start / Done / Delete. Tap targets are 44px so a
 *  thumb can hit them on the ward. */
export function CaptureRow({ capture, actions }: { capture: CaptureItem; actions: CaptureActions }) {
	const busy = actions.busyId === capture.id;
	return (
		<li data-testid="capture-row" className="flex flex-col gap-2 rounded-lg border border-border bg-card/60 p-3">
			<p className="whitespace-pre-wrap break-words text-sm leading-snug">{capture.text}</p>
			<div className="flex flex-wrap gap-2">
				<button type="button" disabled={busy} onClick={() => void actions.start(capture.id)} className={ROW_BUTTON} data-testid="capture-start">
					<PlayIcon aria-hidden="true" className="size-3.5" /> Start session
				</button>
				<button type="button" disabled={busy} onClick={() => void actions.markDone(capture.id)} className={ROW_BUTTON} data-testid="capture-done">
					<CheckIcon aria-hidden="true" className="size-3.5" /> Done
				</button>
				<button type="button" disabled={busy} onClick={() => void actions.remove(capture.id)} aria-label="Delete capture" className={ROW_BUTTON} data-testid="capture-delete">
					<Trash2Icon aria-hidden="true" className="size-3.5" />
				</button>
			</div>
		</li>
	);
}

/** The Mac home's "Tonight's questions": the open captures, docked above the
 *  new-session box. Renders nothing while there are none. */
export function TonightsQuestions() {
	const state = useCaptures();
	const [open, setOpen] = useState(true);
	if (state.captures.length === 0) return null;
	return (
		<section data-testid="tonights-questions" className="mb-2 rounded-xl border bg-card p-2 shadow-lg">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
				className="flex w-full items-center justify-between px-1.5 py-1 font-ui text-xs uppercase tracking-wider text-muted-foreground"
			>
				<span>Tonight&apos;s questions · {state.captures.length}</span>
				{open ? <ChevronDownIcon aria-hidden="true" className="size-4" /> : <ChevronUpIcon aria-hidden="true" className="size-4" />}
			</button>
			{open && (
				<ul className="mt-1 flex max-h-64 flex-col gap-2 overflow-y-auto">
					{state.captures.map((c) => <CaptureRow key={c.id} capture={c} actions={state} />)}
				</ul>
			)}
			{state.error && <p role="alert" className="px-1.5 pt-1 text-sm text-destructive">{state.error}</p>}
		</section>
	);
}

/** The capture box: a text area, the privacy reminder, Save and Save & start.
 *  16px text (text-base) so iOS Safari doesn't zoom the page on focus. */
export function CaptureBox({ state, autoFocus = true }: { state: ReturnType<typeof useCaptures>; autoFocus?: boolean }) {
	const [text, setText] = useState("");
	const [saving, setSaving] = useState(false);
	const areaRef = useRef<HTMLTextAreaElement>(null);
	const trimmed = text.trim();

	const save = async (thenStart: boolean) => {
		if (!trimmed || saving) return;
		setSaving(true);
		const capture = await state.add(trimmed);
		setSaving(false);
		if (!capture) return; // the draft stays; state.error says why
		setText("");
		if (thenStart) await state.start(capture.id);
		else areaRef.current?.focus();
	};

	return (
		<form
			data-testid="capture-box"
			className="flex flex-col gap-2"
			onSubmit={(e) => {
				e.preventDefault();
				void save(false);
			}}
		>
			<textarea
				ref={areaRef}
				value={text}
				onChange={(e) => setText(e.target.value)}
				maxLength={MAX_CAPTURE_CHARS}
				rows={4}
				autoFocus={autoFocus}
				placeholder="A question or topic to look at tonight…"
				aria-label="Capture a question or topic"
				className="w-full resize-none rounded-xl border bg-card p-3 text-base leading-snug outline-none placeholder:text-muted-foreground focus:border-muted-foreground/50"
			/>
			<p data-testid="capture-privacy" className="text-xs text-muted-foreground">{NO_PATIENT_IDENTIFIERS} Text only.</p>
			<div className="flex gap-2">
				<button
					type="submit"
					disabled={!trimmed || saving}
					className="min-h-11 flex-1 rounded-lg bg-primary px-4 font-ui text-sm text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
				>
					Save for tonight
				</button>
				<button
					type="button"
					disabled={!trimmed || saving}
					onClick={() => void save(true)}
					className="min-h-11 flex-1 rounded-lg border border-border bg-card px-4 font-ui text-sm transition-colors hover:bg-accent disabled:opacity-40"
				>
					Save &amp; start now
				</button>
			</div>
		</form>
	);
}
