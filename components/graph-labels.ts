/**
 * Collision-aware label placement for the topic-bubble view.
 *
 * Inside a big system frame (GI has dozens of topics) every bubble drew its
 * name below itself and the names piled on top of each other (QA
 * 2026-11-12). Placement is greedy by priority: each label tries its spots
 * in order (below its disc, then above, then the sides) and takes the first
 * that is clear of the labels already placed, the fixed text (system names,
 * open-topic headers), and the obstacles the caller marks (other bubbles'
 * counts, other facts' discs). A label with no clear spot is not drawn;
 * hovering its bubble shows it, and zooming in (topic names keep their
 * on-screen size while the bubbles spread apart) frees room for more.
 * Pure geometry; the renderer supplies the boxes in one consistent space.
 */

/** An axis-aligned box: top-left corner + size. */
export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** A disc labels must keep clear of — except the one it belongs to. */
export interface LabelObstacle {
	x: number;
	y: number;
	r: number;
	owner?: string;
}

export interface LabelCandidate {
	id: string;
	/** Higher places first. Ties go by id, so the result is stable. */
	priority: number;
	/** Where the label may go, most preferred first. */
	spots: readonly Rect[];
}

export function rectsOverlap(a: Rect, b: Rect, pad = 0): boolean {
	return a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
}

/** Does the disc reach into the box? (Touching edges do not count.) */
export function discHitsRect(c: { x: number; y: number; r: number }, rect: Rect): boolean {
	const nx = Math.min(Math.max(c.x, rect.x), rect.x + rect.w);
	const ny = Math.min(Math.max(c.y, rect.y), rect.y + rect.h);
	const dx = c.x - nx;
	const dy = c.y - ny;
	return dx * dx + dy * dy < c.r * c.r;
}

/**
 * Place the labels: id → index of the spot it took. Ids missing from the
 * result have no clear spot and stay hidden. `fixed` boxes are text that is
 * always drawn (they block, never move); `pad` is the clear gap kept between
 * two labels.
 */
export function placeLabels(
	candidates: readonly LabelCandidate[],
	options: { obstacles?: readonly LabelObstacle[]; fixed?: readonly Rect[]; pad?: number } = {},
): Map<string, number> {
	const pad = options.pad ?? 0;
	const obstacles = options.obstacles ?? [];
	const placed: Rect[] = [...(options.fixed ?? [])];
	const order = [...candidates].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const out = new Map<string, number>();
	for (const c of order) {
		for (let i = 0; i < c.spots.length; i++) {
			const spot = c.spots[i]!;
			if (placed.some((p) => rectsOverlap(p, spot, pad))) continue;
			if (obstacles.some((o) => o.owner !== c.id && discHitsRect(o, spot))) continue;
			placed.push(spot);
			out.set(c.id, i);
			break;
		}
	}
	return out;
}
