"use client";

/**
 * Quick practice on the phone (Pocket mode, Phase 8): pick the organ systems
 * you want (or none for everything), tap start, and answer a short round of
 * A–E questions drawn from your own graph. The round is an ordinary practice
 * session, so the questions are the Phase 3 tap-to-answer ones and grading is
 * the practice agent's, as on the Mac.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { DumbbellIcon } from "lucide-react";
import { OPENING_PROMPT_FAILURE } from "@/components/opening-prompt";
import { PhonePage } from "@/components/phone";
import { selectedModelUnavailable, useModelSetup } from "@/components/setup-cta";
import { SessionStarter } from "@/components/start-session";
import { cn } from "@/lib/utils";
import {
	QUICK_ROUND_QUESTIONS,
	nodesForSystems,
	quickPracticeOpening,
	quickPracticeTitle,
	sampleNodes,
	systemCounts,
	type GraphNode,
	type GraphSnapshot,
	type OrganSystem,
} from "@/src/core";

const SETUP_FIRST = "Set up your models on the Mac first, then try again.";

/** The screen as a pure function of its state (the render-test seam). */
export function QuickPracticeView({
	nodes,
	selected,
	onToggle,
	onClear,
	onStart,
	busy = false,
	error = null,
}: {
	/** null while the graph is loading. */
	nodes: readonly GraphNode[] | null;
	selected: ReadonlySet<OrganSystem>;
	onToggle: (id: OrganSystem) => void;
	onClear: () => void;
	onStart: () => void;
	busy?: boolean;
	error?: string | null;
}) {
	const counts = useMemo(() => systemCounts(nodes ?? []), [nodes]);
	const available = nodes ? nodesForSystems(nodes, selected).length : 0;
	const chip =
		"flex min-h-11 items-center gap-1.5 rounded-full border px-3.5 font-ui text-xs transition-colors disabled:opacity-40";
	return (
		<PhonePage title="Quick practice">
			<p className="text-sm text-muted-foreground">
				A short round of {QUICK_ROUND_QUESTIONS} questions from your own notes. Tap an answer, then submit.
			</p>
			<section aria-label="Organ systems" className="flex flex-col gap-2">
				<h2 className="font-ui text-xs uppercase tracking-wider text-muted-foreground">Organ system</h2>
				<div data-testid="system-chips" className="flex flex-wrap gap-2">
					<button
						type="button"
						aria-pressed={selected.size === 0}
						data-testid="system-chip-all"
						onClick={onClear}
						className={cn(chip, selected.size === 0 ? "border-primary bg-accent text-foreground" : "border-border text-muted-foreground")}
					>
						All systems
					</button>
					{counts.map(({ id, label, count }) => (
						<button
							key={id}
							type="button"
							aria-pressed={selected.has(id)}
							disabled={count === 0}
							data-testid={`system-chip-${id}`}
							onClick={() => onToggle(id)}
							className={cn(chip, selected.has(id) ? "border-primary bg-accent text-foreground" : "border-border text-muted-foreground")}
						>
							{label}
							<span className="text-muted-foreground/70">{count}</span>
						</button>
					))}
				</div>
			</section>
			{nodes === null ? (
				<p className="text-sm text-muted-foreground">Loading your notes…</p>
			) : nodes.length === 0 ? (
				<p data-testid="practice-empty" className="text-sm text-muted-foreground">
					Your graph is empty. Finish a teaching session first, then come back to practise it.
				</p>
			) : available === 0 ? (
				<p data-testid="practice-empty" className="text-sm text-muted-foreground">
					Nothing tagged with that system yet.
				</p>
			) : (
				<p className="text-sm text-muted-foreground">{available} {available === 1 ? "note" : "notes"} to draw from.</p>
			)}
			{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
			<button
				type="button"
				data-testid="practice-start"
				disabled={busy || nodes === null || available === 0}
				onClick={onStart}
				className="flex min-h-12 items-center justify-center gap-2 rounded-lg bg-primary px-4 font-ui text-sm text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
			>
				<DumbbellIcon aria-hidden="true" className="size-4" />
				Start a {QUICK_ROUND_QUESTIONS}-question round
			</button>
		</PhonePage>
	);
}

export function QuickPractice({ initialConfigured }: { initialConfigured: boolean }) {
	const router = useRouter();
	const { catalog, configured, zeroKeys } = useModelSetup(initialConfigured);
	const [nodes, setNodes] = useState<GraphNode[] | null>(null);
	const [selected, setSelected] = useState<ReadonlySet<OrganSystem>>(new Set());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const starterRef = useRef(new SessionStarter());

	useEffect(() => {
		let live = true;
		fetch("/api/graph", { cache: "no-store" })
			.then((r) => r.json() as Promise<GraphSnapshot>)
			.then((snap) => { if (live) setNodes(snap.propositions); })
			.catch(() => {
				if (live) {
					setNodes([]);
					setError("Couldn't load your notes. Try again in a moment.");
				}
			});
		return () => { live = false; };
	}, []);

	const start = async () => {
		if (!nodes || busy) return;
		if (catalog) {
			const strong = catalog.slots.strong?.model;
			if (!configured || zeroKeys || selectedModelUnavailable(catalog, strong ? `${strong.provider}:${strong.id}` : undefined)) {
				setError(SETUP_FIRST);
				return;
			}
		}
		const picks = sampleNodes(nodesForSystems(nodes, selected)).map(({ id, name, statement }) => ({ id, name, statement }));
		if (picks.length === 0) return;
		setBusy(true);
		setError(null);
		try {
			const target = await starterRef.current.start({
				title: quickPracticeTitle(selected),
				kind: "practice",
				openingText: quickPracticeOpening(selected),
				graphContext: { propositions: picks },
			}, fetch, JSON.stringify(catalog?.slots.strong));
			router.push(target);
		} catch {
			setBusy(false);
			setError(OPENING_PROMPT_FAILURE);
		}
	};

	return (
		<QuickPracticeView
			nodes={nodes}
			selected={selected}
			onToggle={(id) => setSelected((prev) => {
				const next = new Set(prev);
				if (!next.delete(id)) next.add(id);
				return next;
			})}
			onClear={() => setSelected(new Set())}
			onStart={() => void start()}
			busy={busy}
			error={error}
		/>
	);
}
