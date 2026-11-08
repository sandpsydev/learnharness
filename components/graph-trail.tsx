"use client";

/**
 * The small navigation pieces of the graph page (medical fork), apart from
 * the outline itself: the breadcrumb on a fact's card, the recently-visited
 * list, the focus-mode chip and the bubbles / all-facts switch. Presentational
 * only — the graph page owns the state (components/graph-view.tsx) and the
 * logic is in components/graph-navigation.ts.
 */

import { CrosshairIcon, HistoryIcon, XIcon } from "lucide-react";
import type { GraphNode } from "@/src/core";
import type { OutlineSelection } from "@/components/graph-outline.tsx";
import type { BreadcrumbPart } from "@/components/graph-navigation.ts";

/** System › Topic › Aspect, each part a button that jumps to that branch. */
export function FactBreadcrumb({
	parts,
	onJump,
}: {
	parts: readonly BreadcrumbPart[];
	onJump: (selection: OutlineSelection) => void;
}) {
	const btn =
		"min-h-7 max-w-full rounded-md px-1 text-left text-[11px] leading-tight text-muted-foreground underline-offset-2 transition-colors hover:bg-accent hover:text-foreground hover:underline sm:min-h-5";
	if (parts.length === 0) {
		return (
			<nav aria-label="Where this fact sits" data-testid="fact-breadcrumb" className="mt-1.5">
				<button type="button" data-testid="fact-breadcrumb-unplaced" onClick={() => onJump({ unplaced: true })} className={btn}>
					Not placed yet
				</button>
			</nav>
		);
	}
	return (
		<nav aria-label="Where this fact sits" data-testid="fact-breadcrumb" className="mt-1.5">
			<ol className="flex flex-wrap items-center gap-x-0.5 gap-y-0.5">
				{parts.map((part, i) => (
					<li key={part.kind} className="flex min-w-0 items-center gap-0.5">
						{i > 0 && (
							<span aria-hidden className="text-[11px] text-muted-foreground/60">
								›
							</span>
						)}
						<button type="button" data-testid={`fact-breadcrumb-${part.kind}`} onClick={() => onJump(part.selection)} className={btn}>
							<span className="line-clamp-2">{part.label}</span>
						</button>
					</li>
				))}
			</ol>
		</nav>
	);
}

/** Recently visited facts, newest first. Renders nothing when there are none. */
export function RecentFacts({
	facts,
	currentId,
	onOpen,
}: {
	facts: readonly Pick<GraphNode, "id" | "name" | "statement">[];
	currentId?: string | null;
	onOpen: (nodeId: string) => void;
}) {
	if (facts.length === 0) return null;
	return (
		<section data-testid="recent-facts" aria-label="Recently visited facts" className="mb-2 border-b pb-2">
			<div className="mb-0.5 flex items-center gap-1.5 px-1.5 text-[11px] text-muted-foreground">
				<HistoryIcon className="size-3" />
				Recent
			</div>
			<ul className="flex flex-col gap-0.5">
				{facts.map((f) => (
					<li key={f.id}>
						<button
							type="button"
							data-testid={`recent-fact-${f.id}`}
							aria-current={f.id === currentId ? "true" : undefined}
							onClick={() => onOpen(f.id)}
							title={f.statement}
							className={`flex min-h-8 w-full items-center rounded-md px-1.5 text-left text-xs transition-colors hover:bg-accent ${f.id === currentId ? "bg-accent/60 font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
						>
							<span className="line-clamp-2">{f.name}</span>
						</button>
					</li>
				))}
			</ul>
		</section>
	);
}

/** "Focused on <fact>" with the way out. Sits in the graph's top-right column. */
export function FocusChip({ name, onExit }: { name: string; onExit: () => void }) {
	return (
		<div
			data-testid="focus-chip"
			className="flex max-w-full items-center gap-2 rounded-full border bg-card/90 py-1 pl-3 pr-1 text-xs shadow-lg backdrop-blur"
		>
			<CrosshairIcon className="size-3.5 shrink-0 text-muted-foreground" />
			<span className="text-muted-foreground">Focused on</span>
			<span data-testid="focus-chip-name" className="min-w-0 max-w-48 truncate font-medium text-foreground">
				{name}
			</span>
			<button
				type="button"
				data-testid="focus-exit"
				onClick={onExit}
				aria-label="Exit focus"
				className="flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				<XIcon className="size-3.5" />
				Exit focus
			</button>
		</div>
	);
}

export type GraphViewMode = "topics" | "all";

/** Topic bubbles / all facts, plus "Collapse all" while topics are open. */
export function ViewModeToggle({
	mode,
	onMode,
	openTopics,
	onCollapseAll,
}: {
	mode: GraphViewMode;
	onMode: (mode: GraphViewMode) => void;
	openTopics: number;
	onCollapseAll: () => void;
}) {
	const seg = (m: GraphViewMode, label: string) => (
		<button
			type="button"
			data-testid={`view-mode-${m}`}
			aria-pressed={mode === m}
			onClick={() => onMode(m)}
			className={`min-h-8 flex-1 rounded-md px-2 text-xs transition-colors ${mode === m ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/60"}`}
		>
			{label}
		</button>
	);
	return (
		<div className="mb-2 flex items-center gap-1.5">
			<div role="group" aria-label="How the graph is drawn" className="flex min-w-0 flex-1 gap-0.5 rounded-lg border p-0.5">
				{seg("topics", "Topics")}
				{seg("all", "All facts")}
			</div>
			{mode === "topics" && openTopics > 0 && (
				<button type="button" data-testid="collapse-all" onClick={onCollapseAll} className="min-h-8 shrink-0 rounded-md px-2 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
					Collapse all
				</button>
			)}
		</div>
	);
}
