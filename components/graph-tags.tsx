"use client";

/**
 * Medical tags in the graph view (docs/medical-spec.md Phase 4): the filter
 * chips (organ system + fact type), the one-off "tag existing nodes"
 * back-fill button, and the tag editor on a node's detail card. The value
 * lists come from the ONE shared place, src/core/contracts/graph.ts.
 *
 * The layout is untouched (owner decision): a filter only changes which
 * nodes are visible, exactly like the search box does.
 */

import { useRef, useState, useSyncExternalStore } from "react";
import { Loader2Icon, TagsIcon } from "lucide-react";
import {
	FACT_TYPES,
	ORGAN_SYSTEMS,
	factTypeLabel,
	isUntagged,
	organSystemLabel,
	type FactType,
	type GraphNode,
	type GraphNodeTags,
	type OrganSystem,
} from "@/src/core";
import { Hint } from "@/components/ui/hint";
import { usePopoverDismiss } from "@/components/popover-dismiss";

// ---- The filter (pure) ------------------------------------------------------

export interface TagFilter {
	systems: ReadonlySet<OrganSystem>;
	factTypes: ReadonlySet<FactType>;
}

export const EMPTY_TAG_FILTER: TagFilter = { systems: new Set(), factTypes: new Set() };

export function isTagFilterActive(filter: TagFilter): boolean {
	return filter.systems.size > 0 || filter.factTypes.size > 0;
}

// The active filter is shared by the graph and practice-select overlay.
// Immutable snapshots let useSyncExternalStore track chip changes.
let activeTagFilter: TagFilter = EMPTY_TAG_FILTER;
const tagFilterListeners = new Set<() => void>();

export function getTagFilter(): TagFilter {
	return activeTagFilter;
}

export function setTagFilter(next: TagFilter): void {
	activeTagFilter = next;
	for (const listener of tagFilterListeners) listener();
}

function subscribeTagFilter(listener: () => void): () => void {
	tagFilterListeners.add(listener);
	return () => void tagFilterListeners.delete(listener);
}

/** React binding for the shared filter (server snapshot: no filter). */
export function useTagFilter(): TagFilter {
	return useSyncExternalStore(subscribeTagFilter, getTagFilter, () => EMPTY_TAG_FILTER);
}

/** Does a node pass the filter? Within a group the chips OR (any selected
 *  system matches a multi-system node); the two groups AND. A node without
 *  the tag a group filters on does not pass that group — untagged nodes
 *  are hidden while a chip of that kind is on. */
export function isNodeTagVisible(node: GraphNodeTags, filter: TagFilter): boolean {
	if (filter.systems.size > 0 && !(node.systems ?? []).some((s) => filter.systems.has(s))) return false;
	if (filter.factTypes.size > 0 && (node.factType === undefined || !filter.factTypes.has(node.factType))) return false;
	return true;
}

/** The ids that survive the filter. Propositions go through
 *  isNodeTagVisible; a derived implication node (a multi-premise chain's
 *  junction — it carries no tags) is visible exactly when its conclusion
 *  and every premise are, so a chain never draws into a hidden node. */
export function tagVisibleIds(
	nodes: ReadonlyArray<GraphNode>,
	impLinks: ReadonlyArray<{ id: string; premises: string[]; conclusion: string }>,
	filter: TagFilter,
): Set<string> {
	const visible = new Set<string>();
	const imp = new Map(impLinks.map((l) => [l.id, l]));
	for (const node of nodes) {
		if (!imp.has(node.id) && isNodeTagVisible(node, filter)) visible.add(node.id);
	}
	for (const link of imp.values()) {
		if (visible.has(link.conclusion) && link.premises.every((p) => visible.has(p))) visible.add(link.id);
	}
	return visible;
}

// ---- Chips ------------------------------------------------------------------

function Chip({
	label,
	active,
	onClick,
	count,
	testId,
}: {
	label: string;
	active: boolean;
	onClick: () => void;
	count?: number;
	testId?: string;
}) {
	return (
		<button
			type="button"
			aria-pressed={active}
			data-testid={testId}
			onClick={onClick}
			className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
				active
					? "border-primary bg-primary text-primary-foreground"
					: "text-muted-foreground hover:bg-accent hover:text-foreground"
			}`}
		>
			{label}
			{count !== undefined && <span className="ml-1 tabular-nums opacity-70">{count}</span>}
		</button>
	);
}

function toggled<T>(set: ReadonlySet<T>, value: T): Set<T> {
	const next = new Set(set);
	if (next.has(value)) next.delete(value);
	else next.add(value);
	return next;
}

// ---- The graph's Tags control ----------------------------------------------

/** The chrome button + dropdown: filter chips for system and fact type
 *  (only values some node carries, with counts) and, while any node lacks a
 *  tag, the "Tag existing nodes" back-fill. Exported pure for SSR pins. */
export function GraphTagsPanel({
	nodes,
	filter,
	onFilter,
	onBackfilled,
	initiallyOpen = false,
}: {
	/** The stored propositions (no derived implication nodes). */
	nodes: ReadonlyArray<GraphNode>;
	filter: TagFilter;
	onFilter: (next: TagFilter) => void;
	/** The back-fill finished — the caller refetches the graph. */
	onBackfilled: (graphRevision: number) => void;
	initiallyOpen?: boolean;
}) {
	const [open, setOpen] = useState(initiallyOpen);
	const rootRef = useRef<HTMLDivElement>(null);
	usePopoverDismiss(rootRef, open, () => setOpen(false));
	const [running, setRunning] = useState(false);
	const [message, setMessage] = useState<string | null>(null);

	const systemCounts = new Map<OrganSystem, number>();
	const typeCounts = new Map<FactType, number>();
	let untagged = 0;
	for (const node of nodes) {
		for (const s of node.systems ?? []) systemCounts.set(s, (systemCounts.get(s) ?? 0) + 1);
		if (node.factType !== undefined) typeCounts.set(node.factType, (typeCounts.get(node.factType) ?? 0) + 1);
		if (isUntagged(node)) untagged++;
	}
	const activeCount = filter.systems.size + filter.factTypes.size;

	const backfill = async () => {
		setRunning(true);
		setMessage(null);
		try {
			const res = await fetch("/api/graph/tags/backfill", { method: "POST" });
			const body = (await res.json().catch(() => ({}))) as {
				error?: string;
				tagged?: number;
				untagged?: number;
				graphRevision?: number;
			};
			if (!res.ok) {
				setMessage(body.error ?? "Tagging failed.");
				return;
			}
			setMessage(`Tagged ${body.tagged ?? 0} of ${body.untagged ?? 0} nodes.`);
			onBackfilled(body.graphRevision ?? 0);
		} catch {
			setMessage("Tagging failed.");
		} finally {
			setRunning(false);
		}
	};

	return (
		<div ref={rootRef} className="relative">
			<Hint label="Filter by organ system and fact type" side="bottom">
				<button
					type="button"
					aria-expanded={open}
					onClick={() => setOpen((o) => !o)}
					data-testid="open-tag-filters"
					className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent"
				>
					<TagsIcon className="size-3" />
					Tags
					{activeCount > 0 && (
						<span className="rounded-full bg-primary px-1.5 text-[10px] tabular-nums text-primary-foreground">
							{activeCount}
						</span>
					)}
				</button>
			</Hint>
			{open && (
				<div
					data-testid="tag-filter-panel"
					className="absolute right-0 top-full z-20 mt-2 max-h-[60vh] w-80 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-xl border bg-card/95 p-3 text-xs shadow-lg backdrop-blur"
				>
					<div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
						Organ system
					</div>
					<div className="flex flex-wrap gap-1">
						{ORGAN_SYSTEMS.filter((s) => systemCounts.has(s.id) || filter.systems.has(s.id)).map((s) => (
							<Chip
								key={s.id}
								testId={`tag-chip-system-${s.id}`}
								label={s.label}
								count={systemCounts.get(s.id) ?? 0}
								active={filter.systems.has(s.id)}
								onClick={() => onFilter({ ...filter, systems: toggled(filter.systems, s.id) })}
							/>
						))}
						{systemCounts.size === 0 && !isTagFilterActive(filter) && (
							<span className="text-muted-foreground">No organ systems tagged yet.</span>
						)}
					</div>
					<div className="mb-1.5 mt-3 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
						Fact type
					</div>
					<div className="flex flex-wrap gap-1">
						{FACT_TYPES.filter((t) => typeCounts.has(t.id) || filter.factTypes.has(t.id)).map((t) => (
							<Chip
								key={t.id}
								testId={`tag-chip-type-${t.id}`}
								label={t.label}
								count={typeCounts.get(t.id) ?? 0}
								active={filter.factTypes.has(t.id)}
								onClick={() => onFilter({ ...filter, factTypes: toggled(filter.factTypes, t.id) })}
							/>
						))}
						{typeCounts.size === 0 && !isTagFilterActive(filter) && (
							<span className="text-muted-foreground">No fact types tagged yet.</span>
						)}
					</div>
					{activeCount > 0 && (
						<button
							type="button"
							data-testid="tag-filter-clear"
							onClick={() => onFilter(EMPTY_TAG_FILTER)}
							className="mt-3 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
						>
							Clear filters
						</button>
					)}
					{untagged > 0 && (
						<div className="mt-3 border-t pt-3">
							<button
								type="button"
								disabled={running}
								onClick={() => void backfill()}
								data-testid="tag-backfill"
								className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-foreground transition-colors hover:bg-accent disabled:opacity-50"
							>
								{running && <Loader2Icon className="size-3 animate-spin" />}
								{running ? "Tagging…" : `Tag existing nodes (${untagged})`}
							</button>
							<div className="mt-1 text-[11px] text-muted-foreground">
								Asks the model to fill the missing tags. Tags you or an earlier run already set are kept.
							</div>
						</div>
					)}
					{message && (
						<div data-testid="tag-backfill-message" className="mt-2 text-[11px] text-muted-foreground">
							{message}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

// ---- The detail card's tag editor ------------------------------------------

/** The tags on a node's detail card: read-only chips with an Edit button;
 *  Edit reveals every system (multi-select) and fact type (single-select),
 *  Save sends them to PATCH /api/graph/nodes/[id]. Exported for SSR pins. */
export function NodeTagsEditor({
	nodeId,
	systems,
	factType,
	onSaved,
	initiallyEditing = false,
}: {
	nodeId: string;
	systems: ReadonlyArray<OrganSystem> | undefined;
	factType: FactType | undefined;
	onSaved: (tags: { systems: OrganSystem[]; factType?: FactType }, graphRevision: number) => void;
	initiallyEditing?: boolean;
}) {
	const [editing, setEditing] = useState(initiallyEditing);
	const [draftSystems, setDraftSystems] = useState<ReadonlySet<OrganSystem>>(new Set(systems ?? []));
	const [draftType, setDraftType] = useState<FactType | undefined>(factType);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const startEditing = () => {
		setDraftSystems(new Set(systems ?? []));
		setDraftType(factType);
		setError(null);
		setEditing(true);
	};

	const save = async () => {
		setSaving(true);
		setError(null);
		try {
			const res = await fetch(`/api/graph/nodes/${encodeURIComponent(nodeId)}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ systems: [...draftSystems], factType: draftType ?? null }),
			});
			const body = (await res.json().catch(() => ({}))) as {
				error?: string;
				tags?: { systems: OrganSystem[]; factType?: FactType };
				graphRevision?: number;
			};
			if (!res.ok || !body.tags) {
				setError(body.error ?? "Saving the tags failed.");
				return;
			}
			setEditing(false);
			onSaved(body.tags, body.graphRevision ?? 0);
		} catch {
			setError("Saving the tags failed.");
		} finally {
			setSaving(false);
		}
	};

	return (
		<div data-testid="node-tags" className="mt-3 flex flex-col gap-1.5">
			<div className="flex items-center justify-between">
				<span className="text-xs text-muted-foreground">Tags</span>
				{!editing && (
					<button
						type="button"
						data-testid="node-tags-edit"
						onClick={startEditing}
						className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
					>
						Edit
					</button>
				)}
			</div>
			{editing ? (
				<>
					<div className="flex flex-wrap gap-1">
						{ORGAN_SYSTEMS.map((s) => (
							<Chip
								key={s.id}
								testId={`node-tag-system-${s.id}`}
								label={s.label}
								active={draftSystems.has(s.id)}
								onClick={() => setDraftSystems((cur) => toggled(cur, s.id))}
							/>
						))}
					</div>
					<div className="flex flex-wrap gap-1">
						{FACT_TYPES.map((t) => (
							<Chip
								key={t.id}
								testId={`node-tag-type-${t.id}`}
								label={t.label}
								active={draftType === t.id}
								onClick={() => setDraftType((cur) => (cur === t.id ? undefined : t.id))}
							/>
						))}
					</div>
					{error && <div className="text-[11px] text-destructive">{error}</div>}
					<div className="flex gap-2">
						<button
							type="button"
							disabled={saving}
							data-testid="node-tags-save"
							onClick={() => void save()}
							className="rounded-lg bg-primary px-2.5 py-1 text-xs text-primary-foreground disabled:opacity-50"
						>
							{saving ? "Saving…" : "Save"}
						</button>
						<button
							type="button"
							disabled={saving}
							onClick={() => setEditing(false)}
							className="rounded-lg px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent"
						>
							Cancel
						</button>
					</div>
				</>
			) : (systems?.length ?? 0) === 0 && factType === undefined ? (
				<div className="text-xs text-muted-foreground">Untagged.</div>
			) : (
				<div className="flex flex-wrap gap-1">
					{(systems ?? []).map((s) => (
						<span key={s} className="rounded-full border px-2 py-0.5 text-[11px] text-foreground">
							{organSystemLabel(s)}
						</span>
					))}
					{factType !== undefined && (
						<span className="rounded-full bg-accent px-2 py-0.5 text-[11px] text-foreground">
							{factTypeLabel(factType)}
						</span>
					)}
				</div>
			)}
		</div>
	);
}
