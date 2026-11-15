"use client";

/**
 * The Session recap button (medical fork, docs/medical-spec.md "Session
 * recap"): in a teaching session's top bar, at every width. One click writes
 * one review note for that session into the Obsidian vault, from what the
 * session covered. It spends the ChatGPT allowance (one model call), so
 * nothing here ever starts by itself: the learner clicks, sees progress (or a
 * plain error), and then gets "Open in Obsidian" and the note's path. Clicking
 * again later rewrites the generated part from the whole session and keeps
 * the learner's own notes.
 *
 * `useSessionRecap` owns the fetches; `SessionRecapView` is presentational so
 * the render tests pin its markup.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderIcon, NotebookPenIcon } from "lucide-react";
import type { RecapPhase, RecapStatus } from "@/src/core";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { usePopoverDismiss } from "@/components/popover-dismiss";
import { timeAgo } from "@/components/sidebar";
import { Hint } from "@/components/ui/hint";

const IDLE_REFRESH_MS = 8000;
const RUN_REFRESH_MS = 1500;

// ─── pure helpers (exported for tests) ───────────────────────────────────────

const PHASE_TEXT: Record<RecapPhase, string> = {
	reading: "Reading the session…",
	writing: "Writing the recap from what the session covered…",
	pictures: "Finding pictures for the visual points…",
	saving: "Saving it into Obsidian…",
};

/** What the run is doing, in plain words. */
export function recapRunLine(phase: RecapPhase | undefined, current?: string): string {
	if (phase === "pictures" && current) return current;
	return phase ? PHASE_TEXT[phase] : "Working…";
}

/** How far the session has moved on since the recap, in words; null when it has not. */
export function movedOnLine(newMessages: number): string | null {
	if (newMessages <= 0) return null;
	return `The session has ${newMessages} new message${newMessages === 1 ? "" : "s"} since this recap. Refresh it to include them.`;
}

// ─── the hook ────────────────────────────────────────────────────────────────

export function useSessionRecap(chatId: string, enabled: boolean) {
	const [status, setStatus] = useState<RecapStatus | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [posting, setPosting] = useState(false);
	const alive = useRef(true);

	const refresh = useCallback(async () => {
		try {
			const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/recap`, { cache: "no-store" });
			if (!res.ok) return;
			const next = ((await res.json()) as { status: RecapStatus }).status;
			if (alive.current) setStatus(next);
		} catch {
			/* the server is restarting — the next refresh catches up */
		}
	}, [chatId]);

	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);

	const running = status?.run?.running ?? false;
	useEffect(() => {
		if (!enabled && !running) return;
		void refresh();
		const timer = setInterval(() => void refresh(), running ? RUN_REFRESH_MS : IDLE_REFRESH_MS);
		return () => clearInterval(timer);
	}, [enabled, running, refresh]);

	const post = useCallback(
		async (action: "write" | "stop" | "dismiss"): Promise<void> => {
			setPosting(true);
			setError(null);
			try {
				const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/recap`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ action }),
				});
				const reply = (await res.json().catch(() => ({}))) as { status?: RecapStatus; error?: string; message?: string };
				if (!res.ok) {
					setError(reply.error ?? reply.message ?? `That didn't work (${res.status}).`);
					return;
				}
				if (reply.status && alive.current) setStatus(reply.status);
			} catch (err) {
				setError(`That didn't work: ${err instanceof Error ? err.message : String(err)}`);
			} finally {
				if (alive.current) setPosting(false);
			}
		},
		[chatId],
	);

	return {
		status,
		error,
		posting,
		write: () => post("write"),
		stop: () => post("stop"),
		dismiss: () => post("dismiss"),
	};
}

export type SessionRecapController = ReturnType<typeof useSessionRecap>;

// ─── the view ────────────────────────────────────────────────────────────────

export function SessionRecapView(props: {
	status: RecapStatus | null;
	error: string | null;
	posting: boolean;
	onWrite: () => void;
	onStop: () => void;
	onDismiss: () => void;
	onOpenObsidianSettings: () => void;
}) {
	const { status, error } = props;
	const run = status?.run ?? null;
	const running = run?.running === true;
	const vault = status?.vault;
	const blocked = !vault || !vault.configured || Boolean(vault.problem);
	const recap = status?.recap ?? null;
	const moved = recap ? movedOnLine(recap.newMessages) : null;
	const otherBusy = status?.busy === true && !running;

	return (
		<div data-testid="session-recap-panel" className="flex flex-col gap-2 text-sm">
			<div>
				<p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Session recap</p>
				<p className="text-xs text-muted-foreground/80">
					Writes a review note into your Obsidian vault from what this session covered, with pictures for the visual points, to revise and test yourself from. It uses your AI allowance (the note, plus a short search for each new picture), so it only runs when you click.
				</p>
			</div>

			{vault && !vault.configured && (
				<p className="text-xs text-amber-600 dark:text-amber-400" data-testid="session-recap-no-vault">
					Recaps are written into Obsidian.{" "}
					<button type="button" className="underline" onClick={props.onOpenObsidianSettings}>
						Set your vault folder in Settings → Obsidian
					</button>{" "}
					first.
				</p>
			)}
			{vault?.configured && vault.problem && (
				<p role="alert" className="text-xs text-red-500" data-testid="session-recap-vault-problem">
					{vault.problem}
				</p>
			)}

			{error && (
				<p role="alert" className="text-xs text-red-500" data-testid="session-recap-error">
					{error}
				</p>
			)}

			{running && (
				<div className="flex items-center justify-between gap-3 rounded-sm border border-border px-3 py-2" data-testid="session-recap-run">
					<p className="flex min-w-0 items-center gap-2 text-xs" data-testid="session-recap-run-line">
						<LoaderIcon className="size-3.5 shrink-0 animate-spin" aria-hidden />
						<span className="min-w-0">{recapRunLine(run?.phase, run?.current)}</span>
					</p>
					<button type="button" data-testid="session-recap-stop" disabled={props.posting} onClick={props.onStop} className="shrink-0 text-xs underline disabled:opacity-40">
						Stop
					</button>
				</div>
			)}

			{!running && run?.error && (
				<div className="flex items-start justify-between gap-3 rounded-sm border border-border px-3 py-2">
					<p role="alert" className="min-w-0 text-xs text-red-500" data-testid="session-recap-run-error">
						{run.error}
					</p>
					<button type="button" className="shrink-0 text-xs text-muted-foreground hover:text-foreground" data-testid="session-recap-dismiss" onClick={props.onDismiss}>
						Dismiss
					</button>
				</div>
			)}

			{!running && recap && (
				<div className="flex flex-col gap-1 rounded-sm border border-border px-3 py-2" data-testid="session-recap-done">
					<p className="text-xs">
						Recap written {timeAgo(recap.generatedAt)} · {recap.topics} topic{recap.topics === 1 ? "" : "s"}
					</p>
					{recap.obsidianUrl ? (
						<a href={recap.obsidianUrl} data-testid="session-recap-open" className="w-fit text-xs underline">
							Open in Obsidian
						</a>
					) : recap.notePath ? null : (
						<p className="text-xs text-muted-foreground/80" data-testid="session-recap-pending">
							It is saved in LearnHarness and will appear in Obsidian once your vault is set up.
						</p>
					)}
					{(recap.absolutePath ?? recap.notePath) && (
						<p className="break-all text-xs text-muted-foreground/80" data-testid="session-recap-path">
							{recap.absolutePath ?? recap.notePath}
						</p>
					)}
					{run?.message && !run.error && (
						<p className="text-xs text-muted-foreground/80" data-testid="session-recap-message">
							{run.message}
						</p>
					)}
					{moved && (
						<p className="text-xs text-amber-600 dark:text-amber-400" data-testid="session-recap-moved">
							{moved}
						</p>
					)}
				</div>
			)}

			{otherBusy && <p className="text-xs text-muted-foreground/80">Another session's recap is being written. Wait for it to finish.</p>}

			{!running && (
				<button
					type="button"
					data-testid="session-recap-write"
					disabled={props.posting || blocked || otherBusy}
					onClick={props.onWrite}
					className="w-full rounded-md border border-border px-2.5 py-1.5 text-xs transition-colors hover:bg-accent disabled:opacity-40"
				>
					{recap ? "Refresh recap" : "Write recap"}
				</button>
			)}
			{!running && recap && <p className="text-xs text-muted-foreground/80">Refreshing rewrites the recap from the whole session. What you wrote under “My notes” in Obsidian is kept.</p>}
		</div>
	);
}

/** The top-bar button with its popover. */
export function SessionRecapButton({ chatId }: { chatId: string }) {
	const settings = useSettingsDialog();
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	usePopoverDismiss(rootRef, open, () => setOpen(false));
	const recap = useSessionRecap(chatId, open);
	const running = recap.status?.run?.running === true;

	// A run that finishes while the panel is closed opens it, so the result (the Obsidian link or the error) is seen.
	const wasRunning = useRef(false);
	useEffect(() => {
		if (wasRunning.current && !running) setOpen(true);
		wasRunning.current = running;
	}, [running]);

	return (
		<div ref={rootRef} className="lh-no-drag relative shrink-0">
			<Hint label="Write a review note for this session in Obsidian" side="bottom">
				<button
					type="button"
					data-testid="session-recap-button"
					onClick={() => setOpen((o) => !o)}
					aria-expanded={open}
					aria-label="Session recap"
					className="flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-border/80 px-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:border-border hover:text-foreground max-sm:px-2"
				>
					{running ? <LoaderIcon className="size-3.5 animate-spin" aria-hidden /> : <NotebookPenIcon className="size-3.5 text-primary" aria-hidden />}
					<span className="max-sm:hidden">Recap</span>
				</button>
			</Hint>
			{open && (
				<div
					data-testid="session-recap-popover"
					className="z-40 rounded-xl border bg-card p-3 shadow-xl max-sm:fixed max-sm:inset-x-3 max-sm:top-16 max-sm:max-h-[calc(100dvh-5rem)] max-sm:overflow-y-auto sm:absolute sm:top-full sm:right-0 sm:mt-1.5 sm:w-80"
				>
					<SessionRecapView
						status={recap.status}
						error={recap.error}
						posting={recap.posting}
						onWrite={() => void recap.write()}
						onStop={() => void recap.stop()}
						onDismiss={() => void recap.dismiss()}
						onOpenObsidianSettings={() => settings.open("obsidian")}
					/>
				</div>
			)}
		</div>
	);
}
