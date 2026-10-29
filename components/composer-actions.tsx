"use client";

import type { ReactNode } from "react";
import { ClipboardXIcon, DumbbellIcon, XIcon } from "lucide-react";

/** Home and the draft share one wrapping action row. Picker controls lead;
 * setup is centered only when it is the sole action. */
export function ComposerActions({ picker, action, setup }: { picker?: ReactNode; action?: ReactNode; setup?: ReactNode }) {
	if (!picker && !action && !setup) return null;
	return (
		<div
			data-testid="composer-actions"
			className={`pointer-events-auto mb-2 flex flex-wrap items-center gap-2 ${picker || action ? "justify-start" : "justify-center"}`}
		>
			{picker}
			{action}
			{setup}
		</div>
	);
}

/** Count and Clear stay together if the setup action wraps onto another line.
 * These are node counts, even when a whole chain supplied the selection. */
export function NodePickerControl({ count, onOpen, onClear }: {
	count: number;
	onOpen?: () => void;
	onClear?: () => void;
}) {
	return (
		<div className="flex items-center gap-1.5">
			<button
				type="button"
				data-testid="practice-props-chip"
				onClick={onOpen}
				className={
					"flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 font-ui text-xs transition-colors " +
					(count > 0
						? "border-border bg-card text-foreground hover:bg-accent"
						: "border-dashed border-border/80 bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground")
				}
			>
				<DumbbellIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
				{count > 0 ? `${count} ${count === 1 ? "node" : "nodes"} selected` : "Pick nodes"}
			</button>
			{count > 0 && (
				<button
					type="button"
					data-testid="practice-props-clear"
					onClick={onClear}
					className="cursor-pointer rounded-full px-2 py-1 font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					Clear
				</button>
			)}
		</div>
	);
}

/** The new-session screen's "Explain my miss" entry (Phase 7): starts the
 * miss flow for one question-bank question the learner got wrong. */
export function ExplainMissAction({ onOpen }: { onOpen?: () => void }) {
	return (
		<button
			type="button"
			data-testid="explain-miss-action"
			onClick={onOpen}
			className="flex cursor-pointer items-center gap-1.5 rounded-full border border-dashed border-border/80 bg-transparent px-3 py-1.5 font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
		>
			<ClipboardXIcon aria-hidden="true" className="size-3.5" />
			Explain my miss
		</button>
	);
}

/** Shown instead of the entry while the draft is in the miss flow. */
export function ExplainMissActive({ onLeave }: { onLeave?: () => void }) {
	return (
		<div className="flex items-center gap-1.5" data-testid="explain-miss-active">
			<span className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 font-ui text-xs text-foreground">
				<ClipboardXIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
				Explain my miss
			</span>
			<button
				type="button"
				data-testid="explain-miss-leave"
				aria-label="Leave Explain my miss"
				onClick={onLeave}
				className="cursor-pointer rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				<XIcon aria-hidden="true" className="size-3.5" />
			</button>
		</div>
	);
}
