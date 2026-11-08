/**
 * Navigation aids for the graph page (medical fork): the pure half.
 *
 *  1. Focus mode — `focusNeighbourhood`: a fact plus everything one hop away
 *     over the derived edges, including the implication nodes a chain needs.
 *  2. Topic bubbles — `buildClusterView` / `layoutClusterView`: the graph as
 *     one bubble per topic (grouped under its organ system), a topic opened
 *     into its facts, edges between collapsed topics merged into one.
 *  3. Breadcrumbs + recents — `factBreadcrumb`, `pushRecent`, `resolveRecents`.
 *
 * Everything here is data in, data out: no React, no canvas, no storage. The
 * placement data is the outline's (src/core/contracts/placement.ts) — this
 * module only reads it. docs/medical-spec.md "Finding your way around".
 */

import {
	ORGAN_SYSTEMS,
	PLACEMENT_ASPECTS,
	type GraphNode,
	type OrganSystem,
	type PlacementAspect,
	type PlacementView,
} from "@/src/core";

// ---- Shared shapes ----------------------------------------------------------

export interface NavEdge {
	from: string;
	to: string;
}

/** One multi-premise chain's junction: premises converge on `id`, which points at `conclusion`. */
export interface NavImpLink {
	id: string;
	premises: readonly string[];
	conclusion: string;
}

// ---- 1. Focus mode -----------------------------------------------------------

/**
 * The ids that stay fully visible when `focusId` is focused: the fact itself,
 * every fact joined to it by one derived edge, and — whenever that edge runs
 * through an implication node — the node and the chain's other premises and
 * conclusion, so the whole step of reasoning stays readable. Facts two hops
 * away are not included.
 *
 * `edges` are the derived edges as drawn (premise → imp → conclusion for a
 * multi-premise chain, premise → conclusion for a single-premise one).
 */
export function focusNeighbourhood(
	focusId: string,
	edges: readonly NavEdge[],
	impLinks: readonly NavImpLink[],
): Set<string> {
	const imp = new Map(impLinks.map((l) => [l.id, l]));
	const keep = new Set<string>([focusId]);
	const add = (id: string) => {
		keep.add(id);
		const link = imp.get(id);
		if (!link) return;
		for (const p of link.premises) keep.add(p);
		keep.add(link.conclusion);
	};
	for (const e of edges) {
		if (e.from === focusId) add(e.to);
		else if (e.to === focusId) add(e.from);
	}
	return keep;
}

// ---- 2. Topic bubbles --------------------------------------------------------

/** The topic key facts without a place share. */
export const UNPLACED_KEY = "unplaced";

const SYSTEM_PREFIX = "system:";
export const BUBBLE_PREFIX = "topic:";

/** The display id of a topic's marker (its bubble when closed, its header when open). */
export const topicNodeId = (topicKey: string): string => `${BUBBLE_PREFIX}${topicKey}`;
export const isTopicNodeId = (id: string): boolean => id.startsWith(BUBBLE_PREFIX);
export const topicKeyOf = (nodeId: string): string => nodeId.slice(BUBBLE_PREFIX.length);

export interface ClusterTopic {
	/** The placement topic id, or UNPLACED_KEY. */
	key: string;
	name: string;
	/** Group key: an organ-system id, or UNPLACED_KEY. */
	system: string;
	/** Fact ids in the topic, aspect order then name. */
	facts: string[];
	expanded: boolean;
}

export interface ClusterGroup {
	/** `system:<id>` — also the canvas cluster id. */
	id: string;
	label: string;
	topics: ClusterTopic[];
	/** Display node ids inside the group (markers + the facts of open topics). */
	members: string[];
}

export interface ClusterEdge {
	from: string;
	to: string;
	/** Underlying edges merged into this one (1 = a plain edge). */
	count: number;
}

export interface ClusterView {
	groups: ClusterGroup[];
	topics: ClusterTopic[];
	/** Display ids to draw (no positions): a marker per topic, plus facts of open topics and kept junctions. */
	nodeIds: { id: string; kind: "topic" | "fact" | "imp" }[];
	/** Edges between display ids; parallel edges merged with a count. */
	edges: ClusterEdge[];
	/** The chains still drawn in full (every member shown as itself). */
	impLinks: NavImpLink[];
	/** fact id → the display id that stands for it (itself, or its topic's marker). */
	displayOf: Map<string, string>;
	/** topic key of every fact. */
	topicOf: Map<string, string>;
}

export interface ClusterViewInput {
	/** The stored propositions. */
	nodes: readonly Pick<GraphNode, "id" | "name">[];
	placement: PlacementView | undefined;
	/** Derived edges as drawn (with imp nodes). */
	edges: readonly NavEdge[];
	impLinks: readonly NavImpLink[];
	/** Topic keys that are open. */
	expanded: ReadonlySet<string>;
	/** Show only these facts (and chains made entirely of them); null = all. */
	visibleIds?: ReadonlySet<string> | null;
}

const ASPECT_ORDER = new Map<string, number>(PLACEMENT_ASPECTS.map((a, i) => [a.id, i]));

export const UNPLACED_LABEL = "Unplaced";

/**
 * Group the facts by topic and decide what the canvas draws. A closed topic is
 * one marker; an open topic shows its facts. A chain whose members are all open
 * (or all visible and open) is drawn in full; any other chain is contracted to
 * premise → conclusion between the display ids it touches — so edges between
 * closed topics merge into one with a count, and an edge inside one closed
 * topic disappears.
 */
export function buildClusterView(input: ClusterViewInput): ClusterView {
	const { placement, expanded } = input;
	const visible = input.visibleIds ?? null;
	const shown = (id: string) => visible === null || visible.has(id);
	const topicById = new Map((placement?.topics ?? []).map((t) => [t.id, t]));
	const nameOf = new Map(input.nodes.map((n) => [n.id, n.name]));

	// Facts into topics.
	const perTopic = new Map<string, string[]>();
	const topicOf = new Map<string, string>();
	for (const node of input.nodes) {
		if (!shown(node.id)) continue;
		const p = placement?.byNode[node.id];
		const key = p && topicById.has(p.topicId) ? p.topicId : UNPLACED_KEY;
		topicOf.set(node.id, key);
		const list = perTopic.get(key) ?? [];
		list.push(node.id);
		perTopic.set(key, list);
	}
	const aspectRank = (id: string) => ASPECT_ORDER.get(placement?.byNode[id]?.aspect ?? "other") ?? ASPECT_ORDER.size;
	const byAspectThenName = (a: string, b: string) =>
		aspectRank(a) - aspectRank(b) || (nameOf.get(a) ?? "").localeCompare(nameOf.get(b) ?? "") || a.localeCompare(b);

	const topics: ClusterTopic[] = [];
	for (const [key, facts] of perTopic) {
		const t = topicById.get(key);
		topics.push({
			key,
			name: key === UNPLACED_KEY ? UNPLACED_LABEL : (t?.name ?? key),
			system: key === UNPLACED_KEY ? UNPLACED_KEY : (t?.system ?? UNPLACED_KEY),
			facts: [...facts].sort(byAspectThenName),
			expanded: expanded.has(key),
		});
	}
	const systemRank = new Map<string, number>(ORGAN_SYSTEMS.map((s, i) => [s.id as string, i]));
	const rankOf = (system: string) => (system === UNPLACED_KEY ? 1e6 : (systemRank.get(system) ?? 1e5));
	topics.sort((a, b) => rankOf(a.system) - rankOf(b.system) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));

	// What stands for each fact on screen.
	const topicByKey = new Map(topics.map((t) => [t.key, t]));
	const displayOf = new Map<string, string>();
	for (const [factId, key] of topicOf) displayOf.set(factId, topicByKey.get(key)!.expanded ? factId : topicNodeId(key));

	// Which chains are drawn in full.
	const imp = new Map(input.impLinks.map((l) => [l.id, l]));
	const members = (l: NavImpLink) => [...l.premises, l.conclusion];
	const live = (l: NavImpLink) => members(l).every((m) => displayOf.has(m));
	const kept = input.impLinks.filter((l) => live(l) && members(l).every((m) => displayOf.get(m) === m));

	// Edges, merged.
	const edgeAt = new Map<string, ClusterEdge>();
	const addEdge = (from: string | undefined, to: string | undefined) => {
		if (from === undefined || to === undefined || from === to) return;
		const k = `${from}\u0000${to}`;
		const hit = edgeAt.get(k);
		if (hit) hit.count++;
		else edgeAt.set(k, { from, to, count: 1 });
	};
	const keptIds = new Set(kept.map((l) => l.id));
	for (const e of input.edges) {
		const fromImp = imp.has(e.from);
		const toImp = imp.has(e.to);
		if (fromImp || toImp) {
			// Chain edges: kept chains keep theirs, the rest are handled per chain below.
			if (keptIds.has(fromImp ? e.from : e.to)) addEdge(e.from, e.to);
			continue;
		}
		addEdge(displayOf.get(e.from), displayOf.get(e.to));
	}
	for (const l of input.impLinks) {
		if (keptIds.has(l.id) || !live(l)) continue;
		for (const p of l.premises) addEdge(displayOf.get(p), displayOf.get(l.conclusion));
	}

	// Display nodes + groups.
	const nodeIds: ClusterView["nodeIds"] = [];
	const groups: ClusterGroup[] = [];
	const groupById = new Map<string, ClusterGroup>();
	for (const t of topics) {
		const gid = `${SYSTEM_PREFIX}${t.system}`;
		let group = groupById.get(gid);
		if (!group) {
			group = {
				id: gid,
				label: t.system === UNPLACED_KEY ? UNPLACED_LABEL : (ORGAN_SYSTEMS.find((s) => s.id === t.system)?.label ?? t.system),
				topics: [],
				members: [],
			};
			groupById.set(gid, group);
			groups.push(group);
		}
		group.topics.push(t);
		nodeIds.push({ id: topicNodeId(t.key), kind: "topic" });
		group.members.push(topicNodeId(t.key));
		if (t.expanded) {
			for (const f of t.facts) {
				nodeIds.push({ id: f, kind: "fact" });
				group.members.push(f);
			}
		}
	}
	for (const l of kept) nodeIds.push({ id: l.id, kind: "imp" });

	return {
		groups,
		topics,
		nodeIds,
		edges: [...edgeAt.values()],
		impLinks: kept.map((l) => ({ id: l.id, premises: [...l.premises], conclusion: l.conclusion })),
		displayOf,
		topicOf,
	};
}

// ---- Layout ------------------------------------------------------------------

/** Spacing constants, world units (a fact disc is 2 wide, the file layout spaces facts ~40 apart). */
const FACT_SPACING = 9;
const OPEN_MARGIN = 14;
const BUBBLE_BASE = 5;
const BUBBLE_PER_ROOT = 4;
const BODY_GAP = 14;
const GROUP_GAP = 26;

/** A closed topic's bubble radius grows with the root of its fact count. */
export const bubbleRadius = (count: number): number => BUBBLE_BASE + BUBBLE_PER_ROOT * Math.sqrt(Math.max(count, 1));
/** An open topic's ring radius: room for its facts laid out in a sunflower. */
export const openRadius = (count: number): number => FACT_SPACING * Math.sqrt(Math.max(count, 1)) + OPEN_MARGIN;

export interface Circle {
	x: number;
	y: number;
	r: number;
}

/**
 * Greedy circle packing: each circle, largest first, goes to the spot nearest
 * the origin along an outward spiral where it clears every circle already
 * placed (by `gap`). Deterministic. Returns centres in input order.
 */
export function packCircles(radii: readonly number[], gap: number): { x: number; y: number }[] {
	const order = radii.map((r, i) => ({ r, i })).sort((a, b) => b.r - a.r || a.i - b.i);
	const placed: Circle[] = [];
	const out: { x: number; y: number }[] = new Array(radii.length);
	for (const { r, i } of order) {
		let spot: { x: number; y: number } | null = null;
		if (placed.length === 0) spot = { x: 0, y: 0 };
		else {
			// Archimedean spiral; the pitch is small against the circle size so the first fit is tight.
			const pitch = Math.max(r, 4) / 6;
			let theta = 0;
			for (let step = 0; step < 40000 && spot === null; step++) {
				const rho = (pitch * theta) / (2 * Math.PI);
				const x = rho * Math.cos(theta);
				const y = rho * Math.sin(theta);
				if (placed.every((c) => Math.hypot(c.x - x, c.y - y) >= c.r + r + gap)) spot = { x, y };
				theta += Math.max(0.04, Math.min(0.6, (pitch * 1.5) / Math.max(rho, 1)));
			}
			spot ??= { x: (placed.length + 1) * (r + gap) * 2, y: 0 };
		}
		placed.push({ ...spot, r });
		out[i] = spot;
	}
	return out;
}

/** The smallest origin-centred circle holding `circles`. */
const enclosingRadius = (circles: readonly Circle[]): number =>
	circles.reduce((m, c) => Math.max(m, Math.hypot(c.x, c.y) + c.r), 0);

export interface ClusterLayout {
	/** Positions of every display node (topic markers, open topics' facts, kept junctions). */
	positions: Map<string, { x: number; y: number }>;
	/** Radius of each topic marker: the bubble when closed, the ring when open. */
	radius: Map<string, number>;
	/** Centre of each topic (the ring's centre when open). */
	centre: Map<string, { x: number; y: number }>;
	/** The circle round each system group, by group id. */
	frames: Map<string, Circle>;
	/** The rect holding every frame — the whole picture, however it is filtered. */
	bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

/**
 * Lay the view out: topics packed inside their system, systems packed
 * together. An open topic's facts sit in a sunflower around the topic centre,
 * in aspect order, so facts of one aspect stay together. Pure and
 * deterministic — the same view always yields the same picture.
 *
 * Marker position: a closed topic's marker is its centre; an open topic's
 * marker (the header the learner clicks to close it) sits at the top of its
 * ring.
 */
export function layoutClusterView(view: ClusterView): ClusterLayout {
	const positions = new Map<string, { x: number; y: number }>();
	const radius = new Map<string, number>();
	const centre = new Map<string, { x: number; y: number }>();
	const frames = new Map<string, Circle>();

	// Topics within each system.
	const groupBodies = view.groups.map((g) => {
		const radii = g.topics.map((t) => (t.expanded ? openRadius(t.facts.length) : bubbleRadius(t.facts.length)));
		const spots = packCircles(radii, BODY_GAP);
		const circles = spots.map((s, i) => ({ ...s, r: radii[i]! }));
		return { circles, enclosing: enclosingRadius(circles) };
	});
	// Systems together.
	const systemSpots = packCircles(groupBodies.map((b) => b.enclosing), GROUP_GAP);

	view.groups.forEach((g, gi) => {
		const origin = systemSpots[gi]!;
		frames.set(g.id, { x: origin.x, y: origin.y, r: groupBodies[gi]!.enclosing + GROUP_GAP / 3 });
		g.topics.forEach((t, ti) => {
			const c = groupBodies[gi]!.circles[ti]!;
			const cx = origin.x + c.x;
			const cy = origin.y + c.y;
			const id = topicNodeId(t.key);
			radius.set(id, c.r);
			centre.set(id, { x: cx, y: cy });
			if (!t.expanded) {
				positions.set(id, { x: cx, y: cy });
				return;
			}
			positions.set(id, { x: cx, y: cy - c.r });
			// Golden-angle sunflower, aspect order outward in.
			t.facts.forEach((f, i) => {
				const rho = FACT_SPACING * Math.sqrt(i + 0.5);
				const a = i * 2.399963229728653;
				positions.set(f, { x: cx + rho * Math.cos(a), y: cy + rho * Math.sin(a) });
			});
		});
	});

	// A kept junction sits at the mean of the nodes it joins.
	for (const l of view.impLinks) {
		const pts = [...l.premises, l.conclusion].map((m) => positions.get(m)).filter((p): p is { x: number; y: number } => !!p);
		if (pts.length === 0) continue;
		positions.set(l.id, {
			x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
			y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
		});
	}
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const f of frames.values()) {
		minX = Math.min(minX, f.x - f.r);
		maxX = Math.max(maxX, f.x + f.r);
		minY = Math.min(minY, f.y - f.r);
		maxY = Math.max(maxY, f.y + f.r);
	}
	if (frames.size === 0) minX = maxX = minY = maxY = 0;
	return { positions, radius, centre, frames, bounds: { minX, maxX, minY, maxY } };
}

/**
 * The display ids that stand for these facts: the fact itself when its topic
 * is open, else its topic's marker. Facts the view doesn't show are skipped.
 */
export function displayIdsFor(view: ClusterView, factIds: Iterable<string>): Set<string> {
	const out = new Set<string>();
	for (const id of factIds) {
		const d = view.displayOf.get(id);
		if (d !== undefined) out.add(d);
	}
	return out;
}

// ---- 3. Breadcrumbs + recents -------------------------------------------------

export interface BreadcrumbPart {
	kind: "system" | "topic" | "aspect";
	label: string;
	/** The outline branch a click jumps to. */
	selection: { system: OrganSystem; topicId?: string; aspect?: PlacementAspect };
}

/**
 * Where a fact sits: GI/Hepatobiliary › Small-bowel obstruction › Workup, each
 * part carrying the outline branch it stands for. An unplaced fact has no
 * parts (the card says so instead).
 */
export function factBreadcrumb(nodeId: string, placement: PlacementView | undefined): BreadcrumbPart[] {
	const p = placement?.byNode[nodeId];
	const topic = p ? placement?.topics.find((t) => t.id === p.topicId) : undefined;
	if (!p || !topic) return [];
	return [
		{
			kind: "system",
			label: ORGAN_SYSTEMS.find((s) => s.id === topic.system)?.label ?? topic.system,
			selection: { system: topic.system },
		},
		{ kind: "topic", label: topic.name, selection: { system: topic.system, topicId: topic.id } },
		{
			kind: "aspect",
			label: PLACEMENT_ASPECTS.find((a) => a.id === p.aspect)?.label ?? p.aspect,
			selection: { system: topic.system, topicId: topic.id, aspect: p.aspect },
		},
	];
}

/** How many recently visited facts are kept. */
export const RECENT_LIMIT = 8;

/** Put a fact at the front of the recents: no repeats, newest first, capped. */
export function pushRecent(list: readonly string[], id: string, limit = RECENT_LIMIT): string[] {
	return [id, ...list.filter((x) => x !== id)].slice(0, limit);
}

/** Recents that still name a live fact, in order. */
export function resolveRecents<T extends { id: string }>(list: readonly string[], nodes: readonly T[]): T[] {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const out: T[] = [];
	for (const id of list) {
		const n = byId.get(id);
		if (n) out.push(n);
	}
	return out;
}

/** Read a stored recents list defensively (any junk becomes empty). */
export function parseRecents(raw: string | null): string[] {
	if (!raw) return [];
	try {
		const v: unknown = JSON.parse(raw);
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, RECENT_LIMIT) : [];
	} catch {
		return [];
	}
}
