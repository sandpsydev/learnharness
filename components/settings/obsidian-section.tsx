"use client";
/**
 * The Obsidian section (medical fork): where the learner's vault is, and how
 * the live copy is doing.
 *
 * - One field: the vault folder. Off until it is set. The app writes only
 *   inside a LearnHarness/ folder in it, never touches another file, and
 *   never reads anything back from Obsidian.
 * - A suggested folder is offered with one click, never applied on its own.
 * - The live copy needs no button; "Update notes now" just doesn't wait for
 *   the next change.
 *
 * The view is presentational (ObsidianView) so render tests pin its markup;
 * ObsidianSection owns the fetches.
 */

import { useCallback, useEffect, useState } from "react";
import type { ObsidianStatus } from "@/src/core";
import { notifySettingsSaved } from "@/components/settings-signal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// ─── pure helpers (exported for tests) ───────────────────────────────────────

/** One plain line for the live copy's state. */
export function statusLine(status: ObsidianStatus): string {
	switch (status.state) {
		case "off":
			return "Off — choose your vault folder to start.";
		case "waiting":
			return "Changes found — updating in a moment.";
		case "syncing":
			return "Updating your notes…";
		case "error":
			return status.problem ?? "Something went wrong.";
		case "idle":
			return status.lastSyncAt ? "Up to date." : "On — the first update is on its way.";
	}
}

/** What the last run did, in a short phrase. */
export function reportLine(status: ObsidianStatus): string | null {
	const r = status.lastReport;
	if (!r) return null;
	const parts = [`${r.notes} notes`];
	if (r.written > 0) parts.push(`${r.written} written`);
	if (r.moved > 0) parts.push(`${r.moved} renamed`);
	if (r.removed > 0) parts.push(`${r.removed} removed`);
	if (r.salvaged > 0) parts.push(`${r.salvaged} kept with your own text`);
	if (r.skipped > 0) parts.push(`${r.skipped} left alone`);
	return parts.join(" · ");
}

// ─── the view ────────────────────────────────────────────────────────────────

export function ObsidianView(props: {
	status: ObsidianStatus | null;
	draft: string;
	onDraft: (value: string) => void;
	onSave: () => void;
	onClear: () => void;
	onSyncNow: () => void;
	busy: boolean;
	error: string | null;
}) {
	const { status, draft, busy } = props;
	const saved = status?.vaultPath ?? "";
	return (
		<div className="flex flex-col gap-3" data-testid="obsidian-section">
			<p className="text-xs text-muted-foreground">
				LearnHarness keeps a copy of your knowledge graph in your Obsidian vault: one note per node, linked the way the graph is, and one long illness script per condition from Review mode. It only writes inside a <code>LearnHarness</code> folder in the vault, and
				nothing you change in Obsidian flows back — except that anything you write under <em>My notes</em> in a note is kept.
			</p>

			<label className="flex flex-col gap-1.5">
				<span className="text-xs uppercase tracking-widest text-muted-foreground">Obsidian vault folder</span>
				<div className="flex gap-2">
					<Input
						value={draft}
						onChange={(e) => props.onDraft(e.target.value)}
						placeholder="/Users/you/Documents/MyVault"
						spellCheck={false}
						autoCapitalize="off"
						autoCorrect="off"
						data-testid="obsidian-path"
						onKeyDown={(e) => {
							if (e.key === "Enter") props.onSave();
						}}
					/>
					<Button type="button" size="sm" data-testid="obsidian-save" disabled={busy || draft.trim() === saved} onClick={props.onSave}>
						Save
					</Button>
				</div>
			</label>

			{status && status.suggested && !saved && draft.trim() === "" && (
				<button
					type="button"
					className="self-start text-xs underline"
					data-testid="obsidian-suggest"
					onClick={() => props.onDraft(status.suggested!)}
				>
					Use {status.suggested}
				</button>
			)}

			{props.error && (
				<p role="alert" className="text-xs text-red-500" data-testid="obsidian-error">
					{props.error}
				</p>
			)}

			{status && (
				<div className="flex flex-col gap-1 rounded-sm border border-border px-3 py-2" data-testid="obsidian-status">
					<p className={status.state === "error" ? "text-xs text-red-500" : "text-xs"} role={status.state === "error" ? "alert" : undefined}>
						{statusLine(status)}
					</p>
					{status.appFolder && <p className="break-all text-xs text-muted-foreground/80">Notes go in {status.appFolder}</p>}
					{reportLine(status) && <p className="text-xs text-muted-foreground/80" data-testid="obsidian-report">Last update: {reportLine(status)}</p>}
					{status.vaultPath && (
						<div className="mt-1 flex gap-3">
							<button type="button" className="text-xs underline" data-testid="obsidian-sync" disabled={busy} onClick={props.onSyncNow}>
								Update notes now
							</button>
							<button type="button" className="text-xs text-muted-foreground hover:text-foreground" data-testid="obsidian-clear" disabled={busy} onClick={props.onClear}>
								Turn off
							</button>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

// ─── the section (fetches) ───────────────────────────────────────────────────

export function ObsidianSection() {
	const [status, setStatus] = useState<ObsidianStatus | null>(null);
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async (fillDraft = false) => {
		try {
			const res = await fetch("/api/obsidian", { cache: "no-store" });
			if (!res.ok) throw new Error(`status ${res.status}`);
			const next = ((await res.json()) as { status: ObsidianStatus }).status;
			setStatus(next);
			if (fillDraft) setDraft(next.vaultPath ?? "");
		} catch {
			setError("The Obsidian status couldn't be loaded — refresh to retry.");
		}
	}, []);

	useEffect(() => {
		void refresh(true);
		const t = setInterval(() => void refresh(), 4000);
		return () => clearInterval(t);
	}, [refresh]);

	async function save(vaultPath: string) {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/settings/obsidian", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(vaultPath.trim() === "" ? {} : { vaultPath: vaultPath.trim() }),
			});
			if (!res.ok) {
				const reply = (await res.json().catch(() => ({}))) as { error?: string };
				setError(reply.error ?? `The folder couldn't be saved (${res.status}).`);
				return;
			}
			notifySettingsSaved("obsidian");
			await refresh(true);
		} catch (err) {
			setError(`The folder couldn't be saved: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setBusy(false);
		}
	}

	async function syncNow() {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/obsidian", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "sync" }),
			});
			if (res.ok) setStatus(((await res.json()) as { status: ObsidianStatus }).status);
		} catch {
			setError("The update couldn't be started.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<ObsidianView
			status={status}
			draft={draft}
			onDraft={setDraft}
			onSave={() => void save(draft)}
			onClear={() => void save("")}
			onSyncNow={() => void syncNow()}
			busy={busy}
			error={error}
		/>
	);
}
