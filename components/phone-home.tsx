"use client";

/**
 * The phone's home screen (Pocket mode, Phase 8): what you can do from a
 * ward-sized screen. Capture a question, see tonight's questions, start a
 * teaching session or Explain my miss, and carry on with a session you had
 * open. The graph, settings, the Anki review panel and PDF / SlideScribe
 * import stay on the Mac, so nothing here links to them.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { ClipboardXIcon, DumbbellIcon, PlusIcon } from "lucide-react";
import { CaptureBox, CaptureRow, useCaptures } from "@/components/captures";
import { LhMark } from "@/components/lh-mark";
import { sessionMeta } from "@/components/sidebar";
import { cn } from "@/lib/utils";
import type { ChatListItem } from "@/src/core";

/** Sessions shown before "Show all". */
export const RECENT_SESSIONS = 6;
const REFRESH_MS = 30_000;

const BIG_BUTTON =
	"flex min-h-12 flex-1 items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 font-ui text-sm transition-colors hover:bg-accent";

/** Newest activity first. */
export function recentFirst(chats: readonly ChatListItem[]): ChatListItem[] {
	return [...chats].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function PhoneSessionRow({ chat }: { chat: ChatListItem }) {
	return (
		<li>
			<Link
				href={`/chat/${chat.id}`}
				data-testid="phone-session-row"
				className="flex min-h-14 items-center gap-2 rounded-lg px-3 py-2 transition-colors hover:bg-accent"
			>
				<span className="min-w-0 flex-1">
					<span className="block truncate font-prose text-(length:--lh-prose-size)">{chat.title}</span>
					<span className="block text-xs text-muted-foreground">{sessionMeta(chat)}</span>
				</span>
				{(chat.kind ?? "teach") === "practice" && (
					<DumbbellIcon className="size-3.5 shrink-0 text-muted-foreground/70" aria-label="Practice session" />
				)}
			</Link>
		</li>
	);
}

/** The screen as a pure function of its state (the render-test seam). */
export function PhoneHomeView({
	captures,
	sessions,
}: {
	captures: ReturnType<typeof useCaptures>;
	/** null while loading. */
	sessions: readonly ChatListItem[] | null;
}) {
	const [showAll, setShowAll] = useState(false);
	const shown = sessions ? (showAll ? sessions : sessions.slice(0, RECENT_SESSIONS)) : null;
	return (
		<div className="min-h-dvh">
			<header className="flex items-center gap-2 px-4 pb-1 pt-4">
				<LhMark className="size-6" />
				<h1 className="font-ui text-sm uppercase tracking-wider text-muted-foreground">LearnHarness</h1>
			</header>
			<main className="mx-auto flex w-full max-w-[34rem] flex-col gap-6 px-4 pb-28 pt-3">
				<section aria-label="Capture" className="flex flex-col gap-2">
					<CaptureBox state={captures} autoFocus={false} />
					{captures.error && <p role="alert" className="text-sm text-destructive">{captures.error}</p>}
				</section>

				{captures.captures.length > 0 && (
					<section aria-label="Tonight's questions" data-testid="tonights-questions" className="flex flex-col gap-2">
						<h2 className="font-ui text-xs uppercase tracking-wider text-muted-foreground">
							Tonight&apos;s questions · {captures.captures.length}
						</h2>
						<ul className="flex flex-col gap-2">
							{captures.captures.map((c) => <CaptureRow key={c.id} capture={c} actions={captures} />)}
						</ul>
					</section>
				)}

				<section aria-label="Start a session" className="flex flex-col gap-2">
					<h2 className="font-ui text-xs uppercase tracking-wider text-muted-foreground">Start a session</h2>
					<div className="flex flex-col gap-2">
						<Link href="/chat/new" data-testid="phone-new-teaching" className={BIG_BUTTON}>
							<PlusIcon aria-hidden="true" className="size-4" /> New teaching session
						</Link>
						<Link href="/chat/new?mode=miss" data-testid="phone-explain-miss" className={BIG_BUTTON}>
							<ClipboardXIcon aria-hidden="true" className="size-4" /> Explain my miss
						</Link>
					</div>
				</section>

				<section aria-label="Continue" className="flex flex-col gap-1">
					<h2 className="font-ui text-xs uppercase tracking-wider text-muted-foreground">Continue</h2>
					{shown === null ? (
						<p className="text-sm text-muted-foreground">Loading…</p>
					) : shown.length === 0 ? (
						<p className="text-sm text-muted-foreground">No sessions yet.</p>
					) : (
						<ul data-testid="phone-sessions" className="-mx-1 flex flex-col">
							{shown.map((c) => <PhoneSessionRow key={c.id} chat={c} />)}
						</ul>
					)}
					{sessions && sessions.length > RECENT_SESSIONS && (
						<button
							type="button"
							onClick={() => setShowAll((v) => !v)}
							className={cn("min-h-11 self-start px-1 font-ui text-xs uppercase tracking-wider text-muted-foreground")}
						>
							{showAll ? "Show fewer" : `Show all ${sessions.length}`}
						</button>
					)}
				</section>
			</main>
		</div>
	);
}

export function PhoneHome({ initialConfigured }: { initialConfigured: boolean }) {
	const captures = useCaptures(initialConfigured);
	const [sessions, setSessions] = useState<ChatListItem[] | null>(null);

	useEffect(() => {
		let live = true;
		const load = () =>
			fetch("/api/chats", { cache: "no-store" })
				.then((r) => (r.ok ? (r.json() as Promise<{ chats: ChatListItem[] }>) : null))
				.then((body) => { if (live && body) setSessions(recentFirst(body.chats)); })
				.catch(() => { /* offline or restarting: the next refresh catches up */ });
		void load();
		const timer = setInterval(() => void load(), REFRESH_MS);
		const onVisible = () => { if (document.visibilityState === "visible") void load(); };
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			live = false;
			clearInterval(timer);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, []);

	return <PhoneHomeView captures={captures} sessions={sessions} />;
}
