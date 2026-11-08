/**
 * REAL FIGURES (medical fork): the pure rules behind the `figure` job — which
 * sites a figure may come from, which of those may be shown inside the lesson,
 * and how a licence line is read. Node-free so the tool, the fetcher, the UI
 * and the tests all share one table.
 *
 * Two rules decide everything here:
 *  1. Only the sites in FIGURE_SOURCES are ever contacted (https only).
 *  2. An image is shown in the lesson only when a reusable licence is READ off
 *     the page or the file's own record. No licence found, or a source marked
 *     "never" (a journal, PathologyOutlines) = link only, never embedded.
 */

/** Where a figure came from, in the order the tutor looks. */
export type FigureTier = "slides" | "radiopaedia" | "specialty" | "commons" | "open-journal" | "journal-link";

export interface FigureSource {
	id: string;
	name: string;
	tier: FigureTier;
	/** Hosts a page of this source lives on (a host matches itself and its subdomains). */
	pageHosts: string[];
	/** Hosts an IMAGE of this source may be fetched from. */
	imageHosts: string[];
	/** Hosts that serve this source's images only under a path prefix (a shared image CDN). */
	sharedImageHosts?: { host: string; pathPrefix: string }[];
	/** "licence" = embed only when a reusable licence is read; "never" = always link only. */
	embed: "licence" | "never";
	/** What the tutor should use it for (shown to the finder). */
	covers: string;
}

export const FIGURE_SOURCES: readonly FigureSource[] = [
	{
		id: "radiopaedia",
		name: "Radiopaedia",
		tier: "radiopaedia",
		pageHosts: ["radiopaedia.org"],
		imageHosts: ["radiopaedia.org", "prod-images-static.radiopaedia.org"],
		embed: "licence",
		covers: "radiology cases and articles: X-ray, CT, MRI, ultrasound, nuclear medicine, angiography",
	},
	{
		id: "commons",
		name: "Wikimedia Commons",
		tier: "commons",
		pageHosts: ["commons.wikimedia.org"],
		imageHosts: ["upload.wikimedia.org", "thumb.wikimedia.org"],
		embed: "licence",
		covers: "anatomy drawings, histology, clinical photographs, imaging, ECG tracings (each file carries its own licence)",
	},
	{
		id: "europepmc",
		name: "Europe PMC / PubMed Central (open access)",
		tier: "open-journal",
		pageHosts: ["europepmc.org", "www.ebi.ac.uk", "pmc.ncbi.nlm.nih.gov"],
		imageHosts: ["europepmc.org", "cdn.ncbi.nlm.nih.gov", "pmc.ncbi.nlm.nih.gov"],
		embed: "licence",
		covers: "figures from open-access journal articles (case reports, reviews) under a Creative Commons licence",
	},
	{
		id: "dermnet",
		name: "DermNet",
		tier: "specialty",
		pageHosts: ["dermnetnz.org"],
		imageHosts: ["dermnetnz.org"],
		embed: "licence",
		covers: "dermatology: skin lesions, rashes, dermoscopy, histology",
	},
	{
		id: "litfl",
		name: "Life in the Fast Lane",
		tier: "specialty",
		pageHosts: ["litfl.com"],
		imageHosts: ["litfl.com"],
		sharedImageHosts: ["i0.wp.com", "i1.wp.com", "i2.wp.com"].map((host) => ({ host, pathPrefix: "/litfl.com/" })),
		embed: "licence",
		covers: "ECG, emergency medicine, critical care, toxicology",
	},
	{
		id: "eyerounds",
		name: "EyeRounds",
		tier: "specialty",
		pageHosts: ["eyerounds.org"],
		imageHosts: ["eyerounds.org"],
		embed: "licence",
		covers: "ophthalmology cases: fundus, slit-lamp, OCT, external eye photographs",
	},
	{
		id: "eyewiki",
		name: "EyeWiki (AAO)",
		tier: "specialty",
		pageHosts: ["eyewiki.org"],
		imageHosts: ["eyewiki.org"],
		embed: "licence",
		covers: "ophthalmology articles",
	},
	{
		id: "librepathology",
		name: "Libre Pathology",
		tier: "specialty",
		pageHosts: ["librepathology.org"],
		imageHosts: ["librepathology.org", "upload.wikimedia.org"],
		embed: "licence",
		covers: "histopathology and cytology micrographs",
	},
	{
		id: "pathologyoutlines",
		name: "PathologyOutlines",
		tier: "specialty",
		pageHosts: ["pathologyoutlines.com"],
		imageHosts: [],
		embed: "never",
		covers: "pathology topic pages (copyrighted: link only)",
	},
	{
		id: "journal",
		name: "High-tier journal",
		tier: "journal-link",
		// NEJM "Images in Clinical Medicine" and the peer journals. Copyrighted: the tutor links to
		// the article with its title and a one-line description, and never fetches or embeds it.
		pageHosts: ["nejm.org", "thelancet.com", "jamanetwork.com", "bmj.com", "acpjournals.org", "ahajournals.org"],
		imageHosts: [],
		embed: "never",
		covers: "NEJM Images in Clinical Medicine, Lancet, JAMA, BMJ, Annals, Circulation (copyrighted: link only)",
	},
];

export const FIGURE_TIER_LABEL: Record<FigureTier, string> = {
	slides: "Your lecture slides",
	radiopaedia: "Radiopaedia",
	specialty: "Specialty atlas",
	commons: "Wikimedia Commons",
	"open-journal": "Open-access journal",
	"journal-link": "Journal (link only)",
};

const hostMatches = (host: string, allowed: string): boolean => host === allowed || host.endsWith(`.${allowed}`);

/** The https URL, or null for anything else (http, data:, file:, credentials in the URL, a malformed string). */
export function httpsUrl(raw: string): URL | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol !== "https:") return null;
	if (url.username || url.password) return null;
	return url;
}

/** The source a PAGE URL belongs to, or null when the site is not on the list. */
export function figureSourceForPage(raw: string): FigureSource | null {
	const url = httpsUrl(raw);
	if (!url) return null;
	const host = url.hostname.toLowerCase();
	return FIGURE_SOURCES.find((s) => s.pageHosts.some((h) => hostMatches(host, h))) ?? null;
}

/** Whether `raw` is an image URL this source is allowed to serve from. */
export function figureImageAllowed(source: FigureSource, raw: string): boolean {
	if (source.embed === "never") return false;
	const url = httpsUrl(raw);
	if (!url) return false;
	const host = url.hostname.toLowerCase();
	if (source.imageHosts.some((h) => hostMatches(host, h))) return true;
	return (source.sharedImageHosts ?? []).some((s) => host === s.host && url.pathname.startsWith(s.pathPrefix));
}

export function figureSourceById(id: string): FigureSource | null {
	return FIGURE_SOURCES.find((s) => s.id === id) ?? null;
}

// ─── licence reading ─────────────────────────────────────────────────────────

export interface FigureLicence {
	/** "CC BY-NC-SA 4.0", "CC0 1.0", "Public domain". */
	label: string;
	url?: string;
}

const CC_ELEMENTS = new Set(["by", "by-sa", "by-nc", "by-nc-sa", "by-nd", "by-nc-nd"]);

const ccLabel = (elements: string, version?: string): string =>
	`CC ${elements.toUpperCase()}${version ? ` ${version}` : ""}`;

/**
 * Read a Creative Commons or public-domain licence out of free text: a licence URL, or a label such as
 * "CC BY-NC-SA 4.0", "cc by-nc" (Europe PMC) or "Public domain". Returns null when none is stated —
 * "all rights reserved", "fair use" and silence all read as null, which means link only.
 *
 * Every Creative Commons variant is accepted, NC and ND included: the tutor shows an unaltered image with
 * credit, inside a personal study app, and never sells or edits it.
 */
export function readFigureLicence(text: string): FigureLicence | null {
	if (!text) return null;
	const url = /https?:\/\/(?:www\.)?creativecommons\.org\/(licenses|publicdomain)\/([a-z0-9-]+)\/?(\d\.\d)?[^\s"'<>)]*/i.exec(text);
	if (url) {
		const kind = url[1]!.toLowerCase();
		const element = url[2]!.toLowerCase();
		if (kind === "licenses" && CC_ELEMENTS.has(element)) return { label: ccLabel(element, url[3]), url: url[0] };
		if (kind === "publicdomain" && element === "zero") return { label: `CC0${url[3] ? ` ${url[3]}` : ""}`, url: url[0] };
		if (kind === "publicdomain" && element === "mark") return { label: "Public domain", url: url[0] };
	}
	if (/\b(?:all rights reserved|fair use|non-free|copyrighted)\b/i.test(text) && !/\bcc[ -]/i.test(text)) return null;
	const label = /\bCC[ -]?(BY(?:-NC)?(?:-SA|-ND)?)(?:[ -]?(\d\.\d))?\b/i.exec(text);
	if (label) return { label: ccLabel(label[1]!.toLowerCase(), label[2]) };
	if (/\bCC0\b/i.test(text)) return { label: "CC0" };
	if (/\b(?:public domain|PD-[A-Za-z0-9-]+|no known copyright restrictions)\b/i.test(text)) return { label: "Public domain" };
	return null;
}

/** "Author, via Source" — the credit line printed under a figure. */
export function figureCreditLine(parts: { author?: string; source: string; title?: string }): string {
	const author = parts.author?.replace(/\s+/g, " ").trim();
	return author ? `${author}, via ${parts.source}` : parts.title ? `${parts.title}, via ${parts.source}` : parts.source;
}

// ─── the session cache ───────────────────────────────────────────────────────

export const FIGURE_IMAGE_EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" } as const;
export type FigureImageMime = keyof typeof FIGURE_IMAGE_EXTENSIONS;

export const FIGURE_MIME_BY_EXTENSION: Record<string, FigureImageMime> = {
	png: "image/png",
	jpg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};

/** A cached file name is a hex key plus a known extension — nothing else is ever served. */
export const FIGURE_FILE_PATTERN = /^[a-f0-9]{24}\.(?:png|jpg|gif|webp)$/;
/** A chat id is `chat_<base36>_<hex>`; the cache folder is named by it, so nothing else may name a folder. */
export const FIGURE_CHAT_PATTERN = /^chat_[a-z0-9]+_[a-z0-9]+$/;

/** The image URL a lesson card loads (served by app/api/figures). */
export function figureImagePath(chatId: string, file: string): string {
	return `/api/figures/${encodeURIComponent(chatId)}/${encodeURIComponent(file)}`;
}
