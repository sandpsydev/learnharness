/**
 * THE QUEUED-STEER INDICATOR (owner spec 2026-10-03): steers sent but not
 * yet drained render as quiet one-liners ABOVE the composer shell —
 * right-aligned to where the shell's corner rounding starts, truncated
 * with an ellipsis, no background, no container, roughly half opacity.
 * Visible but very quiet; layout tunable later.
 *
 * A line dies the moment its card lands in the transcript: the drain's
 * verbatim message events upsert the real user card by the client-minted
 * id, and visibleQueuedSteers (session-core, pure) filters the queue
 * against the message ids. A steer parked server-side (stranded behind a
 * question) keeps its line — an honest "waiting for the next run".
 */
import type { JobRecord, LhMessage } from "@/src/core";

/** Returned Expert AI answers use verify_<itemId> tool-call keys. Highlights
 * and ordinary research share the delivery pipeline but do not belong here.
 * A live transcript marker clears the notice even before the next jobs fetch. */
export function pendingExpertAnswerNotice(jobs: readonly JobRecord[], chatId: string, messages: readonly LhMessage[]): string | null {
	const pickedUp = new Set(messages.map((m) => m.id));
	const count = jobs.filter((job) =>
		job.chatId === chatId && job.kind === "research" && job.toolCallId.startsWith("verify_") &&
		job.delivery?.kind === "result" && job.delivery.status === "pending" &&
		!pickedUp.has(`steer_${job.id}`),
	).length;
	if (count === 0) return null;
	return `Expert AI ${count === 1 ? "answer" : "answers"} received — your teacher will use ${count === 1 ? "it" : "them"} in its next reply`;
}

export interface QueuedSteerLine {
	id: string;
	text: string;
}

/** The pure body (SSR-pinnable): one right-aligned truncated line per
 *  queued steer, stacked. */
export function QueuedSteersBody({ steers, notice }: { steers: QueuedSteerLine[]; notice?: string | null }) {
	if (steers.length === 0 && !notice) return null;
	return (
		<div className="flex flex-col items-end gap-0.5 pb-1 pr-4" data-testid="queued-steers">
			{notice && (
				<span role="status" className="block max-w-full whitespace-normal text-right font-ui text-[11px] text-muted-foreground/60">
					{notice}
				</span>
			)}
			{steers.map((s) => (
				<span
					key={s.id}
					title={s.text}
					className="block max-w-[240px] truncate font-ui text-[11px] text-muted-foreground/60"
				>
					{s.text}
				</span>
			))}
		</div>
	);
}
