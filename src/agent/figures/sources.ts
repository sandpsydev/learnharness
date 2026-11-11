/**
 * THE FIGURE SOURCES (medical fork): how each allowed site is searched and read.
 * The parsers are pure (text in, candidates out) so they test against local
 * fixtures; the small `search…` wrappers add the network call through the
 * guarded fetcher (fetch.ts).
 *
 *  - Wikimedia Commons: the official API. Each file's own licence, author and
 *    description come back with it, so Commons is the surest place to embed.
 *  - Europe PMC: open-access articles (the licence is in the search record) and
 *    the figures in their full text.
 *  - Specialty atlases and Radiopaedia: a page is read for its images and for a
 *    Creative Commons notice. No notice found = link only.
 *  - Journals (NEJM and peers): never fetched, only linked.
 */

import { parseHTML } from "linkedom";
import {
	figureCreditLine,
	figureImageAllowed,
	figureSourceById,
	figureSourceForPage,
	httpsUrl,
	readFigureLicence,
	type FigureLicence,
	type FigureSource,
	type FigureTier,
} from "../../core/figures.ts";
import { fetchFigureText, type FetchFailure } from "./fetch.ts";

/** What a search or a page read produced, before it is given an id. */
export interface FigureCandidateDraft {
	kind: "slide" | "image" | "page";
	sourceId: string;
	tier: FigureTier;
	sourceName: string;
	/** Title of the case, article or file; for a slide: "<lecture>, slide N". */
	title: string;
	pageUrl?: string;
	imageUrl?: string;
	licence?: FigureLicence | null;
	author?: string;
	/** What the source says the picture is (or a search snippet). */
	description?: string;
	/** Lecture slides: where to render it from. */
	slide?: { bookId: string; bookTitle: string; page: number };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Tags stripped, entities decoded, whitespace collapsed. */
export function plainText(html: string): string {
	return html
		.replace(/<[^>]*>/g, " ")
		.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
			if (body[0] === "#") {
				const code = body[1]!.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
				return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
			}
			return ENTITIES[body.toLowerCase()] ?? whole;
		})
		.replace(/\s+/g, " ")
		.trim();
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const COMMONS_PICTURE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/**
 * Files Commons stores in a format the lesson cannot show, but renders to a PNG/JPEG
 * thumbnail itself. Most anatomy and physiology diagrams on Commons are SVG; only the
 * rendered thumbnail is ever fetched (and checked to be a real picture by its bytes),
 * never the drawing's own markup.
 */
const COMMONS_THUMB_ONLY_MIMES = new Set(["image/svg+xml", "image/tiff"]);
/** How many files to ask Commons for; the best are kept after ranking. */
const COMMONS_FETCH = 20;
const COMMONS_KEEP = 8;

// ─── Wikimedia Commons ───────────────────────────────────────────────────────

export const COMMONS_API = "https://commons.wikimedia.org/w/api.php";

export function commonsSearchUrl(query: string): string {
	const url = new URL(COMMONS_API);
	const params: Record<string, string> = {
		action: "query",
		format: "json",
		generator: "search",
		gsrnamespace: "6",
		// Pictures and drawings only: without this, scanned books (PDF/DjVu) fill most results.
		gsrsearch: `${query} filetype:bitmap|drawing`,
		gsrlimit: String(COMMONS_FETCH),
		prop: "imageinfo",
		iiprop: "url|extmetadata|mime|size",
		iiurlwidth: "1000",
		origin: "*",
	};
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	return url.toString();
}

type Meta = Record<string, { value?: unknown } | undefined>;
const metaText = (meta: Meta | undefined, key: string): string => {
	const value = meta?.[key]?.value;
	return typeof value === "string" ? plainText(value) : "";
};

/** Language codes Commons uploaders put in the names of translated label variants ("Nephron pl.svg", "Brachial plexus color (vi).svg"). */
// Codes that are also common medical abbreviations at the end of a file name (AR, MR, MS, PA,
// LA, PS, TR, ET, SV, HR, CA…) are left out on purpose, so "Chest X-ray PA" is never demoted.
const LABEL_LANGUAGES =
	"ast|az|bg|bn|bs|cs|da|de|es|eu|fa|fi|fr|gl|he|hu|hy|ja|ka|kk|ko|ku|lt|lv|mk|nb|nl|nn|pl|pt|pt-br|ro|ru|sk|sl|sq|sr|th|uk|uz|vi|zh|zh-hans|zh-hant|zh-cn|zh-tw";
const LABEL_VARIANT = new RegExp(`(?:[\\s_.-]|\\()(?:${LABEL_LANGUAGES})\\)?$`, "i");
const LANGUAGE_WORD = /\b(?:arabic|chinese|french|german|italian|japanese|korean|persian|polish|portuguese|russian|spanish|thai|turkish|vietnamese)\b/i;

/** True when a Commons file name marks a translated (non-English) label variant. */
export function isForeignLabelVariant(title: string): boolean {
	const base = title.replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, "").trim();
	return LABEL_VARIANT.test(base) || LANGUAGE_WORD.test(base);
}

/**
 * The Commons API answer → candidates: picture files, and SVG/TIFF drawings through the PNG
 * thumbnail Commons renders for them (audio, video, PDF and DjVu are skipped). The lesson is in
 * English, so translated label variants of a drawing go after every other result.
 */
export function parseCommonsResults(json: unknown): FigureCandidateDraft[] {
	const pages = (json as { query?: { pages?: Record<string, unknown> } } | null)?.query?.pages;
	if (!pages || typeof pages !== "object") return [];
	const source = figureSourceById("commons")!;
	const found = Object.values(pages) as Array<{ title?: string; index?: number; imageinfo?: Array<Record<string, unknown>> }>;
	found.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
	const out: FigureCandidateDraft[] = [];
	for (const page of found) {
		const info = page.imageinfo?.[0];
		if (!info || typeof page.title !== "string") continue;
		const mime = typeof info.mime === "string" ? info.mime : "";
		const thumbOnly = COMMONS_THUMB_ONLY_MIMES.has(mime);
		if (!COMMONS_PICTURE_MIMES.has(mime) && !thumbOnly) continue;
		const meta = info.extmetadata as Meta | undefined;
		const licence = readFigureLicence(
			[metaText(meta, "LicenseShortName"), metaText(meta, "License"), (meta?.LicenseUrl?.value as string | undefined) ?? "", metaText(meta, "UsageTerms")].join(" "),
		);
		const thumb = typeof info.thumburl === "string" ? info.thumburl : "";
		// A drawing is only ever fetched as Commons' own rendered raster thumbnail.
		if (thumbOnly && !/\.(?:png|jpe?g)(?:\?|$)/i.test(thumb)) continue;
		const imageUrl = thumb || (typeof info.url === "string" ? info.url : "");
		if (!imageUrl || !figureImageAllowed(source, imageUrl)) continue;
		const description = metaText(meta, "ImageDescription") || metaText(meta, "ObjectName");
		out.push({
			kind: "image",
			sourceId: "commons",
			tier: "commons",
			sourceName: source.name,
			title: page.title.replace(/^File:/, ""),
			pageUrl: typeof info.descriptionurl === "string" ? info.descriptionurl : undefined,
			imageUrl,
			licence,
			author: metaText(meta, "Artist") || undefined,
			description: description ? clip(description, 300) : undefined,
		});
	}
	// Stable: Commons' own relevance order is kept within each group.
	const english = out.filter((c) => !isForeignLabelVariant(c.title));
	const translated = out.filter((c) => isForeignLabelVariant(c.title));
	return [...english, ...translated].slice(0, COMMONS_KEEP);
}

// ─── Europe PMC (open-access articles) ───────────────────────────────────────

export const EUROPE_PMC_REST = "https://www.ebi.ac.uk/europepmc/webservices/rest";

export function europePmcSearchUrl(query: string): string {
	const url = new URL(`${EUROPE_PMC_REST}/search`);
	url.searchParams.set("query", `${query} AND OPEN_ACCESS:y AND HAS_FT:y`);
	url.searchParams.set("format", "json");
	url.searchParams.set("resultType", "core");
	url.searchParams.set("pageSize", "8");
	return url.toString();
}

export const europePmcArticleUrl = (pmcid: string): string => `https://europepmc.org/article/PMC/${pmcid.replace(/^PMC/i, "")}`;

/** Open-access search results → article candidates (licence read from the record; none = link only). */
export function parseEuropePmcResults(json: unknown): FigureCandidateDraft[] {
	const results = (json as { resultList?: { result?: Array<Record<string, unknown>> } } | null)?.resultList?.result;
	if (!Array.isArray(results)) return [];
	const source = figureSourceById("europepmc")!;
	const out: FigureCandidateDraft[] = [];
	for (const r of results) {
		const pmcid = typeof r.pmcid === "string" && /^PMC\d+$/i.test(r.pmcid) ? r.pmcid.toUpperCase() : null;
		if (!pmcid || typeof r.title !== "string") continue;
		const journal = typeof r.journalTitle === "string" ? r.journalTitle : ((r.journalInfo as { journal?: { title?: string } } | undefined)?.journal?.title ?? "");
		const year = typeof r.pubYear === "string" ? r.pubYear : "";
		out.push({
			kind: "page",
			sourceId: "europepmc",
			tier: "open-journal",
			sourceName: source.name,
			title: plainText(r.title),
			pageUrl: europePmcArticleUrl(pmcid),
			licence: readFigureLicence(typeof r.license === "string" ? r.license : ""),
			author: typeof r.authorString === "string" ? clip(r.authorString, 80) : undefined,
			description: [journal, year, pmcid].filter(Boolean).join(" · "),
		});
	}
	return out;
}

/** The figures of one open-access article, from its full-text XML. */
export function parseEuropePmcFigures(xml: string, pmcid: string, articleTitle: string, licence: FigureLicence | null): FigureCandidateDraft[] {
	const source = figureSourceById("europepmc")!;
	const { document } = parseHTML(xml);
	const out: FigureCandidateDraft[] = [];
	for (const fig of Array.from(document.querySelectorAll("fig")).slice(0, 8)) {
		const graphic = fig.querySelector("graphic");
		const href = graphic?.getAttribute("xlink:href") ?? graphic?.getAttribute("href");
		if (!href || !/^[\w.-]+$/.test(href)) continue;
		const label = plainText(fig.querySelector("label")?.textContent ?? "");
		const caption = plainText(fig.querySelector("caption")?.textContent ?? "");
		out.push({
			kind: "image",
			sourceId: "europepmc",
			tier: "open-journal",
			sourceName: source.name,
			title: `${articleTitle}${label ? ` — ${label}` : ""}`,
			pageUrl: europePmcArticleUrl(pmcid),
			imageUrl: `https://europepmc.org/articles/${pmcid}/bin/${href}.jpg`,
			licence,
			description: caption ? clip(caption, 300) : undefined,
		});
	}
	return out;
}

// ─── an atlas or case page ───────────────────────────────────────────────────

export interface ReadPage {
	title: string;
	licence: FigureLicence | null;
	images: FigureCandidateDraft[];
}

const LICENCE_HINT = /licen[cs]e|copyright|rights|creative ?commons/i;

/** The licence a page states about itself: a rel=license link, a Creative Commons link, or a licence/copyright line. */
export function readPageLicence(document: Document): FigureLicence | null {
	const fromLinks = Array.from(document.querySelectorAll("a[href], link[href]"))
		.map((el) => ({ href: el.getAttribute("href") ?? "", rel: el.getAttribute("rel") ?? "" }))
		.filter((l) => /creativecommons\.org/i.test(l.href) || /\blicense\b/i.test(l.rel))
		.map((l) => l.href)
		.join(" ");
	const fromLinksLicence = readFigureLicence(fromLinks);
	if (fromLinksLicence) return fromLinksLicence;
	const meta = Array.from(document.querySelectorAll("meta"))
		.filter((m) => LICENCE_HINT.test(m.getAttribute("name") ?? m.getAttribute("property") ?? ""))
		.map((m) => m.getAttribute("content") ?? "")
		.join(" ");
	const fromMeta = readFigureLicence(meta);
	if (fromMeta) return fromMeta;
	const lines = Array.from(document.querySelectorAll("footer, [class*=licen], [id*=licen], [class*=copyright], [id*=copyright], [class*=rights]"))
		.map((el) => plainText(el.textContent ?? ""))
		.filter((t) => LICENCE_HINT.test(t))
		.map((t) => clip(t, 400))
		.join(" ");
	return readFigureLicence(lines);
}

/** An atlas or case page → its title, its stated licence, and the pictures worth looking at. */
export function parsePageImages(html: string, pageUrl: string, source: FigureSource): ReadPage {
	const { document } = parseHTML(html);
	const title = plainText(document.querySelector("meta[property='og:title']")?.getAttribute("content") ?? document.querySelector("title")?.textContent ?? pageUrl);
	const licence = readPageLicence(document as unknown as Document);
	const base = new URL(pageUrl);
	const seen = new Set<string>();
	const images: FigureCandidateDraft[] = [];
	const add = (raw: string | null | undefined, description: string) => {
		if (!raw || images.length >= 6) return;
		let abs: string;
		try {
			abs = new URL(raw, base).toString();
		} catch {
			return;
		}
		if (seen.has(abs) || !figureImageAllowed(source, abs)) return;
		if (/\.(svg|ico)(\?|$)/i.test(abs) || /(logo|sprite|icon|avatar|banner)/i.test(abs)) return;
		seen.add(abs);
		images.push({
			kind: "image",
			sourceId: source.id,
			tier: source.tier,
			sourceName: source.name,
			title,
			pageUrl,
			imageUrl: abs,
			licence,
			description: description ? clip(description, 300) : undefined,
		});
	};
	add(document.querySelector("meta[property='og:image']")?.getAttribute("content"), plainText(document.querySelector("meta[property='og:description']")?.getAttribute("content") ?? ""));
	for (const figure of Array.from(document.querySelectorAll("figure")).slice(0, 8)) {
		const img = figure.querySelector("img");
		add(img?.getAttribute("src") ?? img?.getAttribute("data-src"), plainText(figure.querySelector("figcaption")?.textContent ?? img?.getAttribute("alt") ?? ""));
	}
	for (const img of Array.from(document.querySelectorAll("img")).slice(0, 40)) {
		const width = Number(img.getAttribute("width") ?? 0);
		if (width && width < 200) continue;
		add(img.getAttribute("src") ?? img.getAttribute("data-src"), plainText(img.getAttribute("alt") ?? ""));
	}
	return { title, licence, images };
}

// ─── search results → page candidates (atlases, Radiopaedia, journals) ───────

/** A web-search hit → a candidate, when its site is on the list and (when `onlySource` is given) is that source. */
export function pageCandidateFromHit(hit: { title: string; url: string; snippet?: string }, onlySource?: string): FigureCandidateDraft | null {
	const source = figureSourceForPage(hit.url);
	if (!source || (onlySource && source.id !== onlySource)) return null;
	const url = httpsUrl(hit.url)!;
	url.hash = "";
	return {
		kind: "page",
		sourceId: source.id,
		tier: source.tier,
		sourceName: source.name,
		title: plainText(hit.title),
		pageUrl: url.toString(),
		description: hit.snippet ? clip(plainText(hit.snippet), 300) : undefined,
	};
}

/** Radiopaedia's own search page: always offered as a link, since its case pages block automated reads. */
export function radiopaediaSearchLink(query: string): FigureCandidateDraft {
	const source = figureSourceById("radiopaedia")!;
	const url = new URL("https://radiopaedia.org/search");
	url.searchParams.set("q", query);
	url.searchParams.set("scope", "all");
	return {
		kind: "page",
		sourceId: source.id,
		tier: source.tier,
		sourceName: source.name,
		title: `Radiopaedia search: ${query}`,
		pageUrl: url.toString(),
		description: "Radiopaedia's own search results for this concept.",
	};
}

/** Credit line for a candidate. */
export function candidateCredit(c: FigureCandidateDraft): string {
	return figureCreditLine({ author: c.author, source: c.sourceName, title: c.title });
}

// ─── network wrappers ────────────────────────────────────────────────────────

export interface SourceEnv {
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
}

/** Hosts a page read may touch: every listed source's page hosts. */
const allowPage = (url: URL): boolean => figureSourceForPage(url.toString()) !== null;

export type SearchOutcome = { ok: true; candidates: FigureCandidateDraft[] } | FetchFailure;

export async function searchCommons(query: string, env: SourceEnv): Promise<SearchOutcome> {
	const result = await fetchFigureText(commonsSearchUrl(query), { allow: allowPage, fetchImpl: env.fetchImpl, signal: env.signal, accept: "application/json" });
	if (!result.ok) return result;
	try {
		return { ok: true, candidates: parseCommonsResults(JSON.parse(result.text)) };
	} catch {
		return { ok: false, reason: "http", message: "Wikimedia Commons answered something that was not JSON." };
	}
}

export async function searchEuropePmc(query: string, env: SourceEnv): Promise<SearchOutcome> {
	const result = await fetchFigureText(europePmcSearchUrl(query), { allow: (u) => u.hostname === "www.ebi.ac.uk", fetchImpl: env.fetchImpl, signal: env.signal, accept: "application/json" });
	if (!result.ok) return result;
	try {
		return { ok: true, candidates: parseEuropePmcResults(JSON.parse(result.text)) };
	} catch {
		return { ok: false, reason: "http", message: "Europe PMC answered something that was not JSON." };
	}
}

export async function fetchEuropePmcFigures(pmcid: string, articleTitle: string, licence: FigureLicence | null, env: SourceEnv): Promise<SearchOutcome> {
	const result = await fetchFigureText(`${EUROPE_PMC_REST}/${pmcid}/fullTextXML`, { allow: (u) => u.hostname === "www.ebi.ac.uk", fetchImpl: env.fetchImpl, signal: env.signal, accept: "application/xml" });
	if (!result.ok) return result;
	return { ok: true, candidates: parseEuropePmcFigures(result.text, pmcid, articleTitle, licence) };
}

export type PageOutcome = { ok: true; page: ReadPage } | FetchFailure;

/** Open an atlas or case page and list its pictures. Journals are never opened. */
export async function readFigurePage(rawUrl: string, env: SourceEnv): Promise<PageOutcome | { ok: false; reason: "disallowed"; message: string }> {
	const source = figureSourceForPage(rawUrl);
	if (!source) return { ok: false, reason: "disallowed", message: "That site is not on the list of figure sources." };
	if (source.embed === "never") return { ok: false, reason: "disallowed", message: `${source.name} is copyrighted: link to it, do not open or embed it.` };
	const result = await fetchFigureText(rawUrl, { allow: allowPage, fetchImpl: env.fetchImpl, signal: env.signal });
	if (!result.ok) return result;
	return { ok: true, page: parsePageImages(result.text, result.finalUrl, source) };
}
