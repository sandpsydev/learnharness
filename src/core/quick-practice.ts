/**
 * Quick practice (Pocket mode, Phase 8): a short tap-to-answer round built
 * from the learner's own graph, optionally narrowed to organ systems (e.g.
 * the current rotation). Pure helpers so the phone screen and the tests share
 * them. The round itself is an ordinary practice session: the questions come
 * as the Phase 3 clickable A–E vignettes.
 */

import { ORGAN_SYSTEMS, organSystemLabel, type GraphNodeTags, type OrganSystem } from "./contracts/graph.ts";

/** Questions in one quick round. */
export const QUICK_ROUND_QUESTIONS = 5;
/** Most notes handed to the practice agent as the round's material. */
export const QUICK_ROUND_NOTES = 12;

/** How many nodes carry each organ system, in the spec's order. Systems no
 *  node carries are kept with a count of 0 so the chips don't jump around. */
export function systemCounts(nodes: readonly GraphNodeTags[]): Array<{ id: OrganSystem; label: string; count: number }> {
	return ORGAN_SYSTEMS.map(({ id, label }) => ({
		id,
		label,
		count: nodes.filter((n) => n.systems?.includes(id)).length,
	}));
}

/** The nodes a round may draw on: any chosen system matches (chips OR, like
 *  the graph view's filter); no chosen system means the whole graph. */
export function nodesForSystems<T extends GraphNodeTags>(nodes: readonly T[], systems: ReadonlySet<OrganSystem>): T[] {
	if (systems.size === 0) return [...nodes];
	return nodes.filter((n) => (n.systems ?? []).some((s) => systems.has(s)));
}

/** A random sample of at most `limit` nodes (Fisher–Yates; `random` is
 *  injectable so tests are deterministic). */
export function sampleNodes<T>(nodes: readonly T[], limit = QUICK_ROUND_NOTES, random: () => number = Math.random): T[] {
	const pool = [...nodes];
	for (let i = pool.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[pool[i], pool[j]] = [pool[j]!, pool[i]!];
	}
	return pool.slice(0, Math.max(0, limit));
}

/** The session title: short, and says which systems. */
export function quickPracticeTitle(systems: ReadonlySet<OrganSystem>): string {
	const names = ORGAN_SYSTEMS.filter((s) => systems.has(s.id)).map((s) => organSystemLabel(s.id));
	return names.length === 0 ? "Quick practice" : `Quick practice · ${names.join(", ")}`;
}

/** The learner's first message in the round: asks for a short phone-sized
 *  round of single-best-answer questions, one at a time. */
export function quickPracticeOpening(systems: ReadonlySet<OrganSystem>, questions = QUICK_ROUND_QUESTIONS): string {
	const names = ORGAN_SYSTEMS.filter((s) => systems.has(s.id)).map((s) => organSystemLabel(s.id));
	const scope = names.length === 0 ? "" : ` Stay within ${names.join(" and ")}.`;
	return (
		`Quick practice: give me a short round of ${questions} single-best-answer questions, one at a time, ` +
		`each a short clinical vignette with options A to E, drawn from the notes I picked.${scope} ` +
		`I'm on my phone, so keep each stem brief.`
	);
}
