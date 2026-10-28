import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { DOMParser } from "linkedom";
import { serverExecute } from "../tool-execute.ts";

/**
 * Primary-evidence tools (medical fork, spec "Evidence sources for the
 * Changing tier"): PubMed and Europe PMC through their OFFICIAL, KEYLESS
 * APIs. The agent calls these automatically for trial results, the papers a
 * guideline or an Expert AI answer cites, and PMID/DOI lookups.
 *
 *   pubmed_search(query, count?)      → records (title, authors, journal, year, abstract, PMID/DOI)
 *   pubmed_fetch(pmids?, dois?)       → the same records for known ids (the cross-check)
 *   europepmc_search(query, count?)   → records, incl. open-access abstracts
 *
 * Etiquette: NCBI asks keyless clients to stay under 3 requests/second and
 * to identify the tool; every call sends `tool=learnharness`. The fetch is
 * injectable so tests never touch the network. Tool contract (as web.ts):
 * NEVER throw into the agent loop — failures come back as a clear string.
 */

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
/** Resolves global fetch at CALL time, so a test stubbing it later still lands. */
const globalFetch: FetchLike = (input, init) => fetch(input, init);

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const EPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest";
const TIMEOUT_MS = 15_000;
const MAX_ABSTRACT_CHARS = 2500;
/** A guard on one lookup, not a limit the learner will meet. */
export const MAX_LOOKUP_IDS = 12;

export interface LiteratureRecord {
	source: "pubmed" | "europepmc";
	pmid?: string;
	doi?: string;
	title: string;
	/** First three authors, then "et al." */
	authors: string;
	journal?: string;
	year?: string;
	abstract?: string;
	publicationTypes?: string[];
	/** Canonical landing page (PubMed when a PMID exists). */
	url: string;
}

function trimAbstract(text: string | undefined): string | undefined {
	const clean = text?.replace(/\s+/g, " ").trim();
	if (!clean) return undefined;
	return clean.length > MAX_ABSTRACT_CHARS ? `${clean.slice(0, MAX_ABSTRACT_CHARS)} […]` : clean;
}

function recordUrl(pmid: string | undefined, doi: string | undefined, fallback: string): string {
	if (pmid) return `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
	if (doi) return `https://doi.org/${doi}`;
	return fallback;
}

async function getJson<T>(url: string, fetchFn: FetchLike, what: string): Promise<T> {
	const resp = await fetchFn(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
	if (!resp.ok) throw new Error(`${what} ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
	return (await resp.json()) as T;
}

// ── PubMed (NCBI E-utilities) ────────────────────────────────────────────────

function eutilsUrl(endpoint: string, params: Record<string, string>): string {
	const url = new URL(`${EUTILS}/${endpoint}`);
	url.searchParams.set("tool", "learnharness");
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	return url.toString();
}

/** PMIDs matching a PubMed query, best match first. */
async function pubmedIds(term: string, count: number, fetchFn: FetchLike): Promise<string[]> {
	const data = await getJson<{ esearchresult?: { idlist?: string[] } }>(
		eutilsUrl("esearch.fcgi", { db: "pubmed", term, retmode: "json", retmax: String(count), sort: "relevance" }),
		fetchFn,
		"PubMed search",
	);
	return data.esearchresult?.idlist ?? [];
}

function text(el: Element | null | undefined): string | undefined {
	const t = el?.textContent?.replace(/\s+/g, " ").trim();
	return t ? t : undefined;
}

/** Parse efetch's PubmedArticleSet XML into records. */
export function parsePubmedXml(xml: string): LiteratureRecord[] {
	const doc = new DOMParser().parseFromString(xml, "text/xml") as unknown as Document;
	const out: LiteratureRecord[] = [];
	for (const article of Array.from(doc.getElementsByTagName("PubmedArticle"))) {
		const pmid = text(article.getElementsByTagName("PMID")[0]);
		const title = text(article.getElementsByTagName("ArticleTitle")[0]);
		if (!pmid || !title) continue;
		const doi = Array.from(article.getElementsByTagName("ArticleId"))
			.find((el) => el.getAttribute("IdType") === "doi")
			?.textContent?.trim()
			.toLowerCase();
		const names = Array.from(article.getElementsByTagName("Author")).map((a) => {
			const collective = text(a.getElementsByTagName("CollectiveName")[0]);
			if (collective) return collective;
			const last = text(a.getElementsByTagName("LastName")[0]);
			const initials = text(a.getElementsByTagName("Initials")[0]);
			return [last, initials].filter(Boolean).join(" ");
		}).filter(Boolean);
		const pubDate = article.getElementsByTagName("PubDate")[0];
		const year = text(pubDate?.getElementsByTagName("Year")[0]) ?? text(pubDate?.getElementsByTagName("MedlineDate")[0])?.match(/\d{4}/)?.[0];
		const abstract = Array.from(article.getElementsByTagName("AbstractText"))
			.map((el) => {
				const label = el.getAttribute("Label");
				const body = text(el);
				return body ? (label ? `${label}: ${body}` : body) : "";
			})
			.filter(Boolean)
			.join(" ");
		const types = Array.from(article.getElementsByTagName("PublicationType")).map((el) => text(el)).filter((t): t is string => !!t);
		out.push({
			source: "pubmed",
			pmid,
			...(doi ? { doi } : {}),
			title,
			authors: names.length > 3 ? `${names.slice(0, 3).join(", ")}, et al.` : names.join(", "),
			...(text(article.getElementsByTagName("Title")[0]) ? { journal: text(article.getElementsByTagName("Title")[0]) } : {}),
			...(year ? { year } : {}),
			...(trimAbstract(abstract) ? { abstract: trimAbstract(abstract) } : {}),
			...(types.length > 0 ? { publicationTypes: types } : {}),
			url: recordUrl(pmid, doi, `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`),
		});
	}
	return out;
}

async function pubmedRecords(pmids: readonly string[], fetchFn: FetchLike): Promise<LiteratureRecord[]> {
	if (pmids.length === 0) return [];
	const resp = await fetchFn(eutilsUrl("efetch.fcgi", { db: "pubmed", id: pmids.join(","), retmode: "xml" }), {
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!resp.ok) throw new Error(`PubMed fetch ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
	return parsePubmedXml(await resp.text());
}

/** PubMed search → full records (abstracts included). */
export async function searchPubmed(query: string, count: number, fetchFn: FetchLike = globalFetch): Promise<LiteratureRecord[]> {
	return pubmedRecords(await pubmedIds(query, Math.min(Math.max(count, 1), 10), fetchFn), fetchFn);
}

export interface PubmedLookup {
	records: LiteratureRecord[];
	/** Requested ids PubMed has no record for. */
	missingPmids: string[];
	missingDois: string[];
}

/** Look up known PMIDs and DOIs in PubMed (the cross-check). DOIs are
 *  resolved to PMIDs through PubMed's own article-id index. Throws when
 *  PubMed itself is unreachable (callers distinguish that from "not found"). */
export async function fetchPubmedRecords(
	ids: { pmids?: readonly string[]; dois?: readonly string[] },
	fetchFn: FetchLike = globalFetch,
): Promise<PubmedLookup> {
	const pmids = [...new Set(ids.pmids ?? [])].slice(0, MAX_LOOKUP_IDS);
	const dois = [...new Set((ids.dois ?? []).map((d) => d.toLowerCase()))].slice(0, MAX_LOOKUP_IDS);
	const doiToPmid = new Map<string, string>();
	for (const doi of dois) {
		const found = await pubmedIds(`"${doi}"[AID]`, 1, fetchFn);
		if (found[0]) doiToPmid.set(doi, found[0]);
	}
	const wanted = [...new Set([...pmids, ...doiToPmid.values()])];
	const records = await pubmedRecords(wanted, fetchFn);
	const havePmid = new Set(records.map((r) => r.pmid));
	return {
		records,
		missingPmids: pmids.filter((p) => !havePmid.has(p)),
		missingDois: dois.filter((d) => {
			const pmid = doiToPmid.get(d);
			return !pmid || !havePmid.has(pmid);
		}),
	};
}

// ── Europe PMC ───────────────────────────────────────────────────────────────

interface EpmcResult {
	id?: string;
	source?: string;
	pmid?: string;
	doi?: string;
	title?: string;
	authorString?: string;
	journalTitle?: string;
	pubYear?: string;
	abstractText?: string;
	pubTypeList?: { pubType?: string[] };
}

/** Europe PMC search → records. `abstractText` arrives as light HTML. */
export async function searchEuropePmc(query: string, count: number, fetchFn: FetchLike = globalFetch): Promise<LiteratureRecord[]> {
	const url = new URL(`${EPMC}/search`);
	url.searchParams.set("query", query);
	url.searchParams.set("format", "json");
	url.searchParams.set("resultType", "core");
	url.searchParams.set("pageSize", String(Math.min(Math.max(count, 1), 10)));
	const data = await getJson<{ resultList?: { result?: EpmcResult[] } }>(url.toString(), fetchFn, "Europe PMC search");
	return (data.resultList?.result ?? [])
		.filter((r) => r.title)
		.map((r): LiteratureRecord => {
			const pmid = r.pmid ?? (r.source === "MED" ? r.id : undefined);
			const doi = r.doi?.toLowerCase();
			const authors = (r.authorString ?? "").replace(/\.$/, "");
			const names = authors.split(",").map((n) => n.trim()).filter(Boolean);
			// Block tags separate words; inline tags (<i>, <b>) vanish without a gap.
			const abstract = trimAbstract(r.abstractText?.replace(/<\/?(?:h\d|p|br|li|ul|ol|div)\b[^>]*>/gi, " ").replace(/<[^>]+>/g, ""));
			return {
				source: "europepmc",
				...(pmid ? { pmid } : {}),
				...(doi ? { doi } : {}),
				title: (r.title ?? "").replace(/<[^>]+>/g, "").replace(/\.$/, ""),
				authors: names.length > 3 ? `${names.slice(0, 3).join(", ")}, et al.` : names.join(", "),
				...(r.journalTitle ? { journal: r.journalTitle } : {}),
				...(r.pubYear ? { year: r.pubYear } : {}),
				...(abstract ? { abstract } : {}),
				...(r.pubTypeList?.pubType?.length ? { publicationTypes: r.pubTypeList.pubType } : {}),
				url: recordUrl(pmid, doi, `https://europepmc.org/search?query=${encodeURIComponent(r.title ?? "")}`),
			};
		});
}

// ── tool registry ────────────────────────────────────────────────────────────

const searchInput = Type.Object({
	query: Type.String({ description: "The search query (PubMed / Europe PMC syntax and plain words both work)" }),
	count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Number of records (default 5, max 10)" })),
});

const fetchInput = Type.Object({
	pmids: Type.Optional(Type.Array(Type.String(), { description: "PubMed IDs, digits only" })),
	dois: Type.Optional(Type.Array(Type.String(), { description: "DOIs, e.g. 10.1056/NEJMoa2034577" })),
});

const NO_RESULTS = "No records found. Try fewer or different terms.";

export function createLiteratureTools(fetchFn: FetchLike = globalFetch): Record<string, AgentTool<any>> {
	const failure = (tool: string, err: unknown) =>
		`${tool} failed: ${err instanceof Error ? err.message : String(err)}. The literature service may be offline — say the evidence could not be checked rather than guessing.`;
	return {
		pubmed_search: {
			name: "pubmed_search",
			label: "pubmed_search",
			description:
				"Search PubMed (official keyless API) for PRIMARY EVIDENCE: trials, meta-analyses, the papers a guideline cites. " +
				"Returns records with title, authors, journal, year, abstract, PMID and DOI. Use it for trial results and cited references — " +
				"not for management principles (those go to UpToDate Expert AI) or exact guideline wording (use research).",
			parameters: searchInput,
			execute: serverExecute("pubmed_search", searchInput, async ({ query, count }) => {
				try {
					const records = await searchPubmed(query, count ?? 5, fetchFn);
					return records.length > 0 ? records : NO_RESULTS;
				} catch (err) {
					return failure("pubmed_search", err);
				}
			}),
		},
		pubmed_fetch: {
			name: "pubmed_fetch",
			label: "pubmed_fetch",
			description:
				"Look up known PMIDs and/or DOIs in PubMed and return their records (title, journal, year, abstract). " +
				"Use it to cross-check a citation someone gave you — a PMID or DOI that PubMed does not know is reported as not found.",
			parameters: fetchInput,
			execute: serverExecute("pubmed_fetch", fetchInput, async ({ pmids, dois }) => {
				if ((pmids?.length ?? 0) + (dois?.length ?? 0) === 0) return "pubmed_fetch needs at least one PMID or DOI.";
				try {
					const found = await fetchPubmedRecords({ pmids, dois }, fetchFn);
					return {
						records: found.records,
						notFound: { pmids: found.missingPmids, dois: found.missingDois },
					};
				} catch (err) {
					return failure("pubmed_fetch", err);
				}
			}),
		},
		europepmc_search: {
			name: "europepmc_search",
			label: "europepmc_search",
			description:
				"Search Europe PMC (official keyless API) — PubMed plus preprints, guidelines and open-access full-text records. " +
				"Use it when pubmed_search finds nothing, or for open-access material. Same record shape as pubmed_search.",
			parameters: searchInput,
			execute: serverExecute("europepmc_search", searchInput, async ({ query, count }) => {
				try {
					const records = await searchEuropePmc(query, count ?? 5, fetchFn);
					return records.length > 0 ? records : NO_RESULTS;
				} catch (err) {
					return failure("europepmc_search", err);
				}
			}),
		},
	};
}

/** The keyless instance the teacher registry uses (global fetch). */
export const literatureTools = createLiteratureTools();
