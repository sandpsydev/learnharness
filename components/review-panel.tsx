"use client";

/**
 * Review mode's panel (medical fork): illness scripts written into Obsidian.
 *
 * Shown over the graph when the home composer is in Review mode. The learner
 * types one illness in the composer ("acute pancreatitis") and sends it; or
 * presses "Write scripts for every illness" for the whole graph. Both spend
 * the ChatGPT allowance, so nothing here ever starts by itself: a script
 * whose graph has moved on is only marked out of date, and Refresh is a
 * button. The do-all run goes one script at a time, shows how far it has
 * got, can be stopped, and skips scripts that are already up to date.
 *
 * `useReview` owns the fetches; `ReviewPanelView` is presentational so the
 * render tests pin its markup.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReviewPhase, ReviewRunState, ReviewStatus, ScriptListItem } from "@/src/core";
import { useSettingsDialog } from "@/components/settings/settings-dialog";

const IDLE_REFRESH_MS = 8000;
const RUN_REFRESH_MS = 1500;

// ─── pure helpers (exported for tests) ───────────────────────────────────────

const PHASE_TEXT: Record<ReviewPhase, string> = {
	listing: "Listing the illnesses in your graph",
	gathering: "Reading your notes, library and Expert AI answers",
	drawing: "Preparing the images",
	saving: "Saving",
};

/** What the run is doing, in plain words. */
export function runLine(run: ReviewRunState): string {
	if (run.stopping) return "Stopping…";
	const phase = run.phase ? PHASE_TEXT[run.phase] : "Working";
	const where = run.kind === "all" && run.total > 0 ? ` (${run.written + run.skipped + 1} of ${run.total})` : "";
	return run.current ? `${phase}: ${run.current}${where}` : `${phase}…`;
}

/** How far a do-all run has got, 0–100. A single script has no percentage. */
export function runPercent(run: ReviewRunState): number | null {
	if (run.kind !== "all" || run.total <= 0) return null;
	return Math.max(0, Math.min(100, Math.round(((run.written + run.skipped + run.failed.length) / run.total) * 100)));
}

/** The one-line summary of a script's state. */
export function scriptLine(s: ScriptListItem): string {
	const facts = `${s.claims} statements · ${s.images} image${s.images === 1 ? "" : "s"}${s.gaps > 0 ? ` · ${s.gaps} gap${s.gaps === 1 ? "" : "s"} marked` : ""}`;
	return s.freshness === "current" ? `Up to date · ${facts}` : `Out of date — ${s.reasons.join("; ")} · ${facts}`;
}

// ─── the hook ────────────────────────────────────────────────────────────────

export function useReview(enabled: boolean) {
	const [status, setStatus] = useState<ReviewStatus | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const alive = useRef(true);

	const refresh = useCallback(async () => {
		try {
			const res = await fetch("/api/review", { cache: "no-store" });
			if (!res.ok) return;
			const next = ((await res.json()) as { status: ReviewStatus }).status;
			if (alive.current) setStatus(next);
		} catch {
			/* the server is restarting — the next refresh catches up */
		}
	}, []);

	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);

	const running = status?.run?.running ?? false;
	useEffect(() => {
		if (!enabled) return;
		void refresh();
		const timer = setInterval(() => void refresh(), running ? RUN_REFRESH_MS : IDLE_REFRESH_MS);
		return () => clearInterval(timer);
	}, [enabled, running, refresh]);

	const post = useCallback(async (body: Record<string, unknown>): Promise<boolean> => {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
			const reply = (await res.json().catch(() => ({}))) as { status?: ReviewStatus; error?: string; message?: string };
			if (!res.ok) {
				setError(reply.error ?? reply.message ?? `That didn't work (${res.status}).`);
				return false;
			}
			if (reply.status && alive.current) setStatus(reply.status);
			return true;
		} catch (err) {
			setError(`That didn't work: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		} finally {
			if (alive.current) setBusy(false);
		}
	}, []);

	return {
		status,
		error,
		busy,
		write: (illness: string) => post({ action: "write", illness }),
		writeAll: () => post({ action: "write-all" }),
		stop: () => post({ action: "stop" }),
		dismiss: () => post({ action: "dismiss" }),
	};
}

export type ReviewController = ReturnType<typeof useReview>;

// ─── the view ────────────────────────────────────────────────────────────────

export function ReviewPanelView(props: {
	status: ReviewStatus | null;
	error: string | null;
	busy: boolean;
	onWriteAll: () => void;
	onStop: () => void;
	onDismiss: () => void;
	onRefreshScript: (title: string) => void;
	onOpenObsidianSettings: () => void;
}) {
	const { status, error } = props;
	const run = status?.run ?? null;
	const running = run?.running === true;
	const vault = status?.vault;
	const blocked = !vault || !vault.configured || Boolean(vault.problem);
	const percent = run ? runPercent(run) : null;

	return (
		<div
			data-testid="review-panel"
			className="mb-2 flex max-h-[min(24rem,45dvh)] flex-col gap-2 overflow-y-auto rounded-2xl border bg-card p-3 text-sm shadow-lg"
		>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="text-xs uppercase tracking-widest text-muted-foreground">Review</p>
					<p className="text-xs text-muted-foreground/80">
						Type an illness below to write its illness script into your Obsidian vault — one long review note, with your own slide images.
					</p>
				</div>
				<button
					type="button"
					data-testid="review-write-all"
					disabled={props.busy || running || blocked}
					onClick={props.onWriteAll}
					className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs transition-colors hover:bg-accent disabled:opacity-40"
				>
					Write scripts for every illness
				</button>
			</div>

			{vault && !vault.configured && (
				<p className="text-xs text-amber-600 dark:text-amber-400" data-testid="review-no-vault">
					Scripts are written into Obsidian.{" "}
					<button type="button" className="underline" onClick={props.onOpenObsidianSettings}>
						Set your vault folder in Settings → Obsidian
					</button>{" "}
					first.
				</p>
			)}
			{vault?.configured && vault.problem && (
				<p role="alert" className="text-xs text-red-500" data-testid="review-vault-problem">
					{vault.problem}
				</p>
			)}

			{error && (
				<p role="alert" className="text-xs text-red-500" data-testid="review-error">
					{error}
				</p>
			)}

			{run && (
				<div className="flex flex-col gap-1 rounded-sm border border-border px-3 py-2" data-testid="review-run">
					{running ? (
						<>
							{percent !== null && (
								<div
									role="progressbar"
									aria-label="Illness scripts written"
									aria-valuemin={0}
									aria-valuemax={100}
									aria-valuenow={percent}
									className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
								>
									<div className="h-full bg-muted-foreground transition-[width]" style={{ width: `${percent}%` }} />
								</div>
							)}
							<div className="flex items-center justify-between gap-3">
								<p className="min-w-0 truncate text-xs" data-testid="review-run-line">
									{runLine(run)}
								</p>
								<button type="button" data-testid="review-stop" disabled={props.busy || run.stopping} onClick={props.onStop} className="shrink-0 text-xs underline disabled:opacity-40">
									Stop
								</button>
							</div>
							{run.kind === "all" && run.total > 0 && (
								<p className="text-xs text-muted-foreground/80" data-testid="review-run-counts">
									{run.written} written · {run.skipped} already up to date{run.failed.length > 0 ? ` · ${run.failed.length} failed` : ""}
								</p>
							)}
						</>
					) : (
						<div className="flex items-start justify-between gap-3">
							<div className="min-w-0">
								<p className="text-xs" data-testid="review-run-result">
									{run.message ?? "Finished."}
								</p>
								{run.failed.map((f) => (
									<p key={f.title} className="text-xs text-red-500" data-testid="review-run-failed">
										{f.title}: {f.error}
									</p>
								))}
							</div>
							<button type="button" className="shrink-0 text-xs text-muted-foreground hover:text-foreground" data-testid="review-dismiss" onClick={props.onDismiss}>
								Dismiss
							</button>
						</div>
					)}
				</div>
			)}

			{status && status.scripts.length === 0 && !run && (
				<p className="text-xs text-muted-foreground/80" data-testid="review-empty">
					No illness scripts yet.
				</p>
			)}

			{status && status.scripts.length > 0 && (
				<ul className="flex flex-col gap-1.5" data-testid="review-scripts">
					{status.scripts.map((s) => (
						<li key={s.slug} data-testid={`review-script-${s.slug}`} className="flex items-start justify-between gap-3 rounded-sm border border-border px-3 py-1.5">
							<div className="min-w-0">
								<p className="truncate text-sm">{s.title}</p>
								<p className={s.freshness === "outdated" ? "text-xs text-amber-600 dark:text-amber-400" : "text-xs text-muted-foreground/80"}>{scriptLine(s)}</p>
							</div>
							{s.freshness === "outdated" && (
								<button
									type="button"
									data-testid={`review-refresh-${s.slug}`}
									disabled={props.busy || running || blocked}
									onClick={() => props.onRefreshScript(s.title)}
									className="shrink-0 text-xs underline disabled:opacity-40"
								>
									Refresh
								</button>
							)}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/** The panel with its data. */
export function ReviewPanel({ review }: { review: ReviewController }) {
	const settings = useSettingsDialog();
	return (
		<ReviewPanelView
			status={review.status}
			error={review.error}
			busy={review.busy}
			onWriteAll={() => void review.writeAll()}
			onStop={() => void review.stop()}
			onDismiss={() => void review.dismiss()}
			onRefreshScript={(title) => void review.write(title)}
			onOpenObsidianSettings={() => settings.open("obsidian")}
		/>
	);
}
