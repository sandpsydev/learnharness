/**
 * FIGURE LINKS (medical fork): the pure rules that turn a mention of a figure in
 * the teacher's text ("*Schwartz* 2019, p.597, Fig. 17-21, panel C") into a link to
 * the figure card of the same chat that it names.
 *
 * Nothing here reads a prompt or the picture finder: it only reads what the cards
 * already carry (the credit title "<book> p.N", the finder's caption) and what the
 * teacher already wrote. A mention with no matching card stays plain text.
 *
 * Node-free (no React, no fs), so the UI, the markdown plugin and the tests share it.
 */
import type { FigureImage, FigureResult } from "./contracts/jobs.ts";

// ─── the cards of a chat ─────────────────────────────────────────────────────

/** A figure's number: "17-21" and "17.21" are one number; the trailing panel letter is kept apart. */
export interface FigureNumber {
	/** Digits joined with ".", e.g. "35.7". */
	base: string;
	/** Panel letter written onto the number ("35.7B" → "B"), upper case, or "". */
	letter: string;
}

/** What the matcher knows about one shown figure card. */
export interface FigureCardRef {
	/** The card's own id: its delivery message's id. Not the picture's file — two cards of one page can share one cached file. */
	id: string;
	/** The cached picture's file name (a card's picture, several cards may share it). */
	file: string;
	image: FigureImage;
	result: FigureResult;
	/** Lower-case words of the book's title that can name it ("schwartz", "principles"…), generic words left out. */
	bookWords: ReadonlySet<string>;
	/** The library page (or slide number) the card's credit title names, or null for a picture from outside. */
	page: number | null;
	/** The figure number the finder's caption names, or null. */
	number: FigureNumber | null;
	/** The panel the card is about: the number's letter, else "panel X" in the caption, or "". */
	panel: string;
}

/** Words that appear in many book titles and so never identify one. */
const GENERIC_WORDS = new Set([
	"the", "and", "for", "with", "from", "textbook", "principles", "principle", "practice", "surgery", "surgical",
	"medicine", "medical", "pathology", "pathologic", "basic", "basis", "biological", "modern", "edition", "handbook",
	"atlas", "essentials", "clinical", "library", "lecture", "lectures", "notes", "slide", "slides", "book", "com",
	"www", "elsevier", "wolters", "kluwer", "mcgraw", "hill", "press", "volume",
]);

/** Lower-case words (3+ letters) of a title or a spoken book name, generic ones removed. */
export function bookWordsOf(text: string): Set<string> {
	const out = new Set<string>();
	for (const w of text.toLowerCase().split(/[^a-z]+/)) if (w.length >= 3 && !GENERIC_WORDS.has(w)) out.add(w);
	return out;
}

/** "<book> p.857" / "<lecture>, slide 12" (core/library.ts citationFor) → book and page. Other titles → null. */
export function parseCreditTitle(title: string): { book: string; page: number } | null {
	const slide = /^(.*?),\s*slide\s+(\d{1,5})$/i.exec(title.trim());
	if (slide) return { book: slide[1]!, page: Number(slide[2]) };
	const book = /^(.*?)\s+p\.\s*(\d{1,5})$/i.exec(title.trim());
	if (book) return { book: book[1]!, page: Number(book[2]) };
	return null;
}

const DASHES = /[‐-―−-]/g;
/** One figure number: digits joined by . or a dash, then an optional panel letter ("35.7B", "17-21", "17-15b"). */
const NUMBER = String.raw`\d{1,3}(?:[.‐-―−-]\d{1,3})*(?:[A-Za-z](?![A-Za-z]))?`;

/** Read "35.7B" / "17-21" into a FigureNumber. */
export function parseFigureNumber(raw: string): FigureNumber | null {
	const m = /^(\d{1,3}(?:[.‐-―−-]\d{1,3})*)([A-Za-z]?)$/.exec(raw.trim());
	if (!m) return null;
	return { base: m[1]!.replace(DASHES, "."), letter: m[2]!.toUpperCase() };
}

const FIG_IN_TEXT = new RegExp(String.raw`\bFig(?:ure)?s?\.?\s*(${NUMBER})`, "i");
const PANEL_IN_TEXT = /\bpanel\s+([A-H])(?![A-Za-z])/i;

/** Build the matcher's view of a delivered figure (null when it is not a shown picture). */
export function cardRefOf(result: FigureResult | undefined, id: string): FigureCardRef | null {
	const image = result?.image;
	if (!result || result.outcome !== "image" || !image || typeof image.file !== "string" || image.file === "") return null;
	const credit = parseCreditTitle(image.title ?? "");
	const caption = `${result.caption ?? ""}\n${result.keyFeature ?? ""}`;
	const fig = FIG_IN_TEXT.exec(caption);
	const number = fig ? parseFigureNumber(fig[1]!) : null;
	const panelText = PANEL_IN_TEXT.exec(caption)?.[1]?.toUpperCase() ?? "";
	return {
		id,
		file: image.file,
		image,
		result,
		bookWords: credit ? bookWordsOf(credit.book) : new Set(),
		page: credit ? credit.page : null,
		number,
		panel: number?.letter || panelText,
	};
}

/** A transcript message as far as this module reads it (the view's LhViewMessage fits). */
interface MessageLike {
	id?: string;
	parts: ReadonlyArray<{ type: string; data?: unknown }>;
}

/** The id a delivery message's card goes by: the message id, or its place in the chat for an old record with no id. */
export const figureCardId = (message: { id?: string }, index: number): string => message.id || `m-${index}`;

/** The figure cards shown in a chat, in chat order. */
export function figureCardsOf(messages: ReadonlyArray<MessageLike>): FigureCardRef[] {
	const out: FigureCardRef[] = [];
	messages.forEach((message, index) => {
		for (const part of message.parts) {
			if (part.type !== "data-subagent-artifact") continue;
			const data = part.data as { kind?: string; result?: FigureResult } | undefined;
			if (data?.kind !== "figure") continue;
			const card = cardRefOf(data.result, figureCardId(message, index));
			if (card) out.push(card);
		}
	});
	return out;
}

/** A key that changes only when the set of shown pictures does (keeps memoized text from re-parsing every token). */
export const figureCardsKey = (cards: ReadonlyArray<FigureCardRef>): string => cards.map((c) => c.id).join("|");

// ─── reading a mention ───────────────────────────────────────────────────────

/** One mention found in a run of text: where it is and what it names. */
export interface CitationCluster {
	start: number;
	end: number;
	pages: number[];
	figures: FigureNumber[];
	panels: string[];
}

/** page marker | figure marker | panel marker, in any order. */
const ITEM = new RegExp(
	String.raw`\b(?:library\s+)?(?:pp?\.|pages?|slides?)\s*(\d{1,5})(?!\d)` + // 1: page or slide (the teacher often writes "library p.708")
		String.raw`|\bFig(?:ure)?s?\.?\s*(${NUMBER})` + // 2: figure number
		String.raw`|\bpanels?\s+([A-Ha-h])(?![A-Za-z])`, // 3: panel
	"gi",
);

/** Only separators between two markers of one mention ("p.597, Fig. 17-21 and panel C"). */
const JOINER = /^[\s,;:·()–—-]*(?:and\s+|&\s*)?$/i;

/** Every page/figure/panel mention in the text, neighbouring markers joined into one mention. */
export function findCitationClusters(text: string): CitationCluster[] {
	const clusters: CitationCluster[] = [];
	let current: CitationCluster | null = null;
	for (const m of text.matchAll(ITEM)) {
		const start = m.index!;
		const end = start + m[0].length;
		if (current && JOINER.test(text.slice(current.end, start))) {
			current.end = end;
		} else {
			current = { start, end, pages: [], figures: [], panels: [] };
			clusters.push(current);
		}
		if (m[1]) current.pages.push(Number(m[1]));
		else if (m[2]) {
			const n = parseFigureNumber(m[2]);
			if (n) current.figures.push(n);
		} else if (m[3]) current.panels.push(m[3].toUpperCase());
	}
	return clusters;
}

// ─── matching ────────────────────────────────────────────────────────────────

/** Words (4+ letters, apostrophes split) of the text just before a mention: the possible book names. */
function wordsBefore(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z]+/)
		.filter((w) => w.length >= 4 && !GENERIC_WORDS.has(w));
}

/**
 * The cards a mention names (empty = plain text).
 *
 * With a page ("Sabiston p.857"): the book must be named just before it and a card of that
 * book and page must be in the chat. Without one, a bare chapter-style figure number
 * ("Fig. 35.7B") links only when a card carries that number.
 *
 * A figure number or panel in the mention must agree with the card's, wherever the card
 * states it. The cards that agree best win; when nothing tells the cards of the page
 * apart, all of them are returned.
 */
export function matchCluster(cluster: CitationCluster, before: string, cards: ReadonlyArray<FigureCardRef>): FigureCardRef[] {
	const words = wordsBefore(before);
	const named = (card: FigureCardRef) => words.some((w) => card.bookWords.has(w));
	const wantFigure = cluster.figures[0];
	const wantPanel = cluster.panels[0] || wantFigure?.letter || "";

	let pool: FigureCardRef[];
	if (cluster.pages.length > 0) {
		pool = cards.filter((c) => c.page !== null && cluster.pages.includes(c.page) && named(c));
	} else if (wantFigure && wantFigure.base.includes(".")) {
		const withNumber = cards.filter((c) => c.number?.base === wantFigure.base);
		const byBook = withNumber.filter(named);
		// A number no book is named for links only when every card carrying it is from one book page.
		const sources = new Set(withNumber.map((c) => `${[...c.bookWords].join(",")}|${c.page}`));
		pool = byBook.length > 0 ? byBook : sources.size === 1 ? withNumber : [];
	} else {
		return [];
	}

	let best = -1;
	const scored: Array<{ card: FigureCardRef; score: number }> = [];
	for (const card of pool) {
		let score = 0;
		if (wantFigure && card.number) {
			if (card.number.base !== wantFigure.base) continue;
			score += 1;
		}
		if (wantPanel && card.panel) {
			if (card.panel !== wantPanel) continue;
			score += 2;
		}
		scored.push({ card, score });
		best = Math.max(best, score);
	}
	return scored.filter((s) => s.score === best).map((s) => s.card);
}

/** The card's own title as a mention (a picture from outside is named by its title), text range. */
export function findTitleMentions(text: string, cards: ReadonlyArray<FigureCardRef>): Array<{ start: number; end: number; cards: FigureCardRef[] }> {
	const out: Array<{ start: number; end: number; cards: FigureCardRef[] }> = [];
	const lower = text.toLowerCase();
	for (const card of cards) {
		if (card.page !== null) continue;
		const title = (card.image.title ?? "").replace(/\.(?:jpe?g|png|gif|webp|svg)$/i, "").trim().toLowerCase();
		if (title.length < 10) continue;
		for (let at = lower.indexOf(title); at !== -1; at = lower.indexOf(title, at + title.length)) {
			out.push({ start: at, end: at + title.length, cards: [card] });
		}
	}
	return out;
}

/** One link to make: the span of text and the pictures it opens. */
export interface FigureMention {
	start: number;
	end: number;
	cards: FigureCardRef[];
}

/**
 * Every figure mention in a run of text that names a card of this chat.
 * `lead` is the plain text just before the run (an emphasised book name that sits in its own element).
 */
export function findFigureMentions(text: string, cards: ReadonlyArray<FigureCardRef>, lead = ""): FigureMention[] {
	if (cards.length === 0) return [];
	const out: FigureMention[] = [];
	for (const cluster of findCitationClusters(text)) {
		const matched = matchCluster(cluster, `${lead}${text.slice(0, cluster.start)}`.slice(-60), cards);
		if (matched.length > 0) out.push({ start: cluster.start, end: cluster.end, cards: matched });
	}
	for (const t of findTitleMentions(text, cards)) {
		if (!out.some((o) => t.start < o.end && o.start < t.end)) out.push(t);
	}
	return out.sort((a, b) => a.start - b.start);
}

// ─── the markdown plugin ─────────────────────────────────────────────────────

/** The minimal mdast shape the plugin walks (no unified types needed). */
interface MdNode {
	type: string;
	value?: string;
	children?: MdNode[];
	data?: Record<string, unknown>;
}

/** Nodes whose text is never a mention: code, math, existing links. */
const SKIP = new Set(["code", "inlineCode", "math", "inlineMath", "link", "linkReference", "definition", "html"]);
/** The tag the matched run is rendered as (a custom element the chat maps to the link). */
export const FIGURE_REF_TAG = "lh-figref";

const plainText = (node: MdNode): string | null =>
	node.type === "text" ? (node.value ?? "") : node.children && node.children.every((c) => c.type === "text") ? node.children.map((c) => c.value ?? "").join("") : null;

/** Between an emphasised book name and the page marker: nothing but a year or an edition. */
const NAME_GAP = /^[\s,]*(?:(?:19|20)\d\d[a-z]?|\d{1,2}(?:st|nd|rd|th)\s+ed(?:ition|n)?\.?)?[\s,]*$/i;

const refNode = (children: MdNode[], cards: FigureCardRef[]): MdNode => ({
	type: "emphasis",
	children,
	data: { hName: FIGURE_REF_TAG, hProperties: { dataIds: cards.map((c) => c.id).join(",") } },
});

function walk(node: MdNode, cards: ReadonlyArray<FigureCardRef>): void {
	if (!node.children || SKIP.has(node.type)) return;
	const next: MdNode[] = [];
	for (const child of node.children) {
		if (child.type !== "text" || typeof child.value !== "string") {
			walk(child, cards);
			next.push(child);
			continue;
		}
		const prev = next.at(-1);
		const leadText = prev && (prev.type === "emphasis" || prev.type === "strong") ? plainText(prev) : null;
		const mentions = findFigureMentions(child.value, cards, leadText ?? "");
		if (mentions.length === 0) {
			next.push(child);
			continue;
		}
		let at = 0;
		mentions.forEach((m, i) => {
			let before = child.value!.slice(at, m.start);
			const bookName =
				i === 0 && prev && leadText !== null && prev.data?.hName !== FIGURE_REF_TAG && NAME_GAP.test(before) && wordsBefore(leadText).some((w) => m.cards.some((c) => c.bookWords.has(w)))
					? prev
					: null;
			const inner: MdNode[] = [];
			if (bookName) {
				next.pop();
				inner.push(bookName, { type: "text", value: before });
				before = "";
			}
			if (before) next.push({ type: "text", value: before });
			inner.push({ type: "text", value: child.value!.slice(m.start, m.end) });
			next.push(refNode(inner, m.cards));
			at = m.end;
		});
		const rest = child.value.slice(at);
		if (rest) next.push({ type: "text", value: rest });
	}
	node.children = next;
}

/** The remark plugin: wraps every figure mention that names a card of this chat in a figure-link element. */
export function remarkFigureRefs(options: { cards: ReadonlyArray<FigureCardRef>; toJSON?: () => string }) {
	return (tree: MdNode) => {
		if (options.cards.length > 0) walk(tree, options.cards);
	};
}
