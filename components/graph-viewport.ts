/**
 * The part of the graph canvas the learner can actually see.
 *
 * The canvas is full-bleed: the toolbar row, the Outline panel, and the
 * home dock (Tonight's questions + the composer) float over it. Framing the
 * graph or a topic in the whole canvas put things under those panels (QA
 * 2026-11-12: the focused topic sat behind Tonight's questions; the top
 * system label sat under the toolbar). Each panel marks itself with
 * `data-graph-occluder`; the view measures them and the camera frames into
 * what is left. Pure maths here; the DOM read lives in graph-view.tsx.
 */

/** Space taken from each edge of the canvas, in CSS px. */
export interface Insets {
	top: number;
	right: number;
	bottom: number;
	left: number;
}

export const NO_INSETS: Insets = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });

/** A DOMRect-like box in one shared coordinate space (client px). */
export interface Box {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/** The attribute a floating panel carries to count as covering the graph. */
export const OCCLUDER_ATTR = "data-graph-occluder";

/** The visible part never shrinks below this share of each canvas side: past
 *  that, the insets give way proportionally (a graph half behind a panel
 *  beats a postage stamp). */
export const MIN_VISIBLE_SHARE = 0.4;

/**
 * The insets that keep the graph clear of the overlays. Each overlay is
 * pushed out through the canvas edge where that costs the least area — a
 * wide bottom dock takes from the bottom, a tall left panel from the left —
 * and each side keeps its largest claim. Overlays outside the canvas (or of
 * zero size, i.e. not rendered) take nothing.
 */
export function occlusionInsets(
	view: Box,
	overlays: readonly Box[],
	minShare = MIN_VISIBLE_SHARE,
): Insets {
	const w = view.right - view.left;
	const h = view.bottom - view.top;
	if (!(w > 0) || !(h > 0)) return { ...NO_INSETS };
	const out = { ...NO_INSETS };
	for (const o of overlays) {
		const left = Math.max(o.left, view.left);
		const right = Math.min(o.right, view.right);
		const top = Math.max(o.top, view.top);
		const bottom = Math.min(o.bottom, view.bottom);
		if (!(right > left) || !(bottom > top)) continue;
		// Candidate claims, with the area each one gives up. Ties keep the
		// first listed (top, bottom, then left, right).
		const claims: [keyof Insets, number, number][] = [
			["top", bottom - view.top, (bottom - view.top) * w],
			["bottom", view.bottom - top, (view.bottom - top) * w],
			["left", right - view.left, (right - view.left) * h],
			["right", view.right - left, (view.right - left) * h],
		];
		let best = claims[0]!;
		for (const c of claims) if (c[2] < best[2]) best = c;
		out[best[0]] = Math.max(out[best[0]], best[1]);
	}
	const squeeze = (a: keyof Insets, b: keyof Insets, size: number) => {
		const maxTaken = size * (1 - minShare);
		const taken = out[a] + out[b];
		if (taken <= maxTaken) return;
		const f = maxTaken / taken;
		out[a] *= f;
		out[b] *= f;
	};
	squeeze("left", "right", w);
	squeeze("top", "bottom", h);
	return out;
}

/** Same insets? (to the half pixel — layout jitter is not a change). */
export function sameInsets(a: Insets, b: Insets): boolean {
	return (
		Math.abs(a.top - b.top) < 0.5 &&
		Math.abs(a.right - b.right) < 0.5 &&
		Math.abs(a.bottom - b.bottom) < 0.5 &&
		Math.abs(a.left - b.left) < 0.5
	);
}

/** The camera that puts world point (cx, cy) at the centre of the visible
 *  part of a w×h canvas, at zoom k. */
export function centreTransform(
	cx: number,
	cy: number,
	k: number,
	w: number,
	h: number,
	insets: Insets = NO_INSETS,
): { x: number; y: number; k: number } {
	const vx = insets.left + (w - insets.left - insets.right) / 2;
	const vy = insets.top + (h - insets.top - insets.bottom) / 2;
	return { x: vx - cx * k, y: vy - cy * k, k };
}

/** The camera that frames `bbox` inside the visible part of a w×h canvas,
 *  with `padding` px kept clear around it. */
export function fitTransform(
	bbox: { minX: number; maxX: number; minY: number; maxY: number },
	w: number,
	h: number,
	padding: number,
	insets: Insets = NO_INSETS,
): { x: number; y: number; k: number } {
	const bw = Math.max(bbox.maxX - bbox.minX, 1e-6);
	const bh = Math.max(bbox.maxY - bbox.minY, 1e-6);
	const vw = Math.max(w - insets.left - insets.right, 1);
	const vh = Math.max(h - insets.top - insets.bottom, 1);
	// A padding wider than the space it pads gives way (half the side stays usable).
	const k = Math.min(Math.max(vw - 2 * padding, vw / 2) / bw, Math.max(vh - 2 * padding, vh / 2) / bh);
	return centreTransform((bbox.minX + bbox.maxX) / 2, (bbox.minY + bbox.maxY) / 2, k, w, h, insets);
}
