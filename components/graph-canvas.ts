"use client";

/**
 * The hand-rolled single-canvas graph renderer (decided 2026-09-13 after
 * the research pass — docs/research/graph-rendering.md, Option B).
 *
 * Replaces sigma.js. Why: sigma gave us WebGL node/edge rendering,
 * picking, and a camera, but our cluster regions had to live on foreign
 * canvases injected next to its private DOM stack, drawn from a separate
 * event loop — so hulls lagged behind nodes during pan, raced sigma's
 * canvas sizing on renderer rebuilds, and every camera event re-rasterized
 * the full hull canvas (GPU spikes + audible coil whine). At our scale
 * (338 → low thousands of nodes) one Canvas 2D is comfortably inside
 * 60fps territory, and a single loop makes the desync class of bugs
 * structurally impossible.
 *
 * Architecture (the canonical pattern — browser.engineering, MDN
 * "Optimizing canvas", web.dev canvas performance):
 *   - The renderer is a DUMB DRAW FUNCTION over plain data: nodes with
 *     world-space positions, edges, clusters, colors, settings. Layout
 *     (forceAtlas2) and filtering happen OUTSIDE, in the React component;
 *     this module never computes a position.
 *   - ONE canvas, ONE requestAnimationFrame loop with a dirty flag. Input
 *     and DOM events only mutate state and mark dirty; the loop draws at
 *     most once per frame with every layer under the same camera —
 *     hull fills → hull strokes → edges → nodes → region labels → node
 *     labels → hover. Nothing can ever lag anything else.
 *   - Camera: d3-zoom supplies the verified pan / zoom-to-cursor / pinch
 *     math (screen = world·k + [x,y]). The camera lives in the renderer
 *     instance, so data refetches and settings changes never move it.
 *   - Picking: nearest-node distance check (µs at our scale), with a
 *     PICKING_PAD so the whole hover halo is hit-testable.
 *
 * Zoom-gated labels (the Obsidian text-fade feel): sigma's camera "ratio"
 * convention is kept for the settings' persisted semantics — ratio 1 =
 * fit zoom, SMALLER = zoomed in (ratio = kFit / k). Node labels are
 * fully visible at ratio ≤ labelZoom and fade out across a span
 * proportional to the gate (LABELS_FADE_RATIO)
 * of ratio; cluster labels fade in over the exact same span (sums to 1)
 * so the two never coexist. All labels gate together — no per-node
 * popping.
 *
 * The hover glow is unchanged in look: a soft halo in the node's own
 * color at a constant radius, opacity cross-faded over ~180ms, with the
 * name brightening on the SAME factor. Only opacity animates; the only
 * per-frame work when idle is a dirty-flag check (no rAF is scheduled at
 * all until something changes).
 *
 * Unit tests cover the pure helpers (tests/graph-canvas.test.ts); the
 * class itself is DOM-bound and exercised live. Module scope stays
 * DOM-free so the file imports cleanly under Node.
 */

import { select } from "d3-selection";
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import type { Simulation, SimulationLinkDatum } from "d3-force";
import { clusterHue, type Pt } from "./cluster-geometry.ts";
import { placeLabels, type LabelCandidate, type LabelObstacle, type Rect } from "./graph-labels.ts";
import { centreTransform, fitTransform, NO_INSETS, sameInsets, type Insets } from "./graph-viewport.ts";
import {
	CHARGE_STRENGTH,
	CLUSTER_PULL_STRENGTH,
	createGraphSimulation,
	DEFAULT_PHYSICS_TUNING,
	DEFAULT_REGION_TUNING,
	sanitizePhysicsTuning,
	sanitizeRegionTuning,
	type PhysicsTuning,
	type RegionTuning,
	INCREMENTAL_GRAVITY,
	LINK_DISTANCE,
	type DepthAnchorMode,
	type GraphRenderSettings,
	type LayoutNode,
	type Position,
} from "@/src/core";

export type { GraphRenderSettings };

// ─── Public data contract ──────────────────────────────────────────────────

/** One node to draw: world-space position + the short glanceable label. */
export interface CanvasNode {
	id: string;
	x: number;
	y: number;
	label: string;
	/** "topic": a topic marker of the bubble view (medical fork). Closed, it is
	 *  a bubble of `radius` centred on x,y with `count` inside; open, x,y is the
	 *  header pill at the top of a ring of `radius` whose centre is radius below. */
	kind?: "topic";
	radius?: number;
	count?: number;
	open?: boolean;
}

/** One directed edge of the DERIVED view (chains-primary, 2026-09-30):
 *  premise → implication node → conclusion, UNTYPED, all PLAIN
 *  single-shaft arrows — there is no double-shaft glyph anywhere
 *  (the 2026-09-14 ruling died with typed edges). An argument renders
 *  as its geometry: co-premise lines converge HEADLESS onto the
 *  implication point, one arrowed line leaves it; a single-premise
 *  argument is one ordinary arrow (see deriveView). */
export interface CanvasEdge {
	from: string;
	to: string;
	/** Edges merged into this one (bubble view); drawn heavier when above 1. */
	count?: number;
}

/** Implication-node ids (the mint law: newGraphChainId in core/graph.ts).
 *  On the canvas an imp node is PURE GEOMETRY (owner, rendering arc
 *  2026-09-30): invisible — no disc, no label — and UNPICKABLE,
 *  excluded from every hit-test path. Exported for the test pin. */
export const isImpNodeId = (id: string): boolean => id.startsWith("arg_");

/** One cluster region: member node ids + the LLM-coined label (or null). */
export interface CanvasCluster {
	id: string;
	label: string | null;
	members: string[];
}

/** Theme colors, resolved to #rrggbb by the caller (canvas wants hex,
 *  and the renderer must not read CSS itself). */
export interface CanvasColors {
	node: string;
	edge: string;
	label: string;
	hoverText: string;
	/** The page background: backs a hovered topic's name when its label was
	 *  hidden to avoid a collision. Optional (falls back to no backing). */
	background?: string;
}

/** A labelled circle drawn behind a group of nodes (the bubble view's organ-system frames). */
export interface CanvasFrame {
	id: string;
	label: string;
	x: number;
	y: number;
	r: number;
}

export interface CanvasData {
	nodes: CanvasNode[];
	edges: CanvasEdge[];
	/** The LOGICAL arrows (proposition→conclusion, imp contracted) the
	 *  depth force consumes — absent = the sim derives depth from the
	 *  drawn edges (legacy). Optional so non-graph callers of the
	 *  renderer stay simple. */
	logicalEdges?: CanvasEdge[];
	/** The imp chain linkage — the depth pass anchors each junction at
	 *  the premises/conclusion midpoint (owner, 2026-09-30). */
	impLinks?: ReadonlyArray<{ id: string; premises: ReadonlyArray<string>; conclusion: string }>;
	clusters: CanvasCluster[];
	colors: CanvasColors;
	/** Body font family (labels must match the app typography). */
	fontFamily: string;
	/** A fixed layout (the bubble view): no live physics, nothing drags. */
	staticLayout?: boolean;
	/** Group frames behind the nodes, labelled at a constant on-screen size. */
	frames?: CanvasFrame[];
	/** The world rect that counts as "the whole picture" (fit zoom, label gate)
	 *  when it is wider than the nodes drawn — a filtered bubble view keeps the
	 *  full layout's framing. Defaults to the bounds of `nodes`. */
	bounds?: { minX: number; maxX: number; minY: number; maxY: number };
}

export interface RendererCallbacks {
	/** A node was clicked (screen position included for card anchoring). */
	onSelect: (nodeId: string, screenPos: Pt) => void;
	/** Right-click: the picked node (canvas-relative screen position) or
	 *  null when the pointer hit empty stage — the caller opens/closes
	 *  its context menu accordingly. (node interlude, wave 7) */
	onContext: (nodeId: string | null, screenPos: Pt) => void;
	/** The empty stage was clicked. */
	onStageClick: () => void;
	/** Any camera move (pan/zoom) — the caller dismisses anchored UI and
	 *  persists the camera (view state). */
	onCameraMove: (transform: { k: number; x: number; y: number }) => void;
	/** The live sim settled after a drag: commit the new rest state
	 *  (the caller PUTs it to the positions ledger). */
	onCommit: (positions: Record<string, Position>) => void;
	/** The canvas edges the floating panels cover right now (toolbar, outline,
	 *  the home dock). Fitting and focusing frame into what is left. */
	getInsets?: () => Insets;
}

// ─── Constants (ported verbatim from the sigma view) ────────────────────────

const LABEL_SIZE = 12; // the reference label size the wrap-width ratio is taken against
const LABEL_WEIGHT = "500";

/** Region (cluster) labels — wave 7's session names made the labels
 *  LONG: imported-file paths and renamed chat titles. They wrap at a
 *  screen-fixed width (the labels are viewer-relative — this px value
 *  is exact on screen at any zoom), capped at a line count with an
 *  ellipsis on the last line (owner, 2026-09-23: wrap, cap 2–3 lines,
 *  ellipsize — a bounded footprint that keeps most of the path
 *  visible). */
const REGION_LABEL_MAX_WIDTH = 220; // screen px
const REGION_LABEL_MAX_LINES = 3;
const REGION_LABEL_LINE_HEIGHT = 1.3;

/** Wrap one region label: word-wise first (session names), then
 *  char-wise for words alone wider than the max (long file paths — the
 *  node-label discipline), capped at maxLines. Overflow folds into the
 *  last line, ellipsized to fit. measure is the canvas measureText (or a
 *  fake in tests) — pure otherwise. */
export function wrapRegionLabel(
	text: string,
	maxWidth: number,
	maxLines: number,
	measure: (s: string) => number,
): string[] {
	if (maxLines < 1) return [text];
	if (measure(text) <= maxWidth) return [text];
	const lines: string[] = [];
	const pending: string[] = text.split(/\s+/).filter(Boolean);
	// Fill up to maxLines-1 lines; the remainder becomes the last line.
	while (pending.length > 0 && lines.length < maxLines - 1) {
		let line = "";
		while (pending.length > 0) {
			let word = pending[0]!;
			const candidate = line ? `${line} ${word}` : word;
			if (measure(candidate) <= maxWidth) {
				line = candidate;
				pending.shift();
				continue;
			}
			if (!line) {
				// The word alone overflows: char-split it, the remainder stays
				// pending for the next line (paths have no spaces to help).
				let chunk = "";
				while (word.length > 0 && measure(chunk + word[0]) <= maxWidth) {
					chunk += word[0];
					word = word.slice(1);
				}
				if (chunk) {
					lines.push(chunk);
					pending[0] = word;
				} else {
					// Degenerate: one char exceeds the width — keep it whole so
					// the label can never vanish entirely.
					lines.push(word);
					pending.shift();
				}
				line = "";
			}
			break;
		}
		if (line) lines.push(line);
		if (!line && lines.length > 0 && pending.length > 0) continue;
		if (!line && lines.length === 0) break;
	}
	// The remainder rides as the last line: plain if it fits, ellipsized
	// down to the width if not.
	let rest = pending.join(" ");
	if (!rest) return lines;
	if (measure(rest) <= maxWidth) {
		lines.push(rest);
		return lines;
	}
	let tail = rest;
	while (tail.length > 1 && measure(`${tail}…`) > maxWidth) tail = tail.slice(0, -1);
	lines.push(`${tail}…`);
	return lines;
}

/** Label-only cluster patch (rename-shuffle fix, 2026-09-23): apply a set
 *  of live label updates to the data-side cluster records AND the built
 *  region meta (re-wrapping the changed entries with the provided
 *  measure — the same wrap a geometry build would produce). The
 *  hull-silence guard travels here: a cluster whose CURRENT label is
 *  null is a gone record — no rename can reach it. Pure, in-place on the
 *  provided arrays; returns whether anything changed (the caller only
 *  redraws when it did). Exported for tests. */
export function applyClusterLabels(
	clusters: { id: string; label: string | null }[],
	regionMeta: { id: string; label: string | null; lines: string[] | null }[],
	labels: ReadonlyMap<string, string | null>,
	maxWidth: number,
	maxLines: number,
	measure: (s: string) => number,
): boolean {
	let changed = false;
	for (const cluster of clusters) {
		if (!labels.has(cluster.id)) continue;
		if (cluster.label == null) continue; // hull silence: gone records stay silent
		const label = labels.get(cluster.id) ?? null;
		if (label === cluster.label) continue;
		cluster.label = label;
		changed = true;
	}
	if (!changed) return false;
	for (const rm of regionMeta) {
		if (!labels.has(rm.id)) continue;
		if (rm.label == null) continue;
		const label = labels.get(rm.id) ?? null;
		rm.label = label;
		rm.lines = label
			? wrapRegionLabel(label, maxWidth, maxLines, measure)
			: null;
	}
	return true;
}
const LABEL_MAX_WIDTH = 170; // wrap width at the reference label size, world units
const LABEL_GAP = 2.9; // world units between node edge and first label line (the 2px-at-fit reference ÷ 0.69)
const LABEL_LINE_HEIGHT = 1.3;
/** The node→cluster label cross-fade spans gate × this (camera-ratio
 *  units) — PROPORTIONAL since 2026-09-17. The old absolute span (0.5
 *  ratio) read as a 100% relative change at the old 0.5 gate but a bare
 *  12% sliver at the tuned 8x gate (ratio 4): "lower zoom levels naturally
 *  produce a longer transitionary period while higher ones are more
 *  abrupt" — the user's exact observation. Proportional keeps ONE
 *  transitionary feel at any gate; at the 8x default the handoff fades
 *  across a full stop (8x → 12x). */
export const LABELS_FADE_RATIO = 0.5;

const GLOW_SCALE = 1.7; // halo outer radius = node radius x this (proportional, like blurring a copy of the disc)
const GLOW_ALPHA = 0.3; // halo opacity at the disc edge, fading outward
const HOVER_FADE_MS = 180; // hover halo opacity fade length
const ZOOM_EASE_MS = 45; // wheel-zoom glide: exponential-ease time constant (~250ms per notch)

/** Extra pickable radius (px) beyond the disc — the whole halo is
 *  hit-testable (the old flicker fix, minus the picking shader). */
const PICKING_PAD = 10;

/** Focus mode: how much of a faded node / edge stays visible. */
const DIM_ALPHA = 0.12;
/** Topic markers (the bubble view) draw at a constant on-screen size. */
const TOPIC_LABEL_PX = 11;
const TOPIC_COUNT_PX = 12;
const TOPIC_PILL_H = 20;
const TOPIC_PILL_PAD = 26;
const TOPIC_PICK_PAD = 4;
const FRAME_LABEL_PX = 13;
/** Topic-name line pitch (px) and the gaps label placement keeps (px). */
const TOPIC_LINE_H = TOPIC_LABEL_PX * 1.25;
const TOPIC_LABEL_GAP = 4;
const TOPIC_LABEL_PAD = 2;
/** A bubble shows its count from this on-screen radius (px) up. */
const TOPIC_COUNT_MIN_R = 9;
/** Stroke multiple for an aggregated edge. */
const HEAVY_EDGE = 2.2;

/** Click vs drag threshold: pointer travel under this many px is a click. */
const CLICK_SLOP = 4;
/** Live-sim tuning — see the class doc comment. */
const LIVE_ALPHA_DECAY = 0.05; // snappier anneal than the settle's 0.0228
const DRAG_ALPHA_TARGET = 0.3; // d3-drag's own reheat constant
const SIM_SETTLE_ALPHA = 0.005; // below this, the sim counts as settled
const COMMIT_DEBOUNCE_MS = 250; // settle → ledger PUT delay (new drags cancel)

/** Cluster region styling — a low-res world-space SPLAT bitmap (the
 *  density-field technique, Canvas-2D edition): every member node paints
 *  a soft radial-gradient disc and every intra-cluster edge a round-cap
 *  stroke; upscaling the bitmap with bilinear smoothing IS the blur.
 *  Replaces the convex-hull fills + borders: concave cluster shapes are
 *  finally correct (the hull bridged every gap with straight lines —
 *  the jagged close-up look), there is no border to lag behind, and a
 *  live-physics frame pays one tiny blit instead of 32 clusters × 4
 *  offset polygons re-rasterized at DPR 2 (the old GPU coil-whine). */
const REGION_EVERY = 3; // live-sim frames: rebuild every Nth, blit the rest



/** One horizontal+vertical box-blur round over PREMULTIPLIED RGBA
 *  (Float32, stride 4, length w*h*4). Premultiplying first is what keeps
 *  the blur halo-free: blurring non-premultiplied RGB over varying alpha
 *  bleeds solid color into transparent space. Pure: DOM-free, tested. */
export function boxBlurRound(
	src: Float32Array,
	tmp: Float32Array,
	dst: Float32Array,
	w: number,
	h: number,
	radius: number,
): void {
	if (radius <= 0) {
		dst.set(src);
		return;
	}
	const div = radius * 2 + 1;
	// Horizontal: src → tmp (clamped window, running sum).
	for (let y = 0; y < h; y++) {
		const row = y * w * 4;
		let sum0 = 0, sum1 = 0, sum2 = 0, sum3 = 0;
		for (let x = -radius; x <= radius; x++) {
			const i = row + Math.min(Math.max(x, 0), w - 1) * 4;
			sum0 += src[i]!;
			sum1 += src[i + 1]!;
			sum2 += src[i + 2]!;
			sum3 += src[i + 3]!;
		}
		for (let x = 0; x < w; x++) {
			const o = row + x * 4;
			tmp[o] = sum0 / div;
			tmp[o + 1] = sum1 / div;
			tmp[o + 2] = sum2 / div;
			tmp[o + 3] = sum3 / div;
			const addI = row + Math.min(x + radius + 1, w - 1) * 4;
			const subI = row + Math.max(x - radius, 0) * 4;
			sum0 += src[addI]! - src[subI]!;
			sum1 += src[addI + 1]! - src[subI + 1]!;
			sum2 += src[addI + 2]! - src[subI + 2]!;
			sum3 += src[addI + 3]! - src[subI + 3]!;
		}
	}
	// Vertical: tmp → dst.
	for (let x = 0; x < w; x++) {
		const col = x * 4;
		let sum0 = 0, sum1 = 0, sum2 = 0, sum3 = 0;
		for (let y = -radius; y <= radius; y++) {
			const i = col + Math.min(Math.max(y, 0), h - 1) * w * 4;
			sum0 += tmp[i]!;
			sum1 += tmp[i + 1]!;
			sum2 += tmp[i + 2]!;
			sum3 += tmp[i + 3]!;
		}
		for (let y = 0; y < h; y++) {
			const o = col + y * w * 4;
			dst[o] = sum0 / div;
			dst[o + 1] = sum1 / div;
			dst[o + 2] = sum2 / div;
			dst[o + 3] = sum3 / div;
			const addI = col + Math.min(y + radius + 1, h - 1) * w * 4;
			const subI = col + Math.max(y - radius, 0) * w * 4;
			sum0 += tmp[addI]! - tmp[subI]!;
			sum1 += tmp[addI + 1]! - tmp[subI + 1]!;
			sum2 += tmp[addI + 2]! - tmp[subI + 2]!;
			sum3 += tmp[addI + 3]! - tmp[subI + 3]!;
		}
	}
}

/** Geometry constants are WORLD UNITS (the 2026-09-15 pivot): node/
 *  label/arrowhead sizes come from the settings directly — the same law
 *  as linkDistance — so the world scale is canonical and never depends on
 *  the graph's extent or the viewport. Camera zoom scales them with the
 *  graph (Obsidian-style); edge widths and hull borders stay
 *  viewer-relative hairlines (÷ k); cluster labels stay screen-fixed
 *  (px at any zoom). kFit survives ONLY as the label-gate's "1×"
 *  reference (zoomRatioOf) — a pure LOD threshold, no geometry reads it. */

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

// ─── Pure helpers (unit-tested) ─────────────────────────────────────────────

/**
 * The sigma-compatible "camera ratio": 1 at fit zoom, SMALLER when zoomed
 * in (ratio = kFit / k). The persisted labelZoom setting is denominated in
 * these units, so the gate semantics survive the renderer swap unchanged.
 */
export function zoomRatioOf(kFit: number, k: number): number {
	return kFit / k;
}

/**
 * Node-label opacity at a given camera ratio: 1 at/below the labelZoom
 * threshold, fading to 0 across a span of labelZoom x LABELS_FADE_RATIO
 * (see there). Cluster labels use `1 - this` over the same span — the
 * two cross-fade and never coexist at full opacity.
 */
export function labelAlpha(
	ratio: number,
	labelZoom: number,
	span = labelZoom * LABELS_FADE_RATIO,
): number {
	return clamp01(1 - (ratio - labelZoom) / span);
}

/** The camera transform that frames `bbox` in a w×h viewport with padding
 *  (and, optionally, clear of the panels' insets) — see graph-viewport.ts. */
export { fitTransform };

/** The arrowhead geometry for a directed edge a→b: shaft endpoints
 *  (clear of both node discs) and the head triangle (tip on the target
 *  disc edge, wideness = 0.8 × head length — the sigma arrow shape). */
/** One complete arrow glyph: shaft + head triangle. */
export interface ArrowGeom {
	shaftFrom: Pt;
	shaftTo: Pt;
	tip: Pt;
	left: Pt;
	right: Pt;
}

export function arrowGeometry(
	a: Pt,
	b: Pt,
	fromRadius: number,
	toRadius: number,
	headLength: number,
): ArrowGeom | null {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len = Math.hypot(dx, dy);
	if (len < 1e-6) return null; // degenerate (coincident) — skip
	const ux = dx / len;
	const uy = dy / len;
	const tip = { x: b.x - ux * toRadius, y: b.y - uy * toRadius };
	const base = { x: tip.x - ux * headLength, y: tip.y - uy * headLength };
	const halfW = 0.4 * headLength;
	return {
		shaftFrom: { x: a.x + ux * fromRadius, y: a.y + uy * fromRadius },
		shaftTo: base,
		tip,
		left: { x: base.x - uy * halfW, y: base.y + ux * halfW },
		right: { x: base.x + uy * halfW, y: base.y - ux * halfW },
	};
}


/** Nearest node within maxDist of a screen point (linear scan — µs at
 *  our scale; a spatial grid only earns its keep past ~10k nodes). */
export function pickNearest<T extends { id: string; x: number; y: number }>(
	nodes: T[],
	px: number,
	py: number,
	maxDist: number,
): T | null {
	let best: T | null = null;
	let bestD = maxDist * maxDist; // compare squared distances
	for (const n of nodes) {
		const d = (n.x - px) ** 2 + (n.y - py) ** 2;
		if (d < bestD) {
			bestD = d;
			best = n;
		}
	}
	return best;
}

// ─── Canvas text helpers (ported verbatim) ─────────────────────────────────

/** "#rrggbb" + alpha → "rgba(...)". */
function rgbaFromHex(hex: string, alpha: number): string {
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Word-wrap for canvas text. Never truncates: overlong single words are
 *  hard-broken by character so no line ever exceeds maxWidth. */
function wrapLabel(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
	const lines: string[] = [];
	for (const word of text.split(/\s+/).filter(Boolean)) {
		const last = lines.length > 0 ? lines[lines.length - 1]! : null;
		if (last !== null) {
			const joined = `${last} ${word}`;
			if (context.measureText(joined).width <= maxWidth) {
				lines[lines.length - 1] = joined;
				continue;
			}
		}
		let chunk = "";
		for (const char of word) {
			if (chunk && context.measureText(`${chunk}${char}`).width > maxWidth) {
				lines.push(chunk);
				chunk = char;
			} else {
				chunk += char;
			}
		}
		if (chunk) lines.push(chunk);
	}
	return lines;
}

/** World-unit sizes for the label pass, derived once per geometry build. */
interface WorldSizes {
	nodeR: number; // node disc radius, world units
	glowOuter: number; // hover halo outer radius, world units
	labelSize: number; // node label font, world units
	labelGap: number; // node edge → first label line, world units
}

/** The pre-wrapped node name, centered below the node in WORLD units —
 *  identical geometry at rest and on hover, so hover only changes the
 *  color, nothing jumps. Lines are wrapped once per geometry build, never
 *  per frame. */
function drawNameLines(
	context: CanvasRenderingContext2D,
	x: number,
	y: number,
	lines: string[],
	world: WorldSizes,
	color: string,
	/** Above the node instead (label placement found no room below). */
	above = false,
): void {
	context.fillStyle = color;
	context.textAlign = "center";
	context.textBaseline = "top";
	const lineH = world.labelSize * LABEL_LINE_HEIGHT;
	const firstTop = above
		? y - world.nodeR - world.labelGap - lines.length * lineH
		: y + world.nodeR + world.labelGap;
	for (let i = 0; i < lines.length; i++) {
		context.fillText(lines[i]!, x, firstTop + i * lineH);
	}
}

/** Where a topic name's first line goes (centre x, top y) for each label
 *  spot: 0 below the bubble, 1 above, 2 right, 3 left — the same order and
 *  geometry as the spots topicLabelsAt offers, in whatever units it is given. */
function topicLabelAnchor(
	x: number,
	y: number,
	r: number,
	spot: number,
	h: number,
	w: number,
	gap: number,
): { x: number; top: number } {
	if (spot === 1) return { x, top: y - r - gap - h };
	if (spot === 2) return { x: x + r + gap + w / 2, top: y - h / 2 };
	if (spot === 3) return { x: x - r - gap - w / 2, top: y - h / 2 };
	return { x, top: y + r + gap };
}

// ─── The renderer ───────────────────────────────────────────────────────────

export class GraphCanvasRenderer {
	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;
	private callbacks: RendererCallbacks;
	private zoomBehavior: ZoomBehavior<HTMLCanvasElement, unknown>;
	private transform: ZoomTransform = zoomIdentity;
	/** Set once the first fit happens; the camera then survives setData. */
	private hasFit = false;
	/** Last-synced CSS size — the resize anchor computes the world point
	 *  under the PRE-resize viewport center from these (ResizeObserver
	 *  callbacks already see the NEW size in clientWidth/Height). */
	private viewW = 0;
	private viewH = 0;
	/** The k that frames the whole graph — the label-gate's "1×". */
	private kFit = 1;
	/** World-space bounds of the current nodes — fit() and the resize-time
	 *  kFit refresh share it (computed once per setData, not per resize). */
	private worldBBox: { minX: number; maxX: number; minY: number; maxY: number } | null = null;
	/** The last framing the APP chose (fit or focusOn) and the insets it used,
	 *  kept until the learner moves the camera: when a panel then grows,
	 *  shrinks, opens or closes, the same framing is redone clear of it. */
	private lastFrame:
		| { kind: "fit"; insets: Insets }
		| { kind: "focus"; ids: ReadonlySet<string>; maxFit: number; insets: Insets }
		| null = null;

	private data: CanvasData | null = null;
	/** id -> node for the current data (avoids O(n^2) scans). */
	private nodeById = new Map<string, CanvasNode>();
	private settings: GraphRenderSettings | null = null;
	private visible: ReadonlySet<string> | null = null;
	/** Focus mode: ids drawn at full strength; everything else fades. null = no focus. */
	private focus: ReadonlySet<string> | null = null;

	// ── Live physics ──
	// One d3-force sim shared with the server settle (createGraphSimulation
	// in @/src/core): dragging pins fx/fy and reheats (alphaTarget), release
	// un-pins and the sim anneals; once alpha drops below SIM_SETTLE_ALPHA
	// the new rest state is debounced-committed via onCommit. The sim mutates
	// data.nodes IN PLACE (they ARE the sim nodes — zero copying), so every
	// tick just bumps geoVersion and the draw loop rebuilds geometry.
	private sim: Simulation<LayoutNode, SimulationLinkDatum<LayoutNode>> | null = null;
	private simById = new Map<string, LayoutNode>();
	private simActive = false;
	private dragId: string | null = null;
	private dragOrigin: Pt | null = null;
	private simMoved = false; // any real movement since the last commit
	private commitTimer: ReturnType<typeof setTimeout> | null = null;

	private frameId: number | null = null;
	private dirty = true;
	/** True while tick() runs: markDirty inside the loop (d3's zoom event
	 *  fires from advanceZoom) must NOT schedule — the loop schedules
	 *  itself below. Un-guarded, each glide frame leaked an extra queued
	 *  tick and draws multiplied per displayed frame (20fps zoom bug). */
	private inTick = false;

	// Hover transition: fade 0 = resting, 1 = fully hovered; the animating
	// flag keeps the loop scheduled until the fade settles (then rAF stops).
	private hoverId: string | null = null;
	/** The node the glow is drawn on. OUTLIVES hoverId on hover-out so the
	 *  fade has something to draw (hoverId nulls instantly; without this
	 *  the glow popped off in one frame instead of fading). Cleared when
	 *  the outgoing fade completes. */
	private hoverNode: CanvasNode | null = null;
	private hoverFade = 0;
	private hoverFrom = 0;
	private hoverTarget = 0;
	private hoverStart = 0;
	// Smooth wheel zoom: wheel events accumulate a target scale (cursor-
	// anchored); each tick eases the camera toward it instead of jumping.
	private zoomTarget: { k: number; x: number; y: number } | null = null;
	/** Clock for frame-rate-independent easing (updated every tick). */
	private lastTickAt = 0;
	private animating = false;

	private resizeObserver: ResizeObserver;
	private downPos: Pt | null = null;

	// ── Cached world geometry ─────────────────────────────────────────────
	// Everything above is drawn per frame; everything below is derived from
	// data+visibility+settings+kFit and rebuilt ONLY when one of those
	// changes (geoVersion). Camera moves just re-rasterize the same paths.
	private geoVersion = 0; // bump = geometry inputs changed
	private builtVersion = -1; // version the cache was built at
	private nodesPath: Path2D | null = null;
	private shaftsPath: Path2D = new Path2D();
	private headsPath: Path2D = new Path2D();
	/** Aggregated edges (count > 1) stroke heavier; faded twins for focus mode. */
	private heavyShaftsPath: Path2D = new Path2D();
	private dimNodesPath: Path2D = new Path2D();
	private dimShaftsPath: Path2D = new Path2D();
	private dimHeavyShaftsPath: Path2D = new Path2D();
	private dimHeadsPath: Path2D = new Path2D();
	/** Topic markers of the bubble view, with their pre-wrapped screen-size labels. */
	private topicMarks: { node: CanvasNode; lines: string[]; pillW: number; labelW: number }[] = [];
	/** System-name widths (px at FRAME_LABEL_PX), for label placement. */
	private frameLabelW = new Map<string, number>();
	/** Bubble view: where each fact label sits (0 below, 1 above); a fact
	 *  missing here has no clear spot and shows on hover only. null = every
	 *  label below its node (the All facts view, unchanged). */
	private factLabelAt: Map<string, number> | null = null;
	/** Topic-name placement for one zoom (screen-sized names: room depends on k). */
	private topicLabelPlan: { k: number; version: number; at: Map<string, number> } | null = null;
	private topicMarkById = new Map<string, { pillW: number }>();
	private regionCanvas: HTMLCanvasElement | null = null;
	/** World rect the bitmap covers (drawImage target coords). */
	private regionRect: { minX: number; minY: number; w: number; h: number } | null = null;
	/** Region labels: cluster centroid + hue, computed at splat build. */
	private regionMeta: { id: string; label: string | null; lines: string[] | null; cx: number; cy: number; hue: number }[] = [];
	private regionTuning: RegionTuning = DEFAULT_REGION_TUNING;
	private physicsTuning: PhysicsTuning = DEFAULT_PHYSICS_TUNING;
	/** Gravity center for the live sim (graph bbox centroid at setData). */
	private simCenter: Pt = { x: 0, y: 0 };
	private regionBuiltVersion = -1;
	private frameCount = 0; // draw counter for the live-sim splat throttle
	private labelLines = new Map<string, string[]>();
	private worldLabelFont = "";
	private world: WorldSizes = { nodeR: 0, glowOuter: 0, labelSize: 0, labelGap: 0 };

	constructor(
		canvas: HTMLCanvasElement,
		callbacks: RendererCallbacks,
		/** The caller's persisted camera (view state — localStorage): when
		 *  present it REPLACES the first-open fit; the graph opens exactly
		 *  where the user left it (2026-09-15: a default zoom exists only
		 *  on first open, ever). Invalid shapes fall back to fit. */
		initialCamera?: { k: number; x: number; y: number } | null,
	) {
		this.canvas = canvas;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("2d context unavailable");
		this.ctx = ctx;
		this.callbacks = callbacks;

		// d3-zoom owns pan / wheel zoom-to-cursor / touch pinch; every
		// transform change just marks dirty (draws happen in OUR loop).
		this.zoomBehavior = zoom<HTMLCanvasElement, unknown>()
			.scaleExtent([0.02, 40])
			.on("zoom", ({ transform, sourceEvent }) => {
				// A drag or pinch is the learner taking the camera: stop re-framing.
				if (sourceEvent) this.lastFrame = null;
				this.transform = transform;
				this.markDirty();
				// The transform doubles as the persistence payload (view state).
				this.callbacks.onCameraMove(transform);
			});
		select(canvas)
			.call(this.zoomBehavior)
			// No surprise dblclick-zoom (sigma had none).
			.on("dblclick.zoom", null)
			// Wheel is OURS now: d3's instant per-notch jump felt janky; the
			// eased glide below replaces it (pan and pinch stay d3's).
			.on("wheel.zoom", null);

		canvas.addEventListener("wheel", this.onWheel, { passive: false });
		canvas.addEventListener("pointermove", this.onPointerMove);
		canvas.addEventListener("pointerdown", this.onPointerDown);
		canvas.addEventListener("pointerup", this.onPointerUp);
		canvas.addEventListener("pointerleave", this.onPointerLeave);
		// Right-click → the caller's context menu (node interlude). Always
		// preventDefault: the native menu on a full-bleed custom canvas is
		// never useful; the caller decides what (if anything) opens.
		canvas.addEventListener("contextmenu", this.onContextMenu);

		// The persisted camera: replace the default with wherever the user
		// left the graph. Applied through the zoom behavior so d3's internal
		// state and ours agree (the same path fit() uses); hasFit so neither
		// the ResizeObserver nor setData re-fits over it.
		if (
			initialCamera &&
			typeof initialCamera.k === "number" && Number.isFinite(initialCamera.k) && initialCamera.k > 0 &&
			typeof initialCamera.x === "number" && Number.isFinite(initialCamera.x) &&
			typeof initialCamera.y === "number" && Number.isFinite(initialCamera.y)
		) {
			this.hasFit = true;
			select(canvas).call(
				this.zoomBehavior.transform,
				zoomIdentity.translate(initialCamera.x, initialCamera.y).scale(initialCamera.k),
			);
		}

		this.resizeObserver = new ResizeObserver(() => {
			// The world point under the pre-resize viewport center — the
			// visual anchor the new transform must preserve. Capture it
			// BEFORE syncSize (which updates viewW/H to the new size).
			const prevW = this.viewW;
			const prevH = this.viewH;
			const { x: tx, y: ty, k } = this.transform;
			const wx = (prevW / 2 - tx) / k;
			const wy = (prevH / 2 - ty) / k;
			this.syncSize();
			if (!this.hasFit) this.fit(); // first real size → fit once
			else {
				this.refreshFitZoom(); // the gate's "1×" is viewport-bound
				// Center-anchor (2026-09-17, owner): same world point under
				// the NEW center. Applied through the zoom behavior like every
				// camera move (d3 state, persistence, card-dismiss all agree).
				if (prevW > 0 && prevH > 0 && this.viewW > 0 && this.viewH > 0) {
					select(canvas).call(
						this.zoomBehavior.transform,
						zoomIdentity.translate(this.viewW / 2 - wx * k, this.viewH / 2 - wy * k).scale(k),
					);
				}
			}
			// Redraw SYNCHRONOUSLY: syncSize may have reallocated the backing
			// store (which clears the canvas), and during live window resizes
			// rAF is starved by relayout — a deferred draw would leave the
			// canvas blank for the whole drag (the resize-blanking bug).
			this.draw();
		});
		this.resizeObserver.observe(canvas);
		this.syncSize();
	}

	// ── Public API ──

	setData(data: CanvasData): void {
		this.data = data;
		this.nodeById = new Map(data.nodes.map((n) => [n.id, n]));
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const n of data.nodes) {
			if (n.x < minX) minX = n.x;
			if (n.y < minY) minY = n.y;
			if (n.x > maxX) maxX = n.x;
			if (n.y > maxY) maxY = n.y;
		}
		this.worldBBox = data.bounds ?? { minX, maxX, minY, maxY };
		if (!this.hasFit && data.nodes.length > 0) this.fit();
		// The camera may be user-restored (constructor initialCamera) — the
		// gate's "1×" reference still needs the fresh bbox's fit zoom.
		else this.refreshFitZoom();
		// Rebuild the live sim around the fresh nodes. New data means the
		// server spoke (merge or refetch); any pending commit is moot and
		// the graph is at rest until the next drag.
		if (this.commitTimer) {
			clearTimeout(this.commitTimer);
			this.commitTimer = null;
		}
		this.simActive = false;
		this.dragId = null;
		this.simMoved = false;
		this.simCenter = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
		this.buildSim();
		this.geoVersion++; // new data → rebuild world geometry
		this.markDirty();
	}

	setSettings(settings: GraphRenderSettings): void {
		this.settings = settings;
		this.geoVersion++; // sizes/wrap width changed → rebuild geometry
		this.markDirty();
	}

	/** Dev tuning for region rendering (session-only, never persisted):
	 *  invalid numbers fall back to defaults — the number inputs can be
	 *  emptied while typing. Forces a region bitmap rebuild. */
	setRegionTuning(input: Partial<RegionTuning>): void {
		this.regionTuning = sanitizeRegionTuning(input);
		this.regionBuiltVersion = -2; // never equals geoVersion → rebuild
		// Off switch turning off: drop the bitmap immediately so the
		// blit stops on the next frame — the rebuild itself skips all
		// compute (buildRegions).
		if (!this.regionTuning.enabled) {
			this.regionCanvas = null;
			this.regionRect = null;
		}
		this.markDirty();
	}

	/** Live-sim physics controls: rebuilds the sim from the CURRENT
	 *  node positions (same node objects — x/y and any drag pin fx/fy
	 *  survive; velocities restart clean, which reads as "re-relax with
	 *  the new feel"). A mid-settle change re-anneals, which is the
	 *  honest response to new physics. */
	setPhysicsTuning(input: Partial<PhysicsTuning>): void {
		this.physicsTuning = sanitizePhysicsTuning(input);
		this.buildSim();
		// Reheat: a tuning change re-anneals the layout from its current
		// state, so mode toggles (off/vertical/radial) visibly RE-FORM the
		// graph instead of waiting for the next drag. Mid-drag is safe —
		// buildSim preserved the pinned node's fx/fy.
		if (this.sim) {
			this.sim.alpha(1);
			this.simActive = true;
		}
		this.markDirty();
	}

	/** Label-only channel (rename-shuffle fix, 2026-09-23): live
	 *  cluster-label updates with NO setData. The rename path used to
	 *  build a fresh snapshot object, which flowed setData → geometry
	 *  rebuild — and the rebuild treats the last-fetched ledger as
	 *  authoritative and cancels any pending drag commit, so a rename
	 *  visibly rewound the whole graph whenever display had drifted
	 *  (recent drag, mid-anneal, physics re-anneal). This channel touches
	 *  ONLY label text: the region meta the draw pass reads plus the
	 *  data-side cluster record (so the next geometry rebuild —
	 *  visibility/settings/size — keeps the fresh label). Nodes, the
	 *  sim, positions, and the pending commit are never touched. */
	setClusterLabels(labels: ReadonlyMap<string, string | null>): void {
		const data = this.data;
		if (!data) return;
		const settings = this.settings;
		// No settings yet → nothing is drawn; patch the data side only and
		// let the next build derive the wrap (same guard the build uses).
		if (!settings) {
			applyClusterLabels(data.clusters, [], labels, REGION_LABEL_MAX_WIDTH, REGION_LABEL_MAX_LINES, () => 0);
			return;
		}
		const ctx = this.ctx;
		const prevFont = ctx.font;
		ctx.font = `${LABEL_WEIGHT} ${settings.clusterLabelSize}px ${data.fontFamily}`;
		const changed = applyClusterLabels(
			data.clusters,
			this.regionMeta,
			labels,
			REGION_LABEL_MAX_WIDTH,
			REGION_LABEL_MAX_LINES,
			(s) => ctx.measureText(s).width,
		);
		ctx.font = prevFont;
		if (changed) this.markDirty();
	}

	setVisible(visible: ReadonlySet<string> | null): void {
		this.visible = visible;
		this.geoVersion++; // member visibility changes hulls + paths
		this.markDirty();
	}

	/** Focus mode: draw these ids at full strength and fade everything else
	 *  (edges stay full only when both ends do). null leaves the graph as is.
	 *  Faded nodes remain pickable, so a click on one moves the focus there. */
	setFocus(ids: ReadonlySet<string> | null): void {
		this.focus = ids;
		this.geoVersion++;
		this.markDirty();
	}

	private inFocus(id: string): boolean {
		return !this.focus || this.focus.has(id);
	}

	/** Frame the whole graph (padding included). Keeps the camera on later
	 *  setData calls — call fit() only for an explicit re-frame (the
	 *  first-ever open; afterwards the caller-persisted camera wins). */
	fit(): void {
		if (!this.data || this.data.nodes.length === 0 || !this.worldBBox) return;
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		if (w < 10 || h < 10) return; // layout not ready yet; the ResizeObserver retries
		const insets = this.insets();
		const t = fitTransform(this.worldBBox, w, h, 40, insets);
		// kFit stays the whole-canvas framing: the label gate and focusOn's
		// zoom cap keep their meaning however much the panels cover.
		this.refreshFitZoom();
		this.hasFit = true;
		this.lastFrame = { kind: "fit", insets };
		select(this.canvas).call(
			this.zoomBehavior.transform,
			zoomIdentity.translate(t.x, t.y).scale(t.k),
		);
	}

	/** Frame just these nodes (padding included) — the outline's "jump into the
	 *  graph". A lone node is centred without zooming in past a readable level.
	 *  Moves the camera, so it reports through onCameraMove like any other move. */
	focusOn(ids: ReadonlySet<string>, maxFit = 3): void {
		if (!this.data) return;
		const picked = this.data.nodes.filter((n) => ids.has(n.id));
		if (picked.length === 0) return;
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		if (w < 10 || h < 10) return;
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const n of picked) {
			if (n.x < minX) minX = n.x;
			if (n.y < minY) minY = n.y;
			if (n.x > maxX) maxX = n.x;
			if (n.y > maxY) maxY = n.y;
		}
		const insets = this.insets();
		const t = fitTransform({ minX, maxX, minY, maxY }, w, h, 80, insets);
		// Never closer than maxFit x the whole-graph framing, never outside the zoom range.
		const [kMin, kMax] = this.zoomBehavior.scaleExtent();
		const k = Math.min(Math.max(t.k, kMin), kMax, Math.max(this.kFit, 1e-6) * maxFit);
		const c = centreTransform((minX + maxX) / 2, (minY + maxY) / 2, k, w, h, insets);
		select(this.canvas).call(this.zoomBehavior.transform, zoomIdentity.translate(c.x, c.y).scale(k));
		this.lastFrame = { kind: "focus", ids, maxFit, insets };
	}

	/** The floating panels changed size or came and went. If the camera is
	 *  still where the app last framed it (the learner has not panned or
	 *  zoomed since), frame the same thing again clear of the panels now. */
	viewportChanged(): void {
		const frame = this.lastFrame;
		if (!frame) return;
		const insets = this.insets();
		if (sameInsets(insets, frame.insets)) return;
		if (frame.kind === "fit") this.fit();
		else this.focusOn(frame.ids, frame.maxFit);
	}

	/** The panels' current insets (none when the caller has no panels). */
	private insets(): Insets {
		return this.callbacks.getInsets?.() ?? NO_INSETS;
	}

	/** Refresh the label-gate's "1×" reference from the current bbox +
	 *  viewport. kFit feeds ONLY zoomRatioOf now (the 2026-09-15 pivot
	 *  removed it from geometry) — so this never touches geoVersion. */
	private refreshFitZoom(): void {
		if (!this.worldBBox) return;
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		if (w >= 10 && h >= 10) this.kFit = fitTransform(this.worldBBox, w, h, 40).k;
	}

	destroy(): void {
		if (this.frameId !== null) cancelAnimationFrame(this.frameId);
		if (this.commitTimer) clearTimeout(this.commitTimer);
		this.sim = null;
		this.simActive = false;
		this.dragId = null;
		this.resizeObserver.disconnect();
		select(this.canvas).on(".zoom", null);
		this.canvas.removeEventListener("wheel", this.onWheel);
		this.canvas.removeEventListener("pointermove", this.onPointerMove);
		this.canvas.removeEventListener("pointerdown", this.onPointerDown);
		this.canvas.removeEventListener("pointerup", this.onPointerUp);
		this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
		this.canvas.removeEventListener("contextmenu", this.onContextMenu);
		this.canvas.style.cursor = "";
	}

	// ── Event handlers (state mutation only — never draw) ──

	/** Wheel: accumulate the zoom target; the camera GLIDES toward it in the
	 *  tick loop (cursor-anchored). Sensitivity formula is d3-zoom's own. */
	private onWheel = (e: WheelEvent) => {
		e.preventDefault();
		this.lastFrame = null; // the learner is zooming: stop re-framing
		const delta = -e.deltaY * (e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.002);
		const { x, y } = this.eventPos(e);
		const current = this.zoomTarget?.k ?? this.transform.k;
		// Must stay inside the zoomBehavior's scaleExtent [0.02, 40].
		const k = Math.min(Math.max(current * Math.exp(delta), 0.02), 40);
		this.zoomTarget = { k, x, y };
		// Fresh easing clock so the glide starts gentle, never half-done.
		this.lastTickAt = performance.now();
		this.markDirty();
	};

	private onPointerMove = (e: PointerEvent) => {
		const pos = this.eventPos(e);
		if (this.dragId) {
			const n = this.simById.get(this.dragId);
			if (n) {
				const moved =
					this.dragOrigin !== null &&
					Math.hypot(pos.x - this.dragOrigin.x, pos.y - this.dragOrigin.y) > CLICK_SLOP;
				if (moved) {
					// First real movement: reheat and glue the node to the cursor.
					if (this.commitTimer) {
						clearTimeout(this.commitTimer);
						this.commitTimer = null;
					}
					this.sim?.alphaTarget(DRAG_ALPHA_TARGET);
					this.simActive = true;
					this.markDirty();
				}
				const { x: tx, y: ty, k } = this.transform;
				n.fx = (pos.x - tx) / k;
				n.fy = (pos.y - ty) / k;
			}
			return;
		}
		const node = this.pickAt(pos.x, pos.y);
		if ((node?.id ?? null) !== this.hoverId) this.setHover(node?.id ?? null);
		this.canvas.style.cursor = node ? "pointer" : "";
	};

	private onPointerDown = (e: PointerEvent) => {
		// Primary button only (owner, polish round): a right-press must not
		// pin the node — right-click belongs to the context menu alone, and
		// the right-pointerup must never read as a click (the detail card
		// used to open under the menu).
		if (e.button !== 0) return;
		const pos = this.eventPos(e);
		const node = this.pickAt(pos.x, pos.y);
		if (node && this.sim) {
			// Node press: pin the node (at ITS OWN position — the cursor
			// may be inside the pick pad, off-center). preventDefault kills
			// the compatibility mousedown, so d3-zoom never starts a pan.
			// Physics only reheats once the pointer exceeds CLICK_SLOP —
			// a plain click stays perfectly still.
			e.preventDefault();
			try {
				this.canvas.setPointerCapture(e.pointerId);
			} catch {
				/* capture is best-effort */
			}
			this.dragId = node.id;
			this.dragOrigin = pos;
			const n = this.simById.get(node.id);
			if (n) {
				n.fx = n.x;
				n.fy = n.y;
			}
			this.canvas.style.cursor = "grabbing";
			this.markDirty();
			return;
		}
		this.downPos = pos;
		this.zoomTarget = null; // a pan takes over — cancel any zoom glide
	};

	private onPointerUp = (e: PointerEvent) => {
		if (e.button !== 0) return; // right-click is context-menu territory
		// Node press ending: click (no slop) → select; drag → release-and-relax.
		if (this.dragId) {
			const id = this.dragId;
			this.dragId = null;
			this.dragOrigin = null;
			try {
				this.canvas.releasePointerCapture(e.pointerId);
			} catch {
				/* already released */
			}
			this.canvas.style.cursor = "";
			const n = this.simById.get(id);
			if (n) {
				n.fx = null;
				n.fy = null;
			}
			if (this.simActive) {
				// Real drag: the sim anneals to the new rest state; advanceSim
				// detects the settle and schedules the commit.
				this.sim?.alphaTarget(0);
				this.markDirty();
			} else {
				// Never heated: a plain click on the node.
				this.callbacks.onSelect(id, this.eventPos(e));
			}
			return;
		}
		if (!this.downPos) return;
		const pos = this.eventPos(e);
		const moved = Math.hypot(pos.x - this.downPos.x, pos.y - this.downPos.y);
		this.downPos = null;
		if (moved > CLICK_SLOP) return; // that was a drag (pan), not a click
		const node = this.pickAt(pos.x, pos.y);
		if (node) this.callbacks.onSelect(node.id, pos);
		else this.callbacks.onStageClick();
	};

	/** Right-click: pick the node under the pointer, hand the position to
	 *  the caller (empty stage = null — the caller closes any open menu). */
	private onContextMenu = (e: MouseEvent) => {
		e.preventDefault();
		const pos = this.eventPos(e);
		const node = this.pickAt(pos.x, pos.y);
		this.callbacks.onContext(node?.id ?? null, pos);
	};

	private onPointerLeave = () => {
		if (this.dragId) return; // pointer capture keeps the drag alive
		this.downPos = null;
		this.setHover(null);
	};

	// ── Internals ──

	private eventPos(e: { clientX: number; clientY: number }): Pt {
		const rect = this.canvas.getBoundingClientRect();
		return { x: e.clientX - rect.left, y: e.clientY - rect.top };
	}

	private pickAt(px: number, py: number): CanvasNode | null {
		if (!this.data || !this.settings) return null;
		// Screen positions, filtered to visible nodes.
		const { x: tx, y: ty, k } = this.transform;
		// Discs scale with the camera now: their screen radius is
		// nodeSize × k/kFit; the halo pad stays a constant screen pad.
		// nodeSize is world units now (2026-09-15): the on-screen hit radius
		// is the disc's world radius × the camera zoom, plus the constant
		// screen pad — the whole halo stays hit-testable.
		const maxDist = this.settings.nodeSize * k + PICKING_PAD;
		const projected: { id: string; x: number; y: number }[] = [];
		let topicHit: CanvasNode | null = null;
		let topicBest = Infinity;
		for (const n of this.data.nodes) {
			if (this.visible && !this.visible.has(n.id)) continue;
			if (isImpNodeId(n.id)) continue; // pure geometry — never picked
			const sx = n.x * k + tx;
			const sy = n.y * k + ty;
			if (n.kind === "topic") {
				// A closed topic is its bubble; an open one only its header pill,
				// so the facts inside the ring stay pickable.
				let d: number;
				if (n.open) {
					const half = (this.topicMarkById.get(n.id)?.pillW ?? 60) / 2 + TOPIC_PICK_PAD;
					if (Math.abs(px - sx) > half || Math.abs(py - sy) > TOPIC_PILL_H / 2 + TOPIC_PICK_PAD) continue;
					d = -1e9;
				} else {
					d = Math.hypot(px - sx, py - sy) - (n.radius ?? 0) * k;
					if (d > TOPIC_PICK_PAD) continue;
				}
				if (d < topicBest) {
					topicBest = d;
					topicHit = n;
				}
				continue;
			}
			projected.push({ id: n.id, x: sx, y: sy });
		}
		if (topicHit) return topicHit;
		const hit = pickNearest(projected, px, py, maxDist);
		if (!hit) return null;
		return this.nodeById.get(hit.id) ?? null;
	}

	private setHover(nodeId: string | null): void {
		if (nodeId === this.hoverId && this.hoverTarget === (nodeId ? 1 : 0)) return;
		this.hoverId = nodeId;
		// Hover-out deliberately KEEPS hoverNode: the glow must fade out
		// from the last hovered node, not vanish with the id.
		if (nodeId) this.hoverNode = this.nodeById.get(nodeId) ?? null;
		// Rebase the animation from the CURRENT fade: rapid hover toggles
		// glide instead of snapping (ported from the sigma-era behavior).
		this.hoverFrom = this.hoverFade;
		this.hoverTarget = nodeId ? 1 : 0;
		this.hoverStart = performance.now();
		this.animating = true;
		this.markDirty();
	}

	private markDirty(): void {
		this.dirty = true;
		if (this.frameId === null && !this.inTick) {
			this.frameId = requestAnimationFrame(() => {
				this.frameId = null;
				this.tick();
			});
		}
	}

	private tick(): void {
		this.inTick = true;
		try {
			const now = performance.now();
			// Clamp the dt: a long idle gap must not teleport the ease forward.
			const dt = Math.min(Math.max(now - this.lastTickAt, 8), 100);
			this.lastTickAt = now;
			const hoverAnim = this.advanceHover();
			const zoomAnim = this.advanceZoom(dt);
			const simAnim = this.advanceSim();
			this.draw();
			// Keep frames coming ONLY while an animation is in motion (hover
			// fade, zoom glide, or live physics); an idle graph schedules no
			// rAF at all.
			this.animating = hoverAnim || zoomAnim || simAnim;
		} finally {
			this.inTick = false;
		}
		if (this.animating) {
			this.frameId = requestAnimationFrame(() => {
				this.frameId = null;
				this.tick();
			});
		}
	}

	/** One live-sim step; returns true while physics is still in motion.
	 *  Runs only while simActive (drag reheat or post-release anneal). */
	private advanceSim(): boolean {
		if (!this.sim || !this.simActive) return false;
		this.sim.tick();
		// Movement check: did any node actually move (a click-pin that
		// never reheated leaves everything exactly at rest)?
		for (const n of this.sim.nodes()) {
			if (n.vx || n.vy) {
				this.simMoved = true;
				break;
			}
		}
		this.geoVersion++; // positions changed → geometry rebuild in draw()
		// Settled (drag released long ago, alpha annealed away)?
		if (!this.dragId && this.sim.alpha() < SIM_SETTLE_ALPHA) {
			this.simActive = false;
			this.scheduleCommit();
			return false;
		}
		return true;
	}

	/** Debounced rest-state commit. A new drag or setData cancels it. */
	private scheduleCommit(): void {
		if (this.commitTimer) clearTimeout(this.commitTimer);
		this.commitTimer = setTimeout(() => {
			this.commitTimer = null;
			if (!this.data || !this.simMoved) return;
			this.simMoved = false;
			const positions: Record<string, Position> = {};
			for (const n of this.data.nodes) positions[n.id] = { x: n.x, y: n.y };
			this.callbacks.onCommit(positions);
		}, COMMIT_DEBOUNCE_MS);
	}

	/** Hover fade step; returns true while still moving. */
	private advanceHover(): boolean {
		if (this.hoverFade === this.hoverTarget) return false;
		const t = Math.min((performance.now() - this.hoverStart) / HOVER_FADE_MS, 1);
		this.hoverFade = this.hoverFrom + (this.hoverTarget - this.hoverFrom) * t;
		// Outgoing fade finished — release the glow node.
		if (this.hoverTarget === 0 && this.hoverFade === 0) this.hoverNode = null;
		return t < 1;
	}

	/** Zoom glide step: ease k toward the wheel target, keeping the world
	 *  point under the cursor pinned. Frame-rate independent (exponential
	 *  approach, time constant ZOOM_EASE_MS). Returns true while gliding. */
	private advanceZoom(dt: number): boolean {
		const target = this.zoomTarget;
		if (!target) return false;
		const t = this.transform;
		const blend = 1 - Math.exp(-dt / ZOOM_EASE_MS);
		let k = t.k + (target.k - t.k) * blend;
		let done = false;
		if (Math.abs(target.k - k) / target.k < 0.002) {
			k = target.k;
			done = true;
		}
		const scale = k / t.k;
		const x = target.x - (target.x - t.x) * scale;
		const y = target.y - (target.y - t.y) * scale;
		if (done) this.zoomTarget = null;
		// Applied through d3-zoom so constraints + the zoom event (markDirty,
		// onCameraMove) fire exactly as with any other camera change.
		select(this.canvas).call(
			this.zoomBehavior.transform,
			zoomIdentity.translate(x, y).scale(k),
		);
		return !done;
	}

	/** Resize the backing store to the CSS box × devicePixelRatio; all
	 *  drawing then happens in CSS pixels through the DPR transform. */
	private syncSize(): void {
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		const dpr = window.devicePixelRatio || 1;
		const bw = Math.max(1, Math.round(w * dpr));
		const bh = Math.max(1, Math.round(h * dpr));
		if (this.canvas.width !== bw || this.canvas.height !== bh) {
			this.canvas.width = bw;
			this.canvas.height = bh;
		}
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.viewW = w;
		this.viewH = h;
	}

	/** Derive ALL world geometry from data + visibility + settings.
	 *  Runs only when geoVersion moves — never per frame, never per camera
	 *  change. Zoom/pan pay zero geometry math, only rasterization. Sizes
	 *  are WORLD UNITS straight from the settings (the 2026-09-15 pivot —
	 *  no ÷kFit: the world scale is canonical, viewport-independent). */
	private buildGeometry(): void {
		this.builtVersion = this.geoVersion;
		const data = this.data;
		const settings = this.settings;
		if (!data || !settings) return;

		const nodeR = settings.nodeSize;
		this.worldLabelFont = `${LABEL_WEIGHT} ${settings.labelSize}px ${data.fontFamily}`;
		this.world = {
			nodeR,
			glowOuter: nodeR * GLOW_SCALE,
			labelSize: settings.labelSize,
			labelGap: LABEL_GAP,
		};
		const visible = this.visible;
		const isVisible = (id: string) => !visible || visible.has(id);

		// Node discs: one Path2D, one fill() per frame. Implication nodes
		// are pure geometry — never a disc, never a label, never picked.
		// Topic markers (bubble view) are drawn by drawTopics, not here.
		// Focus mode splits the discs into a full-strength and a faded path.
		const nodesPath = new Path2D();
		const dimNodesPath = new Path2D();
		for (const n of data.nodes) {
			if (!isVisible(n.id) || isImpNodeId(n.id) || n.kind === "topic") continue;
			const path = this.inFocus(n.id) ? nodesPath : dimNodesPath;
			path.moveTo(n.x + nodeR, n.y);
			path.arc(n.x, n.y, nodeR, 0, Math.PI * 2);
		}
		this.nodesPath = nodesPath;
		this.dimNodesPath = dimNodesPath;

		// Edge shafts + arrowheads (rendering arc, owner 2026-09-30): all
		// arrows are PLAIN single shafts — the old double-shaft glyph is
		// gone entirely. An argument's geometry: lines INTO an implication
		// node are HEADLESS and run all the way to the imp node's CENTER
		// (co-premise lines converge to a point); the line OUT of it starts
		// at the center and its arrowhead lands on the conclusion's disc
		// edge. Single-premise arguments arrive here as ordinary
		// proposition→proposition edges and draw exactly like any arrow.
		// A closed topic's bubble is an endpoint at its own radius, and an
		// aggregated edge (count > 1) strokes heavier. Focus mode sends an
		// edge to the faded set unless both its ends are in focus.
		const arrowLen = settings.arrowLength;
		const shafts = new Path2D();
		const heavyShafts = new Path2D();
		const heads = new Path2D();
		const dimShafts = new Path2D();
		const dimHeavyShafts = new Path2D();
		const dimHeads = new Path2D();
		const radiusOf = (n: CanvasNode) => (n.kind === "topic" && !n.open ? (n.radius ?? nodeR) : nodeR);
		for (const e of data.edges) {
			if (!isVisible(e.from) || !isVisible(e.to)) continue;
			const a = this.nodeById.get(e.from);
			const b = this.nodeById.get(e.to);
			if (!a || !b) continue;
			const intoImp = isImpNodeId(e.to);
			const outOfImp = isImpNodeId(e.from);
			const g = arrowGeometry(a, b, outOfImp ? 0 : radiusOf(a), intoImp ? 0 : radiusOf(b), arrowLen);
			if (!g) continue;
			const bright = this.inFocus(e.from) && this.inFocus(e.to);
			const heavy = (e.count ?? 1) > 1;
			const lines = bright ? (heavy ? heavyShafts : shafts) : heavy ? dimHeavyShafts : dimShafts;
			const tips = bright ? heads : dimHeads;
			lines.moveTo(g.shaftFrom.x, g.shaftFrom.y);
			if (intoImp) {
				// toRadius 0 put the tip AT the imp node's center: the
				// headless shaft terminates there (no head triangle).
				lines.lineTo(g.tip.x, g.tip.y);
			} else {
				lines.lineTo(g.shaftTo.x, g.shaftTo.y);
				tips.moveTo(g.tip.x, g.tip.y);
				tips.lineTo(g.left.x, g.left.y);
				tips.lineTo(g.right.x, g.right.y);
				tips.closePath();
			}
		}
		this.shaftsPath = shafts;
		this.heavyShaftsPath = heavyShafts;
		this.headsPath = heads;
		this.dimShaftsPath = dimShafts;
		this.dimHeavyShaftsPath = dimHeavyShafts;
		this.dimHeadsPath = dimHeads;

		// Cluster regions are NOT built here: they rasterize into their own
		// low-res bitmap (see buildRegions), on their own rebuild schedule
		// (live-sim frames skip 2 of 3 rebuilds and blit the last bitmap).

		// Label wrapping: measureText once per node per geometry build,
		// never per frame. Wrap width keeps the bigger-label/bigger-wrap
		// behavior from the sigma era.
		this.labelLines = new Map();
		const ctx = this.ctx;
		const prevFont = ctx.font;
		ctx.font = this.worldLabelFont;
		const maxW = LABEL_MAX_WIDTH * (settings.labelSize / LABEL_SIZE);
		for (const n of data.nodes) {
			if (isVisible(n.id) && !isImpNodeId(n.id) && n.kind !== "topic") this.labelLines.set(n.id, wrapLabel(ctx, n.label, maxW));
		}
		// Bubble view: an open topic packs its facts tight, so their names
		// would pile up. Place them clear of each other and of the discs,
		// best-connected facts first. World units: names scale with the graph,
		// so one placement holds at every zoom. Faded (focus) facts draw no
		// label and take no room.
		this.factLabelAt = null;
		if (data.staticLayout) {
			const degree = new Map<string, number>();
			for (const e of data.edges) {
				degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
				degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
			}
			const lineH = settings.labelSize * LABEL_LINE_HEIGHT;
			const candidates: LabelCandidate[] = [];
			const obstacles: LabelObstacle[] = [];
			for (const [id, lines] of this.labelLines) {
				const n = this.nodeById.get(id);
				if (!n) continue;
				obstacles.push({ x: n.x, y: n.y, r: nodeR, owner: id });
				if (!this.inFocus(id)) continue;
				const w = Math.max(...lines.map((l) => ctx.measureText(l).width), 0);
				const h = lines.length * lineH;
				candidates.push({
					id,
					priority: degree.get(id) ?? 0,
					spots: [
						{ x: n.x - w / 2, y: n.y + nodeR + LABEL_GAP, w, h },
						{ x: n.x - w / 2, y: n.y - nodeR - LABEL_GAP - h, w, h },
					],
				});
			}
			this.factLabelAt = placeLabels(candidates, { obstacles, pad: settings.labelSize * 0.3 });
		}
		// Topic labels are screen-sized (not world-scaled): wrapped once here.
		this.topicMarks = [];
		this.topicMarkById = new Map();
		ctx.font = `600 ${TOPIC_LABEL_PX}px ${data.fontFamily}`;
		const measure = (t: string) => ctx.measureText(t).width;
		for (const n of data.nodes) {
			if (n.kind !== "topic" || !isVisible(n.id)) continue;
			const lines = wrapRegionLabel(n.open ? `${n.label} · ${n.count ?? 0}` : n.label, n.open ? 240 : 120, n.open ? 1 : 2, measure);
			const labelW = Math.max(...lines.map(measure), 0);
			const pillW = labelW + TOPIC_PILL_PAD;
			this.topicMarks.push({ node: n, lines, pillW, labelW });
			this.topicMarkById.set(n.id, { pillW });
		}
		this.frameLabelW = new Map();
		ctx.font = `600 ${FRAME_LABEL_PX}px ${data.fontFamily}`;
		for (const f of data.frames ?? []) this.frameLabelW.set(f.id, ctx.measureText(f.label).width);
		this.topicLabelPlan = null;
		ctx.font = prevFont;
	}

	/** (Re)create the live sim from data.nodes at their current
	 *  positions + the current physics tuning. Called by setData and
	 *  setPhysicsTuning. */
	private buildSim(): void {
		const data = this.data;
		// A fixed layout (the bubble view) has no physics: nothing drags.
		if (!data || data.nodes.length === 0 || data.staticLayout) {
			this.sim = null;
			this.simById = new Map();
			return;
		}
		const t = this.physicsTuning;
		this.sim = createGraphSimulation(data.nodes, data.edges, {
			logicalEdges: data.logicalEdges,
			impLinks: data.impLinks,
			gravity: { x: this.simCenter.x, y: this.simCenter.y, strength: t.gravity },
			alphaDecay: LIVE_ALPHA_DECAY,
			velocityDecay: t.velocityDecay,
			chargeStrength: t.chargeStrength,
			linkStrength: t.linkStrength,
			linkDistance: t.linkDistance,
			clusterPull:
				data.clusters.length > 0 ? { clusters: data.clusters, strength: t.clusterPull } : undefined,
			depthAnchor:
				t.depthMode === "off"
					? undefined
					: {
							mode: t.depthMode,
							strength: t.depthStrength,
							spacing: t.depthSpacing,
							baseRadius: t.depthBaseRadius,
							center: this.simCenter,
						},
		});
		this.simById = new Map(data.nodes.map((n) => [n.id, n as LayoutNode]));
		// Hygiene (2026-09-23 fix wave): a fresh sim starts at alpha 1 and
		// never decays while stopped — so the first post-rebuild drag would
		// re-anneal the whole graph at full strength (alphaTarget(0.3)
		// glides DOWN from 1 instead of gently up from rest). Initialize at
		// the settle floor so first-drag behavior matches steady-state
		// drags. setPhysicsTuning still rehearses its explicit alpha(1)
		// when a full re-anneal IS the point.
		this.sim.alpha(SIM_SETTLE_ALPHA);
	}

	/** Rasterize cluster regions into the low-res world-space bitmap.
	 *  Runs on data/visibility/settings changes at rest, and every
	 *  REGION_EVERY-th frame while the live sim moves nodes (the in-between
	 *  frames blit the previous bitmap — one sim step of staleness at
	 *  120fps is invisible). Positions come straight from data.nodes. */
	private buildRegions(): void {
		const data = this.data;
		if (!data || data.clusters.length === 0) {
			this.regionCanvas = null;
			this.regionRect = null;
			this.regionMeta = [];
			return;
		}
		const visible = this.visible;
		const isVisible = (id: string): boolean => !visible || visible.has(id);

		const tuning = this.regionTuning;
		// Dilation is WORLD units (the 2026-09-15 pivot) — the region stroke
		// half-width comes straight from the setting, no kFit.

		// World rect over VISIBLE cluster members (regions cover members
		// and their intra-cluster edges — nothing else).
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const c of data.clusters) {
			for (const id of c.members) {
				if (!isVisible(id)) continue;
				const n = this.nodeById.get(id);
				if (!n) continue;
				if (n.x < minX) minX = n.x;
				if (n.x > maxX) maxX = n.x;
				if (n.y < minY) minY = n.y;
				if (n.y > maxY) maxY = n.y;
			}
		}
		if (minX > maxX) {
			this.regionCanvas = null;
			this.regionRect = null;
			this.regionMeta = [];
			return;
		}

		// Which cluster is a node in (for intra-cluster edges)?
		const clusterOf = new Map<string, number>();
		data.clusters.forEach((c, i) => {
			for (const id of c.members) clusterOf.set(id, i);
		});

		// Label anchors ALWAYS compute (cheap — a centroid pass, no canvas):
		// cluster labels follow their own `clusterLabels` setting and must
		// survive the region paint being turned off.
		this.regionMeta = [];
		data.clusters.forEach((cluster) => {
			let members = 0;
			let sumX = 0;
			let sumY = 0;
			for (const id of cluster.members) {
				if (!isVisible(id)) continue;
				const n = this.nodeById.get(id);
				if (!n) continue;
				members++;
				sumX += n.x;
				sumY += n.y;
			}
			if (members > 0) {
				this.regionMeta.push({
					id: cluster.id,
					label: cluster.label || null,
					cx: sumX / members,
					cy: sumY / members,
					hue: clusterHue(cluster.id),
					lines: null,
				});
			}
		});

		// Wrap the region labels ONCE per geometry build, at their
		// SCREEN-fixed size (viewer-relative labels — this px size is what
		// lands on screen at any zoom, so the wrap never goes stale mid-
		// camera-move). Session names are short; file paths are not (wave
		// 7) — the cap + ellipsis keeps the footprint bounded.
		const settings = this.settings;
		if (settings) {
			const ctx = this.ctx;
			const prevFont = ctx.font;
			ctx.font = `${LABEL_WEIGHT} ${settings.clusterLabelSize}px ${data.fontFamily}`;
			for (const rm of this.regionMeta) {
				rm.lines = rm.label
					? wrapRegionLabel(rm.label, REGION_LABEL_MAX_WIDTH, REGION_LABEL_MAX_LINES, (s) => ctx.measureText(s).width)
					: null;
			}
			ctx.font = prevFont;
		}

		// THE off switch (user 2026-09-15): compute is skipped, not just
		// paint hidden — no splat, no blur, no readback, no bitmap, no
		// blit. Everything below this return is the bitmap path.
		if (!tuning.enabled) {
			this.regionCanvas = null;
			this.regionRect = null;
			return;
		}

		// Bitmap sizing: longest world span maps to `bitmap` px. The rect
		// is padded by the stroke half-width (dilation) plus the blur
		// reach so nothing clips at the bitmap edge.
		//
		// The blur reach is WORLD units (the 2026-09-15 pivot's last step):
		// tuning.blur IS the world reach, canonical like dilation — it no
		// longer scales with the graph's span (the old blurW = blur ×
		// span/bitmap read 6× softer on a 338-node graph than on a
		// 13-node one). This also makes the 2026-09-14 search-collapse fix
		// structural: a world-unit blur cannot be coupled to any cell, so
		// the old `cellRef` anchor is gone.
		const dilationW = tuning.dilation;
		const blurW = tuning.blur;
		const padWorld = dilationW + blurW * 2;
		// Cell floor: a single visible node (span 0) zeroed the cell and
		// blew the bitmap dims to Infinity (getImageData TypeError). The
		// floor is the padded rect's own reach, so dims stay finite (long
		// side ≤ bitmap · (1 + span/2·pad)) however tight the search.
		const spanNow = Math.max(maxX - minX, maxY - minY);
		const cell = Math.max(spanNow, padWorld * 2) / tuning.bitmap;
		minX -= padWorld;
		minY -= padWorld;
		maxX += padWorld;
		maxY += padWorld;
		const spanX = maxX - minX;
		const spanY = maxY - minY;
		const bw = Math.max(1, Math.ceil(spanX / cell));
		const bh = Math.max(1, Math.ceil(spanY / cell));
		let rc = this.regionCanvas;
		if (!rc) {
			rc = document.createElement("canvas");
			this.regionCanvas = rc;
		}
		if (rc.width !== bw || rc.height !== bh) {
			rc.width = bw;
			rc.height = bh; // also clears
		}
		// willReadFrequently: the blur step getImageData/putImageData every
		// rebuild — Chrome keeps this canvas on the CPU instead of GPU-
		// shuttling it.
		const rctx = rc.getContext("2d", { willReadFrequently: true });
		if (!rctx) return;
		rctx.clearRect(0, 0, bw, bh);
		rctx.lineCap = "round";
		rctx.lineWidth = (dilationW * 2) / cell;

		// The region IS the dilated skeleton: intra-cluster edges as
		// round-cap strokes (Minkowski dilation). NO blanket per-node discs
		// — they double-counted where nodes sit on edges (user-identified
		// hot spots, when clusters were edge-based).
		data.clusters.forEach((cluster, ci) => {
			const hue = clusterHue(cluster.id);
			// Full-opacity strokes: alpha is applied ONCE at the very end
			// (dilate at 1 → blur → scale by edgeAlpha). Baking per-stroke
			// alpha in here made source-over stacking ACCUMULATE it — an
			// orphan disc overlapping anything read as a darker double-
			// counted spot (user report 2026-09-14). At alpha 1 the alpha
			// channel is a pure coverage indicator: overlaps of any count
			// contribute exactly 1.0.
			rctx.strokeStyle = `hsla(${hue}, 65%, 60%, 1)`;
			rctx.beginPath();
			// Endpoints actually covered by a stroke's round caps.
			const touched = new Set<string>();
			for (const e of data.edges) {
				if (clusterOf.get(e.from) !== ci) continue;
				if (clusterOf.get(e.to) !== ci) continue;
				// Search filter: stroke only fully-visible edges. Invisible-node
				// segments still stroked into the (visible-only) bitmap cut
				// diagonal hue streaks across other clusters' regions (user-
				// reported 2026-09-14) — rect, discs, and anchors already filter.
				if (!isVisible(e.from) || !isVisible(e.to)) continue;
				const a = this.nodeById.get(e.from);
				const b = this.nodeById.get(e.to);
				if (!a || !b) continue;
				rctx.moveTo((a.x - minX) / cell, (a.y - minY) / cell);
				rctx.lineTo((b.x - minX) / cell, (b.y - minY) / cell);
				touched.add(e.from);
				touched.add(e.to);
			}
			rctx.stroke();

			// Member discs for the SEMANTIC era (DECIDED 2026-09-13): clusters
			// are now topics by meaning, and many members (orphans, isolated
			// micro-topics) share NO intra-cluster edge with anyone — edge
			// strokes alone left them completely uncolored. A disc (same
			// radius as a round cap = dilation) covers exactly the members no
			// stroke reached: every member is painted by its edges' caps OR
			// one disc, never both — the no-double-counting rule survives.
			rctx.fillStyle = `hsla(${hue}, 65%, 60%, 1)`;
			const discR = dilationW / cell;
			for (const id of cluster.members) {
				if (touched.has(id) || !isVisible(id)) continue;
				const n = this.nodeById.get(id);
				if (!n) continue;
				rctx.beginPath();
				rctx.arc((n.x - minX) / cell, (n.y - minY) / cell, discR, 0, Math.PI * 2);
				rctx.fill();
			}
		});

		// THE blur + alpha (in that order, by design — user-decided
		// 2026-09-14): 3 box-blur rounds on the premultiplied bitmap,
		// THEN scale the whole field by edgeAlpha once. Bilinear
		// upscaling alone is no blur at all (tent ramps — the JPEG look);
		// this makes the field genuinely smooth before the blit. The
		// radius is the world reach ÷ cell, rounded to an integer
		// (boxBlurRound indexes with the loop counter) with a 1px floor —
		// a graph whose cell exceeds the blur reach still gets one pixel
		// of softening rather than aliasing to zero. Radius 0 (blur off)
		// still runs this path — boxBlurRound
		// copies — so the end-alpha applies uniformly with or without
		// blur.
		{
			const blurPx = tuning.blur > 0 ? Math.max(1, Math.round(blurW / cell)) : 0;
			const img = rctx.getImageData(0, 0, bw, bh);
			const n = bw * bh * 4;
			const a = new Float32Array(n);
			for (let i = 0; i < n; i += 4) {
				const alpha = img.data[i + 3]! / 255;
				a[i] = img.data[i]! * alpha;
				a[i + 1] = img.data[i + 1]! * alpha;
				a[i + 2] = img.data[i + 2]! * alpha;
				a[i + 3] = img.data[i + 3]!;
			}
			const b = new Float32Array(n);
			const tmp = new Float32Array(n); // scratch inside each round only
			boxBlurRound(a, tmp, b, bw, bh, blurPx); // a → b
			boxBlurRound(b, tmp, a, bw, bh, blurPx); // b → a
			boxBlurRound(a, tmp, b, bw, bh, blurPx); // a → b (result)
			// Unpremultiply back into pixels; scale the alpha by edgeAlpha
			// HERE — the one, final application. Result: constant interior
			// alpha everywhere covered, tapering only across the blur edges.
			for (let i = 0; i < n; i += 4) {
				const alpha = b[i + 3]!;
				if (alpha <= 0) {
					img.data[i] = 0;
					img.data[i + 1] = 0;
					img.data[i + 2] = 0;
					img.data[i + 3] = 0;
				} else {
					// Un-premultiply: pm = c * a/255, so c = pm / a * 255.
					img.data[i] = Math.round((b[i]! / alpha) * 255);
					img.data[i + 1] = Math.round((b[i + 1]! / alpha) * 255);
					img.data[i + 2] = Math.round((b[i + 2]! / alpha) * 255);
					img.data[i + 3] = Math.round(alpha * tuning.edgeAlpha);
				}
			}
			rctx.putImageData(img, 0, 0);
		}
		this.regionRect = { minX, minY, w: spanX, h: spanY };
	}

	/** Where each closed topic's name goes at zoom k (a topicLabelAnchor
	 *  spot: below, above, right, left; missing = hidden, shown on hover). Names keep their on-screen size while the bubbles
	 *  scale, so the room depends on k: placed in screen px (the pan offset
	 *  does not matter) and cached until the zoom or the geometry changes.
	 *  System names and open-topic headers are always drawn, so they block;
	 *  in focus mode the focused topics place first. */
	private topicLabelsAt(k: number, data: CanvasData): Map<string, number> {
		const plan = this.topicLabelPlan;
		if (plan && plan.k === k && plan.version === this.builtVersion) return plan.at;
		const fixed: Rect[] = [];
		const obstacles: LabelObstacle[] = [];
		const candidates: LabelCandidate[] = [];
		const frameH = FRAME_LABEL_PX * 1.2;
		for (const f of data.frames ?? []) {
			const w = this.frameLabelW.get(f.id) ?? 0;
			fixed.push({ x: f.x * k - w / 2, y: (f.y - f.r) * k - 3 - frameH, w, h: frameH });
		}
		for (const { node: n, lines, pillW, labelW } of this.topicMarks) {
			const sx = n.x * k;
			const sy = n.y * k;
			if (n.open) {
				fixed.push({ x: sx - pillW / 2, y: sy - TOPIC_PILL_H / 2, w: pillW, h: TOPIC_PILL_H });
				continue;
			}
			const r = (n.radius ?? 8) * k;
			// A name may cross another bubble's outline (it has a halo) but
			// never its count: text on text is the unreadable case.
			if (r >= TOPIC_COUNT_MIN_R) obstacles.push({ x: sx, y: sy, r: TOPIC_COUNT_PX * 0.75, owner: n.id });
			const h = lines.length * TOPIC_LINE_H;
			candidates.push({
				id: n.id,
				priority: (this.focus && this.inFocus(n.id) ? 1e9 : 0) + (n.count ?? 0),
				spots: [
					{ x: sx - labelW / 2, y: sy + r + TOPIC_LABEL_GAP, w: labelW, h },
					{ x: sx - labelW / 2, y: sy - r - TOPIC_LABEL_GAP - h, w: labelW, h },
					{ x: sx + r + TOPIC_LABEL_GAP, y: sy - h / 2, w: labelW, h },
					{ x: sx - r - TOPIC_LABEL_GAP - labelW, y: sy - h / 2, w: labelW, h },
				],
			});
		}
		const at = placeLabels(candidates, { obstacles, fixed, pad: TOPIC_LABEL_PAD });
		this.topicLabelPlan = { k, version: this.builtVersion, at };
		return at;
	}

	/** Topic markers: a closed topic is a translucent bubble with its fact count
	 *  inside and its name beside it where there is room (topicLabelsAt); an open one is a dashed ring with a header pill
	 *  ("− Name · 12") at the top that closes it. Text and strokes keep a
	 *  constant on-screen size (÷ k); a faded topic (focus mode) dims whole. */
	private drawTopics(ctx: CanvasRenderingContext2D, k: number, data: CanvasData): void {
		if (this.topicMarks.length === 0) return;
		const color = data.colors.node;
		const text = data.colors.hoverText;
		const labelAt = this.topicLabelsAt(k, data);
		ctx.save();
		ctx.textAlign = "center";
		for (const { node: n, lines, pillW, labelW } of this.topicMarks) {
			const r = n.radius ?? 8;
			ctx.globalAlpha = this.inFocus(n.id) ? 1 : DIM_ALPHA * 2;
			if (!n.open) {
				ctx.beginPath();
				ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
				ctx.fillStyle = rgbaFromHex(color, 0.28);
				ctx.fill();
				ctx.lineWidth = 1.2 / k;
				ctx.strokeStyle = rgbaFromHex(color, 0.85);
				ctx.stroke();
				ctx.fillStyle = text;
				if (r * k >= TOPIC_COUNT_MIN_R) {
					ctx.font = `700 ${TOPIC_COUNT_PX / k}px ${data.fontFamily}`;
					ctx.textBaseline = "middle";
					ctx.fillText(String(n.count ?? 0), n.x, n.y);
				}
				// The name: below the bubble, else above, else (no room) on hover only.
				const at = labelAt.get(n.id);
				if (at !== undefined) {
					ctx.font = `600 ${TOPIC_LABEL_PX / k}px ${data.fontFamily}`;
					ctx.textBaseline = "top";
					const lineH = TOPIC_LINE_H / k;
					const { x, top } = topicLabelAnchor(n.x, n.y, r, at, lines.length * lineH, labelW / k, TOPIC_LABEL_GAP / k);
					// A thin halo in the page colour keeps the name readable
					// where it crosses another bubble or an edge.
					if (data.colors.background) {
						ctx.lineJoin = "round";
						ctx.lineWidth = 3 / k;
						ctx.strokeStyle = rgbaFromHex(data.colors.background, 0.8);
						lines.forEach((line, i) => ctx.strokeText(line, x, top + i * lineH));
					}
					lines.forEach((line, i) => ctx.fillText(line, x, top + i * lineH));
				}
			} else {
				// The ring round the open topic's facts: centre is a radius below the header.
				ctx.beginPath();
				ctx.arc(n.x, n.y + r, r, 0, Math.PI * 2);
				ctx.setLineDash([5 / k, 4 / k]);
				ctx.lineWidth = 1 / k;
				ctx.strokeStyle = rgbaFromHex(color, 0.4);
				ctx.stroke();
				ctx.setLineDash([]);
				const w = pillW / k;
				const h = TOPIC_PILL_H / k;
				ctx.beginPath();
				ctx.roundRect(n.x - w / 2, n.y - h / 2, w, h, h / 2);
				ctx.fillStyle = rgbaFromHex(color, 0.25);
				ctx.fill();
				ctx.lineWidth = 1 / k;
				ctx.strokeStyle = rgbaFromHex(color, 0.7);
				ctx.stroke();
				ctx.fillStyle = text;
				ctx.font = `600 ${TOPIC_LABEL_PX / k}px ${data.fontFamily}`;
				ctx.textBaseline = "middle";
				ctx.fillText(`− ${lines[0] ?? ""}`, n.x, n.y);
			}
		}
		ctx.restore();
	}

	/** THE draw function: every layer, one frame, one camera. All drawing
	 *  happens in WORLD coordinates under the camera transform; nothing is
	 *  recomputed per frame except layer styling. */
	private draw(): void {
		this.dirty = false;
		const data = this.data;
		const settings = this.settings;
		if (!data || !settings) return;
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		const dpr = window.devicePixelRatio || 1;
		const ctx = this.ctx;

		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, w, h);

		this.frameCount++;
		// Regions: rebuild on stale geometry at rest; during the live sim,
		// every REGION_EVERY-th frame (others blit the last bitmap).
		if (
			this.regionBuiltVersion !== this.geoVersion &&
			(!this.simActive || this.frameCount % REGION_EVERY === 0)
		) {
			this.buildRegions();
			this.regionBuiltVersion = this.geoVersion;
		}
		if (this.builtVersion !== this.geoVersion) this.buildGeometry();
		if (!this.nodesPath) return;

		const { x: tx, y: ty, k } = this.transform;
		// THE camera: one transform, then everything is world coordinates.
		ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);

		const ratio = zoomRatioOf(this.kFit, k);
		const nodeAlpha = labelAlpha(ratio, settings.labelZoom);
		const regionAlpha = 1 - nodeAlpha;
		const { nodeR, glowOuter } = this.world;

		// 1. Cluster regions: one tiny world-space bitmap blit. The upscale
		//    blur is the region softness; adjacent cluster tints blend
		//    source-over where they overlap (decided: multiply is invisible
		//    on the dark background).
		if (this.regionCanvas && this.regionRect) {
			const { minX, minY, w, h } = this.regionRect;
			ctx.imageSmoothingEnabled = true;
			ctx.drawImage(this.regionCanvas, minX, minY, w, h);
		}

		// 2. Group frames (bubble view): a faint disc and a label above it.
		if (data.frames && data.frames.length > 0) {
			ctx.save();
			ctx.textAlign = "center";
			ctx.textBaseline = "bottom";
			ctx.font = `600 ${FRAME_LABEL_PX / k}px ${data.fontFamily}`;
			for (const f of data.frames) {
				const hue = clusterHue(f.id);
				ctx.beginPath();
				ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
				ctx.fillStyle = `hsla(${hue}, 55%, 70%, 0.07)`;
				ctx.fill();
				ctx.lineWidth = 1 / k;
				ctx.strokeStyle = `hsla(${hue}, 55%, 70%, 0.3)`;
				ctx.stroke();
				ctx.fillStyle = `hsla(${hue}, 55%, 78%, 0.9)`;
				ctx.fillText(f.label, f.x, f.y - f.r - 3 / k);
			}
			ctx.restore();
		}

		// 3. Edges: shafts + arrowheads from cached paths; width constant on
		// screen (÷ k), geometry in world units (scales with the graph).
		// Supports shafts: a second, thinner stroke (owner, 2026-09-29) —
		// heads share the one fill at full geometry (shaft-only ruling).
		// A true 0-width stroke is undefined on canvas: the ratio's 0 end
		// floors to a hairline (0.5px on screen — hiding is the toggle's).
		if (settings.edgeWidth > 0) {
			ctx.strokeStyle = data.colors.edge;
			ctx.fillStyle = data.colors.edge;
			ctx.lineCap = "round";
			// Focus mode: the faded edges go first, under the full-strength ones.
			if (this.focus) {
				ctx.globalAlpha = DIM_ALPHA;
				ctx.lineWidth = settings.edgeWidth / k;
				ctx.stroke(this.dimShaftsPath);
				ctx.lineWidth = (settings.edgeWidth * HEAVY_EDGE) / k;
				ctx.stroke(this.dimHeavyShaftsPath);
				ctx.fill(this.dimHeadsPath);
				ctx.globalAlpha = 1;
			}
			ctx.lineWidth = settings.edgeWidth / k;
			ctx.stroke(this.shaftsPath);
			// Aggregated edges (several merged into one) stroke heavier.
			ctx.lineWidth = (settings.edgeWidth * HEAVY_EDGE) / k;
			ctx.stroke(this.heavyShaftsPath);
			ctx.fill(this.headsPath);
		}

		// 4. Nodes: one cached Path2D, one fill (faded ones first in focus mode).
		ctx.fillStyle = data.colors.node;
		if (this.focus) {
			ctx.globalAlpha = DIM_ALPHA;
			ctx.fill(this.dimNodesPath);
			ctx.globalAlpha = 1;
		}
		ctx.fill(this.nodesPath);

		// 5. Topic markers (bubble view): bubbles and open-topic headers.
		this.drawTopics(ctx, k, data);

		// 6. Node labels — one global gate, faded together. World-scaled
		// with the graph (they grow as you zoom in, Obsidian-style).
		if (nodeAlpha > 0.01) {
			ctx.save();
			ctx.globalAlpha = nodeAlpha;
			ctx.font = this.worldLabelFont;
			for (const [id, lines] of this.labelLines) {
				const n = this.nodeById.get(id);
				if (!n || !this.inFocus(id)) continue;
				const at = this.factLabelAt ? this.factLabelAt.get(id) : 0;
				if (at === undefined) continue; // no clear spot: shows on hover
				drawNameLines(ctx, n.x, n.y, lines, this.world, data.colors.label, at === 1);
			}
			ctx.restore();
		}

		// 7. Hover glow (topmost): halo in the node's color + the brightened
		// name, both on the SAME fade factor. World units like everything
		// else. Shows even when labels are zoomed out (hover is its own
		// affordance, not a label).
		if (this.hoverNode && this.hoverFade > 0.02) {
			const n = (this.visible && !this.visible.has(this.hoverNode.id)) || this.hoverNode.kind === "topic"
				? null // filtered out by search — no glow on hidden nodes; topics have their own look
				: this.hoverNode;
			if (n) {
				const glow = ctx.createRadialGradient(n.x, n.y, nodeR, n.x, n.y, glowOuter);
				glow.addColorStop(0, rgbaFromHex(data.colors.node, GLOW_ALPHA * this.hoverFade));
				glow.addColorStop(1, rgbaFromHex(data.colors.node, 0));
				ctx.fillStyle = glow;
				ctx.beginPath();
				ctx.arc(n.x, n.y, glowOuter, 0, Math.PI * 2);
				ctx.arc(n.x, n.y, nodeR, 0, Math.PI * 2, true);
				ctx.fill("evenodd");
				ctx.save();
				ctx.globalAlpha = this.hoverFade;
				ctx.font = this.worldLabelFont;
				drawNameLines(ctx, n.x, n.y, this.labelLines.get(n.id) ?? [], this.world, data.colors.hoverText, this.factLabelAt?.get(n.id) === 1);
				ctx.restore();
			}
			// A topic whose name was hidden for room shows it while hovered,
			// on a backing so it reads over its neighbours.
			const t = this.hoverNode.kind === "topic" && !this.hoverNode.open ? this.hoverNode : null;
			const mark = t && !this.topicLabelsAt(k, data).has(t.id) ? this.topicMarks.find((m) => m.node === t) : undefined;
			if (t && mark && (!this.visible || this.visible.has(t.id))) {
				ctx.save();
				ctx.globalAlpha = this.hoverFade;
				const r = t.radius ?? 8;
				const lineH = TOPIC_LINE_H / k;
				const top = t.y + r + TOPIC_LABEL_GAP / k;
				if (data.colors.background) {
					const padX = 4 / k;
					ctx.beginPath();
					ctx.roundRect(t.x - mark.labelW / (2 * k) - padX, top - 2 / k, mark.labelW / k + 2 * padX, mark.lines.length * lineH + 4 / k, 4 / k);
					ctx.fillStyle = rgbaFromHex(data.colors.background, 0.85);
					ctx.fill();
				}
				ctx.fillStyle = data.colors.hoverText;
				ctx.font = `600 ${TOPIC_LABEL_PX / k}px ${data.fontFamily}`;
				ctx.textAlign = "center";
				ctx.textBaseline = "top";
				mark.lines.forEach((line, i) => ctx.fillText(line, t.x, top + i * lineH));
				ctx.restore();
			}
		}

		// 8. Cluster region labels — THE TOPMOST layer (user 2026-09-16:
		// node labels and hover names drew over them before; region labels
		// must never be occluded by content). Inverse-gated on THE zoom
		// control (visible zoomed-out, fading as node labels come in).
		// Viewer-relative by design (UI, not graph content): drawn at the
		// world centroid with a font of clusterLabelSize / k — a constant
		// size on screen at any zoom (user-tunable since 2026-09-16).
		// Wave 7: labels are session names / file paths — pre-wrapped at
		// the geometry build (cap + ellipsis), drawn centered on the
		// centroid line by line.
		if (settings.clusterLabels && regionAlpha > 0.01) {
			ctx.save();
			ctx.globalAlpha = regionAlpha;
			ctx.font = `${LABEL_WEIGHT} ${settings.clusterLabelSize / k}px ${data.fontFamily}`;
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			// Screen px ÷ k = world units — the lines stay evenly spaced
			// at a constant on-screen pitch at any zoom.
			const lineH = (settings.clusterLabelSize * REGION_LABEL_LINE_HEIGHT) / k;
			for (const rm of this.regionMeta) {
				if (!rm.lines) continue;
				ctx.fillStyle = `hsla(${rm.hue}, 55%, 78%, 0.85)`;
				const firstOffset = (-(rm.lines.length - 1) / 2) * lineH;
				for (let i = 0; i < rm.lines.length; i++) {
					ctx.fillText(rm.lines[i]!, rm.cx, rm.cy + firstOffset + i * lineH);
				}
			}
			ctx.restore();
		}
	}
}
