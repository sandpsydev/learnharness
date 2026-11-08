import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { serverExecute, type ImageFileResult } from "../tool-execute.ts";
import { processImage } from "../image-processing/index.ts";
import type { PiEngine } from "../models.ts";
import type { LibraryReader } from "../library/searcher.ts";
import type { FigureImage, FigureLink, FigureResult, FigureToolInput } from "../../core/contracts.ts";
import type { SearchProvider } from "../../core/search.ts";
import {
	FIGURE_SOURCES,
	figureImageAllowed,
	figureSourceById,
	figureSourceForPage,
	type FigureImageMime,
} from "../../core/figures.ts";
import { citationFor } from "../../core/library.ts";
import { fetchFigureImage } from "../figures/fetch.ts";
import { findCachedFigure, figureKey, writeCachedFigure } from "../figures/cache.ts";
import {
	candidateCredit,
	fetchEuropePmcFigures,
	pageCandidateFromHit,
	radiopaediaSearchLink,
	readFigurePage,
	searchCommons,
	searchEuropePmc,
	type FigureCandidateDraft,
} from "../figures/sources.ts";
import type { HeadlessApi } from "./headless.ts";
import { runSubagent } from "./pi-run.ts";

/**
 * The figure finder (medical fork): a background sub-agent that finds a REAL
 * picture for the lesson, in this order — the learner's own lecture slides,
 * Radiopaedia, trusted open atlases and open-access articles, and last a link
 * to a high-tier journal (NEJM and peers), which is copyrighted and never
 * embedded. It looks at each candidate before it vouches for it, and it never
 * draws.
 *
 * The model does the judging (does this picture show the concept?). Code owns
 * every rule that must hold whatever the model says: only listed sites are
 * contacted, a URL can only be one a tool returned, an image is shown only
 * when a reusable licence was read for it and the finder has looked at it, and
 * a doubtful match becomes a link.
 */

export interface FigureFinderEnv {
	chatId: string;
	/** data/figures — the session cache root. */
	cacheRoot: string;
	/** The learner's library, when it has a searchable book. */
	library?: { reader: LibraryReader; pdfPath: (bookId: string) => string };
	/** The live search engine (Tavily/Brave), or null. */
	search?: () => SearchProvider | null;
	headless: () => HeadlessApi;
	/** Test seam: replaces the network. */
	fetchImpl?: typeof fetch;
}

export interface FigureFinderOptions {
	engine?: PiEngine;
	env: FigureFinderEnv;
	abortSignal?: AbortSignal;
	onUsage?: (usage: Usage) => void;
	onActivity?: (line: string) => void;
	maxTurns?: number;
}

/** Page-image resolution for a lecture slide: sharp enough to read, light enough to keep. */
export const SLIDE_DPI = 110;

const INSTRUCTIONS = `You are a figure finder for a medical teaching app. The tutor asks for ONE real picture that shows a concept — anatomy, imaging, histology, a clinical photograph, an ECG. You find it, LOOK at it, and report. You never draw, sketch or describe-in-place-of-showing.

Look in this order and stop when a picture is good:
1. The learner's own lecture slides (slides_search). They are the learner's material; always try them first.
2. Radiopaedia — only when the concept is imaging (X-ray, CT, MRI, ultrasound, angiography). Use site_search with source "radiopaedia". Its case pages usually block automated reads: if page_images says so, give the link instead.
3. Trusted open sources: commons_search (anatomy drawings, histology, clinical photographs, ECGs; each file has its own licence), europepmc_search then europepmc_figures (open-access journal figures), and specialty atlases through site_search: dermnet (skin), litfl (ECG, emergency), eyerounds and eyewiki (eye), librepathology (histology). Open an atlas page with page_images.
4. A high-tier journal (NEJM "Images in Clinical Medicine", Lancet, JAMA, BMJ) through site_search with source "journal". These are copyrighted: they can only be linked, never shown.

Rules:
- You may only use ids that a tool gave you. Never write a URL yourself.
- look(id) before you show an image: the picture itself must show the concept. A matching title is not enough. Check the thing the tutor named (the side, the sign, the stain, the view).
- show_image only when you are confident the picture matches. If you are not sure, call give_links with the page instead — a link is better than a wrong picture.
- The caption (shows) says what the picture is in one or two plain sentences. key_feature names the ONE thing to find in it ("the thin white visceral pleural line with no lung markings beyond it"), written so the tutor can point at it. Say only what you can actually see; if a label or the source's description gives the diagnosis, say that it comes from the source.
- If look says the image cannot be shown (no reusable licence, or the site blocks downloads), the page is still a good link: use give_links, with a one-line note of what to look at on that page.
- give_links takes at most three pages, best first, each with a note of one line: what to look at.
- If nothing usable turns up after a fair search, call nothing_found. Do not pad.
- Keep it short: a handful of searches, not a crawl.

Finish by calling exactly one of show_image, give_links or nothing_found. Your last message after that can be empty.`;

// ─── candidates ──────────────────────────────────────────────────────────────

interface Candidate extends FigureCandidateDraft {
	id: string;
}

interface Viewed {
	file: string;
	mime: FigureImageMime;
}

interface Decision {
	result: FigureResult;
}

class Registry {
	private readonly all = new Map<string, Candidate>();
	private next = 1;
	readonly viewed = new Map<string, Viewed>();

	add(draft: FigureCandidateDraft): Candidate {
		const same = [...this.all.values()].find(
			(c) => c.kind === draft.kind && c.pageUrl === draft.pageUrl && c.imageUrl === draft.imageUrl && c.slide?.bookId === draft.slide?.bookId && c.slide?.page === draft.slide?.page,
		);
		if (same) return same;
		const c: Candidate = { ...draft, id: `c${this.next++}` };
		this.all.set(c.id, c);
		return c;
	}

	get(id: string): Candidate | undefined {
		return this.all.get(id.trim());
	}
}

function describe(c: Candidate): string {
	const reuse =
		c.kind === "slide"
			? "the learner's own slide"
			: c.kind === "page"
				? `a page (link${c.licence ? `; licence stated: ${c.licence.label}` : ""})`
				: c.licence
					? `licence ${c.licence.label}: can be shown`
					: "NO licence read: link only";
	const lines = [`${c.id} | ${c.title} | ${c.sourceName} | ${reuse}`];
	if (c.description) lines.push(`   ${c.description}`);
	return lines.join("\n");
}

const listOf = (cs: Candidate[], empty: string): string => (cs.length === 0 ? empty : cs.map(describe).join("\n"));

// ─── the tools ───────────────────────────────────────────────────────────────

const SITE_SOURCES = FIGURE_SOURCES.filter((s) => s.id !== "commons" && s.id !== "europepmc").map((s) => s.id);

const slidesInput = Type.Object({ query: Type.String({ minLength: 1, description: "What the slide should be about, in a few words." }) });
const queryInput = Type.Object({ query: Type.String({ minLength: 1, description: "A short search: the finding, the structure, the stain, the view." }) });
const siteInput = Type.Object({
	source: Type.Union(SITE_SOURCES.map((id) => Type.Literal(id)), { description: `Which site: ${SITE_SOURCES.join(", ")}.` }),
	query: Type.String({ minLength: 1, description: "A short search." }),
});
const idInput = Type.Object({ id: Type.String({ minLength: 1, description: "A candidate id a tool gave you, such as c3." }) });
const pageInput = Type.Object({ id: Type.String({ minLength: 1, description: "The id of a page candidate (an atlas or case page)." }) });
const showInput = Type.Object({
	id: Type.String({ minLength: 1, description: "The id of the candidate you looked at." }),
	shows: Type.String({ minLength: 1, description: "Caption: what the picture shows, one or two plain sentences." }),
	key_feature: Type.String({ minLength: 1, description: "The one feature to find in it, written so the tutor can point at it." }),
	confident: Type.Boolean({ description: "true only if you looked at it and it shows the concept. false turns it into a link." }),
});
const linksInput = Type.Object({
	links: Type.Array(Type.Object({ id: Type.String({ minLength: 1 }), note: Type.String({ minLength: 1, description: "One line: what to look at on that page." }) }), { minItems: 1, maxItems: 3 }),
	reason: Type.String({ minLength: 1, description: "Why no image is shown (blocked, no licence, not sure it matches, journal)." }),
});
const nothingInput = Type.Object({ reason: Type.String({ minLength: 1, description: "What you tried and why nothing fit." }) });

const oneLine = (text: string, max: number): string => {
	const t = text.replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

function createFigureTools(
	env: FigureFinderEnv,
	input: FigureToolInput,
	signalOf: () => AbortSignal | undefined,
	registry: Registry,
	decide: (d: Decision) => void,
	resizeOptions: () => import("../image-processing/index.ts").ProcessImageOptions["resizeOptions"],
): Record<string, AgentTool<any>> {
	const sourceEnv = () => ({ fetchImpl: env.fetchImpl, signal: signalOf() });
	const failureText = (what: string, f: { reason: string; message: string }): string =>
		`${what} failed (${f.reason}): ${f.message}${f.reason === "blocked" ? " This site does not allow automated downloads: offer its page as a link instead." : ""}`;

	/** Show a cached picture to the model. */
	async function showToModel(c: Candidate, cached: Viewed, bytes: Uint8Array): Promise<ImageFileResult> {
		const processed = await processImage(bytes, cached.mime, { resizeOptions: resizeOptions() });
		registry.viewed.set(c.id, cached);
		const facts = [
			`${c.id}: ${c.title} — ${c.sourceName}`,
			c.kind === "slide" ? "The learner's own lecture slide." : c.licence ? `Licence: ${c.licence.label} (can be shown).` : "No reusable licence was read: this can only be given as a link.",
			c.description ? `Source description: ${c.description}` : "",
			processed.ok ? "Look at the picture below, then decide." : processed.message,
		].filter(Boolean);
		return { text: facts.join("\n"), ...(processed.ok ? { images: [{ data: processed.data, mimeType: processed.mimeType }] } : {}) };
	}

	return {
		slides_search: {
			name: "slides_search",
			label: "slides_search",
			description: "Search the learner's own lecture slides and books. Returns candidate slides (lecture and slide number, with the slide's text). Use look to see one.",
			parameters: slidesInput,
			execute: serverExecute("slides_search", slidesInput, async ({ query }): Promise<string> => {
				if (!env.library) return "The learner has no lecture slides or books in the library. Go on to the next source.";
				const { hits } = await env.library.reader.search(query, { limit: 8 });
				const slides = hits
					.filter((h) => h.chunk.page > 0)
					.slice(0, 6)
					.map((h) =>
						registry.add({
							kind: "slide",
							sourceId: "library",
							tier: "slides",
							sourceName: h.book.kind === "slidescribe" ? "Your lecture slides" : "Your library",
							title: citationFor(h.book, h.chunk.page),
							description: oneLine(h.chunk.text, 280),
							slide: { bookId: h.book.id, bookTitle: h.book.title, page: h.chunk.page },
						}),
					);
				return listOf(slides, `No slide or page matches "${query}". Go on to the next source.`);
			}),
		},

		commons_search: {
			name: "commons_search",
			label: "commons_search",
			description: "Search Wikimedia Commons for pictures (anatomy, histology, clinical photos, imaging, ECG). Each result carries its own licence.",
			parameters: queryInput,
			execute: serverExecute("commons_search", queryInput, async ({ query }): Promise<string> => {
				const out = await searchCommons(query, sourceEnv());
				if (!out.ok) return failureText("Wikimedia Commons search", out);
				return listOf(out.candidates.map((d) => registry.add(d)), `Commons has no picture file for "${query}".`);
			}),
		},

		europepmc_search: {
			name: "europepmc_search",
			label: "europepmc_search",
			description: "Search open-access journal articles (Europe PMC). Returns article candidates with their licence; use europepmc_figures to list an article's figures.",
			parameters: queryInput,
			execute: serverExecute("europepmc_search", queryInput, async ({ query }): Promise<string> => {
				const out = await searchEuropePmc(query, sourceEnv());
				if (!out.ok) return failureText("Europe PMC search", out);
				return listOf(out.candidates.map((d) => registry.add(d)), `No open-access article found for "${query}".`);
			}),
		},

		europepmc_figures: {
			name: "europepmc_figures",
			label: "europepmc_figures",
			description: "List the figures of one open-access article (an id from europepmc_search). Returns image candidates with their captions.",
			parameters: pageInput,
			execute: serverExecute("europepmc_figures", pageInput, async ({ id }): Promise<string> => {
				const c = registry.get(id);
				const pmcid = c?.pageUrl ? /\/article\/PMC\/(\d+)/.exec(c.pageUrl)?.[1] : undefined;
				if (!c || c.sourceId !== "europepmc" || !pmcid) return `${id} is not an article from europepmc_search.`;
				const out = await fetchEuropePmcFigures(`PMC${pmcid}`, c.title, c.licence ?? null, sourceEnv());
				if (!out.ok) return failureText("Reading the article", out) + " The article itself is still a usable link.";
				return listOf(out.candidates.map((d) => registry.add(d)), "The article lists no figures.");
			}),
		},

		site_search: {
			name: "site_search",
			label: "site_search",
			description:
				"Find pages on one of the allowed sites (Radiopaedia, a specialty atlas, or the journals). Returns page candidates. " +
				`Sources: ${FIGURE_SOURCES.filter((s) => SITE_SOURCES.includes(s.id)).map((s) => `${s.id} (${s.covers})`).join("; ")}.`,
			parameters: siteInput,
			execute: serverExecute("site_search", siteInput, async ({ source: sourceId, query }): Promise<string> => {
				const source = figureSourceById(sourceId);
				if (!source) return `Unknown source ${sourceId}.`;
				const provider = env.search?.() ?? null;
				const out: Candidate[] = [];
				if (sourceId === "radiopaedia") out.push(registry.add(radiopaediaSearchLink(query)));
				if (!provider) {
					return `${listOf(out, "")}\nWeb search is not set up, so individual ${source.name} pages cannot be listed. ${out.length ? "The search link above can be given as a link." : "Try another source."}`.trim();
				}
				const scope = source.pageHosts.map((h) => `site:${h}`).join(" OR ");
				const hint = sourceId === "journal" ? " Images in Clinical Medicine" : "";
				try {
					const hits = await provider.search(`${query}${hint} (${scope})`, 10);
					for (const h of hits) {
						const draft = pageCandidateFromHit(h, sourceId);
						if (draft) out.push(registry.add(draft));
					}
				} catch (err) {
					return `${listOf(out, "")}\nWeb search failed: ${err instanceof Error ? err.message : String(err)}`.trim();
				}
				return listOf(out.slice(0, 8), `No ${source.name} page found for "${query}".`);
			}),
		},

		page_images: {
			name: "page_images",
			label: "page_images",
			description: "Open one atlas or case page (an id from site_search) and list its pictures with the licence the page states. Journals cannot be opened.",
			parameters: pageInput,
			execute: serverExecute("page_images", pageInput, async ({ id }): Promise<string> => {
				const c = registry.get(id);
				if (!c || c.kind !== "page" || !c.pageUrl) return `${id} is not a page candidate.`;
				const source = figureSourceForPage(c.pageUrl);
				if (!source || source.embed === "never") return `${c.sourceName} is copyrighted: give ${id} as a link; it cannot be opened or shown.`;
				const out = await readFigurePage(c.pageUrl, sourceEnv());
				if (!out.ok) return failureText("Opening the page", out) + ` ${id} is still a usable link.`;
				const images = out.page.images.map((d) => registry.add(d));
				return [
					`${c.title}: ${out.page.licence ? `the page states ${out.page.licence.label}` : "the page states no reusable licence, so its pictures can only be linked"}.`,
					listOf(images, "No usable picture on the page. The page itself is still a usable link."),
				].join("\n");
			}),
		},

		look: {
			name: "look",
			label: "look",
			description: "Fetch one candidate picture (a slide or an image) and show it to you. You must look before show_image.",
			parameters: idInput,
			execute: serverExecute("look", idInput, async ({ id }): Promise<string | ImageFileResult> => {
				const c = registry.get(id);
				if (!c) return `No candidate ${id}.`;
				if (c.kind === "page") return `${id} is a page, not a picture. Use page_images (or europepmc_figures) to list its pictures.`;
				if (c.kind === "slide" && c.slide) {
					const key = figureKey("slide", c.slide.bookId, c.slide.page, SLIDE_DPI);
					let cached = findCachedFigure(env.cacheRoot, env.chatId, key);
					if (!cached) {
						if (!env.library) return "The library is not available.";
						try {
							const [rendered] = await env.headless().renderPdfPages(env.library.pdfPath(c.slide.bookId), [c.slide.page], { dpi: SLIDE_DPI });
							if (!rendered) return `Slide ${c.slide.page} could not be rendered.`;
							cached = writeCachedFigure(env.cacheRoot, env.chatId, key, "image/png", rendered.png);
						} catch (err) {
							return `The slide could not be rendered: ${err instanceof Error ? err.message : String(err)}`;
						}
					}
					return showToModel(c, { file: cached.file, mime: cached.mime }, cached.bytes);
				}
				if (!c.imageUrl) return `${id} has no picture to look at.`;
				const source = figureSourceById(c.sourceId);
				if (!source) return `${id} is not from an allowed source.`;
				if (!figureImageAllowed(source, c.imageUrl)) return `${id}: ${source.name} does not allow this picture to be fetched. Give its page as a link.`;
				const key = figureKey("image", c.imageUrl);
				let cached = findCachedFigure(env.cacheRoot, env.chatId, key);
				if (!cached) {
					const fetched = await fetchFigureImage(c.imageUrl, {
						allow: (u) => figureImageAllowed(source, u.toString()),
						fetchImpl: env.fetchImpl,
						signal: signalOf(),
					});
					if (!fetched.ok) return failureText("Fetching the picture", fetched) + (c.pageUrl ? ` Its page (${id}) can still be given as a link.` : "");
					cached = writeCachedFigure(env.cacheRoot, env.chatId, key, fetched.mime, fetched.bytes);
				}
				return showToModel(c, { file: cached.file, mime: cached.mime }, cached.bytes);
			}),
		},

		show_image: {
			name: "show_image",
			label: "show_image",
			description: "FINISH: show the picture you looked at in the lesson, with your caption and the key feature. Only when you are confident it matches.",
			parameters: showInput,
			execute: serverExecute("show_image", showInput, (args): string => {
				const c = registry.get(args.id);
				if (!c) return `No candidate ${args.id}.`;
				const viewed = registry.viewed.get(c.id);
				if (!viewed) return `Look at ${c.id} first: a picture is shown only after you have seen it.`;
				const shows = oneLine(args.shows, 400);
				const keyFeature = oneLine(args.key_feature, 300);
				const shownAsLink = (why: string): string => {
					if (!c.pageUrl) {
						decide({ result: noneResult(input, `${c.title} may be relevant, but ${why}, so it is not shown. Tell the learner where to look: ${c.title}.`) });
						return "Recorded: not shown; nothing to link.";
					}
					decide({ result: linkResult(input, [{ title: c.title, url: c.pageUrl, source: c.sourceName, note: oneLine(`${shows} Look for: ${keyFeature}`, 240) }], why) });
					return `Recorded as a link (${why}).`;
				};
				if (!args.confident) return shownAsLink("the finder was not confident the picture matches the concept");
				const source = c.kind === "slide" ? null : figureSourceById(c.sourceId);
				if (c.kind !== "slide" && (!source || source.embed === "never" || !c.licence)) {
					return shownAsLink("no reusable licence was read for this picture");
				}
				const image: FigureImage = {
					file: viewed.file,
					mime: viewed.mime,
					tier: c.tier as FigureImage["tier"],
					source: c.sourceName,
					...(c.pageUrl ? { sourceUrl: c.pageUrl } : {}),
					title: c.title,
					credit: c.kind === "slide" ? `From your library: ${c.slide?.bookTitle ?? c.title}` : candidateCredit(c),
					licence: c.kind === "slide" ? "Your own lecture material" : c.licence!.label,
					...(c.licence?.url ? { licenceUrl: c.licence.url } : {}),
				};
				decide({ result: imageResult(input, image, shows, keyFeature) });
				return "Recorded: the picture will be shown in the lesson.";
			}),
		},

		give_links: {
			name: "give_links",
			label: "give_links",
			description: "FINISH: no picture is shown; give up to three pages as links, each with a one-line note of what to look at.",
			parameters: linksInput,
			execute: serverExecute("give_links", linksInput, ({ links, reason }): string => {
				const picked: FigureLink[] = [];
				for (const l of links) {
					const c = registry.get(l.id);
					if (!c?.pageUrl) return `${l.id} has no page to link. Use ids of pages or pictures from a tool.`;
					picked.push({ title: c.title, url: c.pageUrl, source: c.sourceName, note: oneLine(l.note, 240) });
				}
				decide({ result: linkResult(input, picked, oneLine(reason, 200)) });
				return "Recorded.";
			}),
		},

		nothing_found: {
			name: "nothing_found",
			label: "nothing_found",
			description: "FINISH: nothing usable was found.",
			parameters: nothingInput,
			execute: serverExecute("nothing_found", nothingInput, ({ reason }): string => {
				decide({ result: noneResult(input, oneLine(reason, 300)) });
				return "Recorded.";
			}),
		},
	};
}

// ─── results (the wording the tutor reads is set here, not by the model) ──────

export function imageResult(input: FigureToolInput, image: FigureImage, shows: string, keyFeature: string): FigureResult {
	return {
		concept: input.concept,
		outcome: "image",
		image,
		caption: shows,
		keyFeature,
		links: [],
		brief: [
			`A real figure is now shown in the lesson (it is not drawn): "${image.title}" — ${image.source}, ${image.licence}. The credit and source link are printed on the card.`,
			`It shows: ${shows}`,
			`Key feature to point at: ${keyFeature}`,
			"Teach with it: say what it shows, then point the learner at that feature. If something in the picture does not fit your concept, say so plainly instead of forcing it.",
		].join("\n"),
	};
}

export function linkResult(input: FigureToolInput, links: FigureLink[], why: string): FigureResult {
	return {
		concept: input.concept,
		outcome: "link",
		caption: "",
		keyFeature: "",
		links,
		brief: [
			`No picture is shown in the lesson (${why}). Give the learner these links, each with its one line of what to look at:`,
			...links.map((l) => `- ${l.title} — ${l.source}: ${l.note} ${l.url}`),
			"Say what the picture would show, in words. Do not draw it.",
		].join("\n"),
	};
}

export function noneResult(input: FigureToolInput, reason: string): FigureResult {
	return {
		concept: input.concept,
		outcome: "none",
		caption: "",
		keyFeature: "",
		links: [],
		brief: `No suitable figure was found for "${input.concept}": ${reason}\nDescribe it in words and point the learner to their atlas or imaging. Do not draw it.`,
	};
}

export function failedResult(input: Pick<FigureToolInput, "concept">, reason: string): FigureResult {
	return {
		concept: input.concept,
		outcome: "none",
		caption: "",
		keyFeature: "",
		links: [],
		brief: `Figure failed: ${reason}`,
	};
}

// ─── the run ─────────────────────────────────────────────────────────────────

export async function runFigureFinder(input: FigureToolInput, opts: FigureFinderOptions): Promise<FigureResult> {
	const registry = new Registry();
	let decision: Decision | null = null;
	const engine = opts.engine;
	const tools = Object.values(
		createFigureTools(
			opts.env,
			input,
			() => opts.abortSignal,
			registry,
			(d) => {
				decision ??= d;
			},
			() => engine?.model.inputLimits?.images?.resize,
		),
	);
	const prompt = [
		`Concept to show: ${input.concept}`,
		input.modality ? `Kind of picture: ${input.modality}` : null,
		input.context ? `Why the lesson needs it: ${input.context}` : null,
		"Find a real picture, look at it, and finish with show_image, give_links or nothing_found.",
	]
		.filter(Boolean)
		.join("\n");
	await runSubagent(tools, {
		role: "figureFinder",
		prompt,
		engine,
		systemPrompt: INSTRUCTIONS,
		maxTurns: opts.maxTurns ?? 16,
		abortSignal: opts.abortSignal,
		onUsage: opts.onUsage,
		shouldStop: () => decision !== null,
		onToolStart: (toolName, args) => opts.onActivity?.(activityLine(toolName, args)),
		chatId: opts.env.chatId,
	});
	return (decision as Decision | null)?.result ?? noneResult(input, "the search ended without a decision.");
}

function activityLine(toolName: string, args: unknown): string {
	const a = (args ?? {}) as { query?: string; source?: string };
	switch (toolName) {
		case "slides_search":
			return `searching your slides: "${a.query ?? ""}"`;
		case "commons_search":
			return `Wikimedia Commons: "${a.query ?? ""}"`;
		case "europepmc_search":
			return `open-access articles: "${a.query ?? ""}"`;
		case "site_search":
			return `${a.source ?? "site"}: "${a.query ?? ""}"`;
		case "look":
			return "looking at a candidate";
		case "page_images":
		case "europepmc_figures":
			return "reading a page";
		default:
			return toolName;
	}
}
