/**
 * NO REPEATS (medical fork): the pure rule that says whether a picture the figure
 * finder is about to show is one the chat already shows.
 *
 * A picture is a repeat when it is the same cached file, or when it is the same
 * library page and the same figure on it. Two different figures of one page
 * (Sabiston p.849: the ductogram Fig. 35.4 and the terminal duct lobular unit
 * Fig. 35.5) are not repeats. Between two library cards of one page, in this
 * order: both name a figure number → same number or not; both carry the band of
 * the page they show → the bands overlap or not; otherwise nothing says they
 * differ, so it counts as a repeat (the learner is not sent the same page twice).
 *
 * Node-free (no fs), so the finder and the tests share it.
 */
import { figureNumberIn, type FigureCardRef, type FigureNumber } from "./figure-refs.ts";

/** What the finder is about to show. */
export interface FigureCandidateShape {
	/** The cached picture's file name: the same name is the same picture. */
	file: string;
	/** A page of the learner's library (a lecture slide or a textbook page), not an outside picture. */
	library: boolean;
	/** The credit title ("<book> p.N", "<lecture>, slide N"): the same title is the same library page. */
	title: string;
	/** The band of the page that will be shown; null = the whole page. */
	crop: { top: number; bottom: number } | null;
	/** The figure number the finder's own caption names, or null. */
	number: FigureNumber | null;
}

/** Two bands count as the same figure when they overlap by at least this share of the thinner one. */
const OVERLAP_SHARE = 0.5;

function bandsOverlap(a: { top: number; bottom: number }, b: { top: number; bottom: number }): boolean {
	const shared = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
	const thinner = Math.min(a.bottom - a.top, b.bottom - b.top);
	return thinner > 0 && shared / thinner >= OVERLAP_SHARE;
}

/** The figure number a caption (and key feature) names. */
export function figureNumberOfCaption(shows: string, keyFeature = ""): FigureNumber | null {
	return figureNumberIn(`${shows}\n${keyFeature}`);
}

/** Is this picture the one an earlier card of the chat already shows? */
export function isRepeat(card: FigureCardRef, candidate: FigureCandidateShape): boolean {
	if (card.file === candidate.file) return true;
	if (!candidate.library || card.image.tier !== "slides") return false;
	if (card.image.title !== candidate.title) return false;
	if (card.number && candidate.number) return card.number.base === candidate.number.base;
	const shown = card.image.crop;
	if (shown && candidate.crop) return bandsOverlap(shown, candidate.crop);
	return true;
}

/** The earlier card (if any) that this picture repeats. */
export function findRepeat(cards: ReadonlyArray<FigureCardRef>, candidate: FigureCandidateShape): FigureCardRef | null {
	return cards.find((card) => isRepeat(card, candidate)) ?? null;
}

/** A card, said in a few words for the finder and the lesson: "<title> — <caption>". */
export function describeShownCard(card: FigureCardRef): string {
	const caption = card.result.caption.replace(/\s+/g, " ").trim();
	return caption ? `${card.image.title} — ${caption}` : card.image.title;
}
