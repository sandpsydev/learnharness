"use client";

/**
 * The outline on the graph page (docs/medical-spec.md "Textbook outline
 * placement"): the learner's facts laid out like a textbook contents page —
 * organ system → topic (disease) → aspect — with counts and a search box.
 * Clicking a branch filters the graph to just those facts (and frames them);
 * clicking a fact opens it, as clicking its node does. The reasoning lines
 * stay underneath: the graph itself is unchanged, the outline only decides
 * which nodes are visible.
 *
 * Placement is automatic (src/server/placement.ts) — there is nothing to
 * approve here. A best-guess placement carries a small "?" and nothing more;
 * the footer states quietly what the placer is doing and offers to undo its
 * last run.
 *
 * The pure half (tree building, selection, visibility) is exported for tests;
 * the selection is held in a small shared store, like the tag filter.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ChevronRightIcon, Loader2Icon, ListTreeIcon, SearchIcon, Undo2Icon, XIcon } from "lucide-react";
import {
	ORGAN_SYSTEMS,
	PLACEMENT_ASPECTS,
	type GraphNode,
	type NodePlacement,
	type OrganSystem,
	type PlacementAspect,
	type PlacementTopic,
	type PlacementView,
	type PlacerRun,
} from "@/src/core";
import { Hint } from "@/components/ui/hint";
import { RecentFacts, ViewModeToggle, type GraphViewMode } from "@/components/graph-trail.tsx";

// ---- The selection (shared store) -------------------------------------------

/** One branch of the outline. Absent fields mean "any": a system alone is the
 *  whole system; system + topic is the topic; + aspect is one aspect of it. */
export interface OutlineSelection {
	system?: OrganSystem;
	topicId?: string;
	aspect?: PlacementAspect;
	/** Facts with no place yet. */
	unplaced?: true;
}

let activeSelection: OutlineSelection | null = null;
const selectionListeners = new Set<() => void>();

export function getOutlineSelection(): OutlineSelection | null {
	return activeSelection;
}

export function setOutlineSelection(next: OutlineSelection | null): void {
	activeSelection = next;
	for (const listener of selectionListeners) listener();
}

function subscribeSelection(listener: () => void): () => void {
	selectionListeners.add(listener);
	return () => void selectionListeners.delete(listener);
}

/** React binding for the shared selection (server snapshot: none). */
export function useOutlineSelection(): OutlineSelection | null {
	return useSyncExternalStore(subscribeSelection, getOutlineSelection, () => null);
}

export function sameSelection(a: OutlineSelection | null, b: OutlineSelection | null): boolean {
	if (a === null || b === null) return a === b;
	return a.system === b.system && a.topicId === b.topicId && a.aspect === b.aspect && a.unplaced === b.unplaced;
}

// ---- Tree building (pure) ---------------------------------------------------

export interface OutlineFact {
	node: GraphNode;
	/** The placer was guessing. */
	low: boolean;
}

export interface OutlineAspectGroup {
	id: PlacementAspect;
	label: string;
	facts: OutlineFact[];
}

export interface OutlineTopicGroup {
	topic: PlacementTopic;
	count: number;
	aspects: OutlineAspectGroup[];
}

export interface OutlineSystemGroup {
	id: OrganSystem;
	label: string;
	count: number;
	topics: OutlineTopicGroup[];
}

export interface OutlineTree {
	systems: OutlineSystemGroup[];
	unplaced: GraphNode[];
	/** Facts the query leaves in the tree (placed or not). */
	total: number;
}

const byName = (a: GraphNode, b: GraphNode) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/**
 * The contents tree. `query` keeps the facts whose name or statement contains
 * it, plus every fact under a topic or system whose name contains it; empty
 * branches drop out. Systems follow the fixed list order, topics and facts go
 * by name, aspects follow the illness-script order.
 */
export function buildOutline(nodes: readonly GraphNode[], placement: PlacementView | undefined, query = ""): OutlineTree {
	const q = query.trim().toLowerCase();
	const topicById = new Map((placement?.topics ?? []).map((t) => [t.id, t]));
	const systemLabel = new Map<string, string>(ORGAN_SYSTEMS.map((s) => [s.id, s.label]));
	const matchesText = (n: GraphNode) => q === "" || n.name.toLowerCase().includes(q) || n.statement.toLowerCase().includes(q);

	const unplaced: GraphNode[] = [];
	const perTopic = new Map<string, OutlineFact[]>();
	for (const node of [...nodes].sort(byName)) {
		const p: NodePlacement | undefined = placement?.byNode[node.id];
		const topic = p ? topicById.get(p.topicId) : undefined;
		if (!p || !topic) {
			if (matchesText(node)) unplaced.push(node);
			continue;
		}
		const branchMatch = q !== "" && (topic.name.toLowerCase().includes(q) || (systemLabel.get(topic.system) ?? "").toLowerCase().includes(q));
		if (!branchMatch && !matchesText(node)) continue;
		const list = perTopic.get(topic.id) ?? [];
		list.push({ node, low: p.confidence === "low" });
		perTopic.set(topic.id, list);
	}

	let total = unplaced.length;
	const systems: OutlineSystemGroup[] = [];
	for (const s of ORGAN_SYSTEMS) {
		const topics: OutlineTopicGroup[] = [];
		for (const topic of [...(placement?.topics ?? [])].filter((t) => t.system === s.id).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))) {
			const facts = perTopic.get(topic.id);
			if (!facts || facts.length === 0) continue;
			const aspects = PLACEMENT_ASPECTS.map((a): OutlineAspectGroup => ({
				id: a.id,
				label: a.label,
				facts: facts.filter((f) => placement?.byNode[f.node.id]?.aspect === a.id),
			})).filter((a) => a.facts.length > 0);
			topics.push({ topic, count: facts.length, aspects });
		}
		if (topics.length === 0) continue;
		const count = topics.reduce((sum, t) => sum + t.count, 0);
		total += count;
		systems.push({ id: s.id as OrganSystem, label: s.label, count, topics });
	}
	return { systems, unplaced, total };
}

// ---- Selection → which nodes show (pure) ------------------------------------

/** Does a fact fall in the selected branch? */
export function isNodeInSelection(nodeId: string, placement: PlacementView | undefined, selection: OutlineSelection): boolean {
	const p = placement?.byNode[nodeId];
	if (selection.unplaced) return p === undefined;
	if (!p) return false;
	if (selection.topicId !== undefined && p.topicId !== selection.topicId) return false;
	if (selection.aspect !== undefined && p.aspect !== selection.aspect) return false;
	if (selection.system !== undefined) {
		const topic = placement?.topics.find((t) => t.id === p.topicId);
		if (!topic || topic.system !== selection.system) return false;
	}
	return true;
}

/** The ids that survive the selection. Propositions go through isNodeInSelection;
 *  a derived implication node (a multi-premise chain's junction) is visible exactly
 *  when its conclusion and every premise are, so a chain never draws into a hidden
 *  node — the same rule the tag filter uses. */
export function outlineVisibleIds(
	nodes: ReadonlyArray<Pick<GraphNode, "id">>,
	impLinks: ReadonlyArray<{ id: string; premises: string[]; conclusion: string }>,
	placement: PlacementView | undefined,
	selection: OutlineSelection,
): Set<string> {
	const visible = new Set<string>();
	const imp = new Map(impLinks.map((l) => [l.id, l]));
	for (const node of nodes) {
		if (!imp.has(node.id) && isNodeInSelection(node.id, placement, selection)) visible.add(node.id);
	}
	for (const link of imp.values()) {
		if (visible.has(link.conclusion) && link.premises.every((p) => visible.has(p))) visible.add(link.id);
	}
	return visible;
}

/** "GI/Hepatobiliary › Small-bowel obstruction › Presentation" for the filter chip. */
export function selectionLabel(selection: OutlineSelection, placement: PlacementView | undefined): string {
	if (selection.unplaced) return "Not placed yet";
	const parts: string[] = [];
	const topic = selection.topicId !== undefined ? placement?.topics.find((t) => t.id === selection.topicId) : undefined;
	const system = selection.system ?? topic?.system;
	if (system) parts.push(ORGAN_SYSTEMS.find((s) => s.id === system)?.label ?? system);
	if (topic) parts.push(topic.name);
	if (selection.aspect) parts.push(PLACEMENT_ASPECTS.find((a) => a.id === selection.aspect)?.label ?? selection.aspect);
	return parts.join(" › ");
}

// ---- Presentational pieces ---------------------------------------------------

const rowBase = "flex min-h-8 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-xs transition-colors hover:bg-accent";

function Count({ n }: { n: number }) {
	return <span className="ml-auto shrink-0 pl-2 tabular-nums text-muted-foreground">{n}</span>;
}

function Caret({ open }: { open: boolean }) {
	return <ChevronRightIcon className={`size-3 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />;
}

export interface OutlineTreeViewProps {
	tree: OutlineTree;
	selection: OutlineSelection | null;
	/** Branch keys that are open ("s:renal", "t:t_ab12"). */
	open: ReadonlySet<string>;
	/** Open everything (a search is on). */
	forceOpen: boolean;
	onToggle: (key: string) => void;
	onSelect: (selection: OutlineSelection) => void;
	onOpenFact: (nodeId: string) => void;
}

/** The tree itself. Exported for static render tests. */
export function OutlineTreeView({ tree, selection, open, forceOpen, onToggle, onSelect, onOpenFact }: OutlineTreeViewProps) {
	const isOpen = (key: string) => forceOpen || open.has(key);
	const active = (s: OutlineSelection) => sameSelection(selection, s);
	const activeCls = (s: OutlineSelection) => (active(s) ? " bg-accent font-medium text-foreground" : " text-foreground");

	if (tree.systems.length === 0 && tree.unplaced.length === 0) {
		return (
			<div data-testid="outline-empty" className="px-1.5 py-3 text-xs text-muted-foreground">
				Nothing matches.
			</div>
		);
	}
	return (
		<ul data-testid="outline-tree" className="flex flex-col gap-0.5">
			{tree.systems.map((system) => {
				const sKey = `s:${system.id}`;
				const sSel: OutlineSelection = { system: system.id };
				return (
					<li key={system.id}>
						<div className="flex items-center">
							<button type="button" aria-label={isOpen(sKey) ? "Collapse" : "Expand"} aria-expanded={isOpen(sKey)} onClick={() => onToggle(sKey)} className="flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-accent">
								<Caret open={isOpen(sKey)} />
							</button>
							<button type="button" data-testid={`outline-system-${system.id}`} aria-pressed={active(sSel)} onClick={() => onSelect(sSel)} className={`${rowBase}${activeCls(sSel)}`}>
								<span className="truncate">{system.label}</span>
								<Count n={system.count} />
							</button>
						</div>
						{isOpen(sKey) && (
							<ul className="ml-4 flex flex-col gap-0.5 border-l pl-1.5">
								{system.topics.map((t) => {
									const tKey = `t:${t.topic.id}`;
									const tSel: OutlineSelection = { system: system.id, topicId: t.topic.id };
									return (
										<li key={t.topic.id}>
											<div className="flex items-center">
												<button type="button" aria-label={isOpen(tKey) ? "Collapse" : "Expand"} aria-expanded={isOpen(tKey)} onClick={() => onToggle(tKey)} className="flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-accent">
													<Caret open={isOpen(tKey)} />
												</button>
												<button type="button" data-testid={`outline-topic-${t.topic.id}`} aria-pressed={active(tSel)} onClick={() => onSelect(tSel)} className={`${rowBase}${activeCls(tSel)}`}>
													<span className="truncate">{t.topic.name}</span>
													<Count n={t.count} />
												</button>
											</div>
											{isOpen(tKey) && (
												<ul className="ml-4 flex flex-col gap-0.5 border-l pl-1.5">
													{t.aspects.map((a) => {
														const aKey = `a:${t.topic.id}:${a.id}`;
														const aSel: OutlineSelection = { system: system.id, topicId: t.topic.id, aspect: a.id };
														return (
															<li key={a.id}>
																<div className="flex items-center">
																	<button type="button" aria-label={isOpen(aKey) ? "Collapse" : "Expand"} aria-expanded={isOpen(aKey)} onClick={() => onToggle(aKey)} className="flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-accent">
																		<Caret open={isOpen(aKey)} />
																	</button>
																	<button type="button" data-testid={`outline-aspect-${t.topic.id}-${a.id}`} aria-pressed={active(aSel)} onClick={() => onSelect(aSel)} className={`${rowBase}${activeCls(aSel)}`}>
																		<span className="truncate">{a.label}</span>
																		<Count n={a.facts.length} />
																	</button>
																</div>
																{isOpen(aKey) && (
																	<ul className="ml-4 flex flex-col gap-0.5 border-l pl-1.5">
																		{a.facts.map((f) => (
																			<li key={f.node.id}>
																				<button type="button" data-testid={`outline-fact-${f.node.id}`} onClick={() => onOpenFact(f.node.id)} title={f.node.statement} className={`${rowBase} text-muted-foreground hover:text-foreground`}>
																					<span className="line-clamp-2">{f.node.name}</span>
																					{f.low && (
																						<span data-testid="outline-low" title="A best guess" aria-label="A best guess" className="ml-auto shrink-0 pl-1 text-muted-foreground/60">
																							?
																						</span>
																					)}
																				</button>
																			</li>
																		))}
																	</ul>
																)}
															</li>
														);
													})}
												</ul>
											)}
										</li>
									);
								})}
							</ul>
						)}
					</li>
				);
			})}
			{tree.unplaced.length > 0 && (
				<li>
					<div className="flex items-center">
						<button type="button" aria-label={isOpen("u") ? "Collapse" : "Expand"} aria-expanded={isOpen("u")} onClick={() => onToggle("u")} className="flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-accent">
							<Caret open={isOpen("u")} />
						</button>
						<button type="button" data-testid="outline-unplaced" aria-pressed={active({ unplaced: true })} onClick={() => onSelect({ unplaced: true })} className={`${rowBase}${activeCls({ unplaced: true })}`}>
							<span className="truncate text-muted-foreground">Not placed yet</span>
							<Count n={tree.unplaced.length} />
						</button>
					</div>
					{isOpen("u") && (
						<ul className="ml-4 flex flex-col gap-0.5 border-l pl-1.5">
							{tree.unplaced.map((n) => (
								<li key={n.id}>
									<button type="button" data-testid={`outline-fact-${n.id}`} onClick={() => onOpenFact(n.id)} title={n.statement} className={`${rowBase} text-muted-foreground hover:text-foreground`}>
										<span className="line-clamp-2">{n.name}</span>
									</button>
								</li>
							))}
						</ul>
					)}
				</li>
			)}
		</ul>
	);
}

/** What the server says the placer is doing (GET /api/graph/placements). */
export interface PlacementStatusView {
	running: boolean;
	unplaced: number;
	total: number;
	problem?: "no-model" | "no-key" | "failed";
	lastRun?: PlacerRun;
}

/** The quiet footer line. Never an action the learner must take. */
export function PlacementFooter({
	status,
	withdrawn,
	busy,
	onUndo,
	onPlaceAgain,
}: {
	status: PlacementStatusView | null;
	/** Facts whose placement was withdrawn by an undo. */
	withdrawn: number;
	busy: boolean;
	onUndo: (runId: string) => void;
	onPlaceAgain: () => void;
}) {
	if (!status && withdrawn === 0) return null;
	const waiting = status?.problem === "no-model" || status?.problem === "no-key";
	return (
		<div data-testid="outline-footer" className="mt-2 flex flex-col gap-1 border-t pt-2 text-[11px] text-muted-foreground">
			{status && (status.running || status.unplaced > 0) && (
				<div data-testid="outline-placing" className="flex items-center gap-1.5">
					{status.running && <Loader2Icon className="size-3 animate-spin" />}
					{status.running
						? `Placing ${status.unplaced} ${status.unplaced === 1 ? "fact" : "facts"}…`
						: waiting
							? `${status.unplaced} ${status.unplaced === 1 ? "fact" : "facts"} will be placed once a model is available.`
							: `${status.unplaced} ${status.unplaced === 1 ? "fact" : "facts"} waiting to be placed.`}
				</div>
			)}
			{withdrawn > 0 && (
				<div className="flex items-center gap-1.5">
					<span>{withdrawn} {withdrawn === 1 ? "fact is" : "facts are"} unplaced after an undo.</span>
					<button type="button" data-testid="outline-place-again" disabled={busy} onClick={onPlaceAgain} className="underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50">
						Place again
					</button>
				</div>
			)}
			{status?.lastRun && (
				<div className="flex items-center gap-1.5">
					<span>
						Last automatic placement: {status.lastRun.placed} {status.lastRun.placed === 1 ? "fact" : "facts"}
					</span>
					<button type="button" data-testid="outline-undo" disabled={busy || status.running} onClick={() => onUndo(status.lastRun!.id)} className="flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50">
						<Undo2Icon className="size-3" />
						Undo
					</button>
				</div>
			)}
		</div>
	);
}

// ---- The chrome button + the panel ------------------------------------------

/** The Outline button in the graph's top-right row. */
export function GraphOutlineButton({ open, onToggle, filtered }: { open: boolean; onToggle: () => void; filtered: boolean }) {
	return (
		<Hint label="Browse the graph like a textbook contents page" side="bottom">
			<button
				type="button"
				aria-expanded={open}
				onClick={onToggle}
				data-testid="open-outline"
				className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent"
			>
				<ListTreeIcon className="size-3" />
				Outline
				{filtered && <span aria-hidden className="size-1.5 rounded-full bg-primary" />}
			</button>
		</Hint>
	);
}

export function GraphOutlinePanel({
	nodes,
	placement,
	selection,
	onSelect,
	onClear,
	onOpenFact,
	onClose,
	onChanged,
	initialOpen,
	view,
	recents,
	currentId,
}: {
	/** The stored propositions (no derived implication nodes). */
	nodes: ReadonlyArray<GraphNode>;
	placement: PlacementView | undefined;
	selection: OutlineSelection | null;
	onSelect: (selection: OutlineSelection) => void;
	onClear: () => void;
	onOpenFact: (nodeId: string) => void;
	onClose: () => void;
	/** A run was undone or re-run — the caller refetches the graph. */
	onChanged: (graphRevision: number) => void;
	/** Branch keys open at the start (tests, and restoring a selection). */
	initialOpen?: ReadonlySet<string>;
	/** How the graph is drawn (topic bubbles / all facts) — the switch shows when supplied. */
	view?: { mode: GraphViewMode; onMode: (mode: GraphViewMode) => void; openTopics: number; onCollapseAll: () => void };
	/** Recently visited facts, newest first. */
	recents?: ReadonlyArray<GraphNode>;
	/** The fact whose card is open, if any. */
	currentId?: string | null;
}) {
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState<ReadonlySet<string>>(initialOpen ?? new Set());
	const [status, setStatus] = useState<PlacementStatusView | null>(null);
	const [busy, setBusy] = useState(false);
	const tree = useMemo(() => buildOutline(nodes, placement, query), [nodes, placement, query]);
	const searching = query.trim() !== "";

	// The placer's state, for the quiet footer (fetched when the panel opens).
	useEffect(() => {
		let cancelled = false;
		void fetch("/api/graph/placements")
			.then((r) => r.json() as Promise<PlacementStatusView>)
			.then((s) => {
				if (!cancelled) setStatus(s);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [placement]);

	const toggle = (key: string) =>
		setOpen((cur) => {
			const next = new Set(cur);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});

	// Choosing a branch also opens it, so the learner sees what is inside.
	const select = (s: OutlineSelection) => {
		setOpen((cur) => {
			const next = new Set(cur);
			if (s.system) next.add(`s:${s.system}`);
			if (s.topicId) next.add(`t:${s.topicId}`);
			if (s.unplaced) next.add("u");
			return next;
		});
		onSelect(s);
	};

	const act = async (body: Record<string, unknown>) => {
		setBusy(true);
		try {
			const res = await fetch("/api/graph/placements", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			const data = (await res.json().catch(() => ({}))) as { status?: PlacementStatusView; graphRevision?: number };
			if (data.status) setStatus(data.status);
			onChanged(data.graphRevision ?? 0);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div
			data-testid="outline-panel"
			// Desktop: a contents column down the left. Phone: a sheet along the bottom.
			className="lh-no-drag absolute inset-x-2 bottom-2 z-20 flex max-h-[68%] flex-col rounded-xl border bg-card/95 p-2.5 shadow-lg backdrop-blur sm:inset-x-auto sm:bottom-auto sm:left-3 sm:top-14 sm:max-h-[calc(100%-4.25rem)] sm:w-80"
		>
			<div className="mb-2 flex items-center gap-1.5">
				<div className="relative min-w-0 flex-1">
					<SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
					<input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Search the outline…"
						aria-label="Search the outline"
						data-testid="outline-search"
						spellCheck={false}
						className="h-8 w-full rounded-lg border bg-background pl-8 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
					/>
				</div>
				<button type="button" aria-label="Close the outline" data-testid="outline-close" onClick={onClose} className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground">
					<XIcon className="size-4" />
				</button>
			</div>
			{view && <ViewModeToggle {...view} />}
			{selection && (
				<div className="mb-2 flex items-center gap-1.5 rounded-lg bg-accent/60 px-2 py-1 text-[11px]">
					<span className="text-muted-foreground">Showing</span>
					<span data-testid="outline-showing" className="min-w-0 flex-1 truncate font-medium">
						{selectionLabel(selection, placement)}
					</span>
					<button type="button" data-testid="outline-show-all" onClick={onClear} className="shrink-0 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
						Show all
					</button>
				</div>
			)}
			<div className="min-h-0 flex-1 overflow-y-auto">
				{!searching && recents && <RecentFacts facts={recents} currentId={currentId} onOpen={onOpenFact} />}
				<OutlineTreeView
					tree={tree}
					selection={selection}
					open={open}
					forceOpen={searching}
					onToggle={toggle}
					onSelect={select}
					onOpenFact={onOpenFact}
				/>
				<PlacementFooter
					status={status}
					withdrawn={placement?.withdrawn ?? 0}
					busy={busy}
					onUndo={(runId) => void act({ action: "revert", runId })}
					onPlaceAgain={() => void act({ action: "run" })}
				/>
			</div>
		</div>
	);
}
