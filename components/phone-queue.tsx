"use client";

/**
 * The Expert AI queue on the phone (Pocket mode, Phase 8): VIEW ONLY. It
 * shows the questions the teacher has lined up. Asking stays at the Mac, in
 * the Chrome extension, so there is deliberately no button, field or form
 * here that could ask, answer or dismiss one. The only links go to the
 * session a question came from.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { PhonePage } from "@/components/phone";
import { timeAgo } from "@/components/sidebar";

/** The shape GET /api/verify/queue returns (mirrors the server's QueueEntry). */
export interface QueueRow {
	id: string;
	chatId: string;
	chatTitle: string;
	prompt: string;
	status: "queued" | "asked";
	createdAt: string;
}

const REFRESH_MS = 30_000;

export function QueueView({ queue, now }: { queue: readonly QueueRow[] | null; now?: Date }) {
	return (
		<PhonePage title="Expert AI queue">
			<p data-testid="queue-note" className="text-sm text-muted-foreground">
				These are waiting to be asked. Asking happens on the Mac, in Chrome. This list is just for looking.
			</p>
			{queue === null ? (
				<p className="text-sm text-muted-foreground">Loading…</p>
			) : queue.length === 0 ? (
				<p data-testid="queue-empty" className="text-sm text-muted-foreground">Nothing waiting.</p>
			) : (
				<ul data-testid="queue-list" className="flex flex-col gap-2">
					{queue.map((q) => (
						<li key={q.id} data-testid="queue-row" className="flex flex-col gap-1.5 rounded-lg border border-border bg-card/60 p-3">
							<p className="whitespace-pre-wrap break-words text-sm leading-snug">{q.prompt}</p>
							<p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
								<span data-testid="queue-status">{q.status === "asked" ? "Asked, waiting for the answer" : "Waiting to be asked"}</span>
								<span aria-hidden="true">·</span>
								<span>{timeAgo(q.createdAt, now)}</span>
							</p>
							{q.chatTitle && (
								<Link href={`/chat/${q.chatId}`} className="min-h-11 content-center text-xs text-muted-foreground underline underline-offset-2">
									From: {q.chatTitle}
								</Link>
							)}
						</li>
					))}
				</ul>
			)}
		</PhonePage>
	);
}

export function PhoneQueue() {
	const [queue, setQueue] = useState<QueueRow[] | null>(null);
	useEffect(() => {
		let live = true;
		const load = () =>
			fetch("/api/verify/queue", { cache: "no-store" })
				.then((r) => (r.ok ? (r.json() as Promise<{ queue: QueueRow[] }>) : null))
				.then((body) => { if (live && body) setQueue(body.queue); })
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
	return <QueueView queue={queue} />;
}
