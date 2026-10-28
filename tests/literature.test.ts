/**
 * PubMed / Europe PMC tools (src/agent/tools/literature.ts) against FAKE
 * fetches shaped like the official keyless APIs — no network, no keys.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createLiteratureTools,
	fetchPubmedRecords,
	parsePubmedXml,
	searchEuropePmc,
	searchPubmed,
} from "../src/agent/tools/literature.ts";

const EFETCH_XML = `<?xml version="1.0"?>
<PubmedArticleSet>
 <PubmedArticle>
  <MedlineCitation>
   <PMID Version="1">10471</PMID>
   <Article>
    <Journal><JournalIssue><PubDate><Year>1999</Year></PubDate></JournalIssue><Title>The New England journal of medicine</Title></Journal>
    <ArticleTitle>The effect of spironolactone on morbidity and mortality in patients with severe heart failure.</ArticleTitle>
    <Abstract>
     <AbstractText Label="BACKGROUND">Aldosterone is important.</AbstractText>
     <AbstractText Label="RESULTS">Risk of death fell by 30 percent.</AbstractText>
    </Abstract>
    <AuthorList>
     <Author><LastName>Pitt</LastName><Initials>B</Initials></Author>
     <Author><LastName>Zannad</LastName><Initials>F</Initials></Author>
     <Author><LastName>Remme</LastName><Initials>WJ</Initials></Author>
     <Author><LastName>Cody</LastName><Initials>R</Initials></Author>
    </AuthorList>
    <PublicationTypeList><PublicationType>Randomized Controlled Trial</PublicationType></PublicationTypeList>
   </Article>
  </MedlineCitation>
  <PubmedData><ArticleIdList><ArticleId IdType="pubmed">10471</ArticleId><ArticleId IdType="doi">10.1056/NEJM199909023411001</ArticleId></ArticleIdList></PubmedData>
 </PubmedArticle>
</PubmedArticleSet>`;

interface Call {
	url: URL;
}

/** A fake of the two NCBI endpoints + Europe PMC; records every call. */
function fakeApis(opts: { idlistByTerm?: Record<string, string[]>; status?: number } = {}) {
	const calls: Call[] = [];
	const fetchFn = async (input: string): Promise<Response> => {
		const url = new URL(input);
		calls.push({ url });
		if (opts.status && opts.status !== 200) return new Response("service down", { status: opts.status });
		if (url.pathname.endsWith("esearch.fcgi")) {
			const term = url.searchParams.get("term") ?? "";
			return Response.json({ esearchresult: { idlist: opts.idlistByTerm?.[term] ?? ["10471"] } });
		}
		if (url.pathname.endsWith("efetch.fcgi")) {
			const ids = (url.searchParams.get("id") ?? "").split(",");
			// Only PMID 10471 exists.
			return new Response(ids.includes("10471") ? EFETCH_XML : `<PubmedArticleSet></PubmedArticleSet>`);
		}
		if (url.pathname.endsWith("/search")) {
			return Response.json({
				resultList: {
					result: [
						{
							id: "10471",
							source: "MED",
							pmid: "10471",
							doi: "10.1056/NEJM199909023411001",
							title: "The effect of spironolactone <i>in</i> heart failure.",
							authorString: "Pitt B, Zannad F, Remme WJ, Cody R.",
							journalTitle: "N Engl J Med",
							pubYear: "1999",
							abstractText: "<h4>Background</h4> Aldosterone <b>matters</b>.",
							pubTypeList: { pubType: ["Journal Article"] },
						},
						{ id: "x", source: "PPR" },
					],
				},
			});
		}
		return new Response("nope", { status: 404 });
	};
	return { fetchFn, calls };
}

describe("parsePubmedXml", () => {
	it("reads PMID, DOI, title, journal, year, labelled abstract, authors (3 + et al.) and publication type", () => {
		const [r] = parsePubmedXml(EFETCH_XML);
		assert.equal(r?.pmid, "10471");
		assert.equal(r?.doi, "10.1056/nejm199909023411001");
		assert.match(r?.title ?? "", /^The effect of spironolactone/);
		assert.equal(r?.journal, "The New England journal of medicine");
		assert.equal(r?.year, "1999");
		assert.equal(r?.abstract, "BACKGROUND: Aldosterone is important. RESULTS: Risk of death fell by 30 percent.");
		assert.equal(r?.authors, "Pitt B, Zannad F, Remme WJ, et al.");
		assert.deepEqual(r?.publicationTypes, ["Randomized Controlled Trial"]);
		assert.equal(r?.url, "https://pubmed.ncbi.nlm.nih.gov/10471/");
	});

	it("an empty set parses to no records", () => {
		assert.deepEqual(parsePubmedXml("<PubmedArticleSet></PubmedArticleSet>"), []);
	});
});

describe("PubMed clients (fake NCBI)", () => {
	it("searchPubmed: esearch for ids, then efetch for records; identifies the tool", async () => {
		const { fetchFn, calls } = fakeApis();
		const records = await searchPubmed("spironolactone heart failure", 3, fetchFn);
		assert.equal(records.length, 1);
		assert.equal(calls[0]!.url.searchParams.get("tool"), "learnharness");
		assert.equal(calls[0]!.url.searchParams.get("retmax"), "3");
		assert.equal(calls[1]!.url.pathname.endsWith("efetch.fcgi"), true);
		assert.equal(calls[1]!.url.searchParams.get("id"), "10471");
	});

	it("fetchPubmedRecords: found PMID, unknown PMID, DOI resolved through the article-id index, unknown DOI", async () => {
		const { fetchFn, calls } = fakeApis({
			idlistByTerm: { '"10.1056/nejm199909023411001"[AID]': ["10471"], '"10.9999/fake"[AID]': [] },
		});
		const found = await fetchPubmedRecords({ pmids: ["10471", "99999999"], dois: ["10.1056/NEJM199909023411001", "10.9999/fake"] }, fetchFn);
		assert.deepEqual(found.records.map((r) => r.pmid), ["10471"]);
		assert.deepEqual(found.missingPmids, ["99999999"]);
		assert.deepEqual(found.missingDois, ["10.9999/fake"]);
		assert.ok(calls.some((c) => c.url.searchParams.get("term") === '"10.9999/fake"[AID]'));
	});

	it("fetchPubmedRecords throws when PubMed itself is down (so callers can say UNVERIFIED, not 'not found')", async () => {
		const { fetchFn } = fakeApis({ status: 503 });
		await assert.rejects(() => fetchPubmedRecords({ pmids: ["10471"] }, fetchFn), /503/);
	});
});

describe("Europe PMC client (fake)", () => {
	it("maps results, strips HTML, trims authors, skips untitled rows", async () => {
		const { fetchFn, calls } = fakeApis();
		const records = await searchEuropePmc("spironolactone", 5, fetchFn);
		assert.equal(calls[0]!.url.searchParams.get("format"), "json");
		assert.equal(calls[0]!.url.searchParams.get("resultType"), "core");
		assert.equal(records.length, 1);
		assert.equal(records[0]?.title, "The effect of spironolactone in heart failure");
		assert.equal(records[0]?.authors, "Pitt B, Zannad F, Remme WJ, et al.");
		assert.match(records[0]?.abstract ?? "", /^Background Aldosterone matters\./);
		assert.equal(records[0]?.url, "https://pubmed.ncbi.nlm.nih.gov/10471/");
	});
});

describe("the three tools (never throw into the loop)", () => {
	it("pubmed_search, pubmed_fetch and europepmc_search return records", async () => {
		const tools = createLiteratureTools(fakeApis().fetchFn);
		assert.deepEqual(Object.keys(tools).sort(), ["europepmc_search", "pubmed_fetch", "pubmed_search"]);

		const search = await tools.pubmed_search!.execute!("c1", { query: "spironolactone" });
		assert.equal((search.details as Array<{ pmid: string }>)[0]?.pmid, "10471");

		const fetched = await tools.pubmed_fetch!.execute!("c2", { pmids: ["10471", "1"] });
		const out = fetched.details as { records: unknown[]; notFound: { pmids: string[] } };
		assert.equal(out.records.length, 1);
		assert.deepEqual(out.notFound.pmids, ["1"]);

		const epmc = await tools.europepmc_search!.execute!("c3", { query: "spironolactone" });
		assert.equal((epmc.details as Array<{ source: string }>)[0]?.source, "europepmc");
	});

	it("an outage comes back as a string that says the evidence could not be checked", async () => {
		const tools = createLiteratureTools(fakeApis({ status: 500 }).fetchFn);
		for (const [name, input] of [["pubmed_search", { query: "q" }], ["pubmed_fetch", { pmids: ["1"] }], ["europepmc_search", { query: "q" }]] as const) {
			const out = await tools[name]!.execute!("c", input);
			assert.equal(typeof out.details, "string");
			assert.match(out.details as string, new RegExp(`${name} failed`));
			assert.match(out.details as string, /could not be checked/);
			assert.notEqual(out.isError, true);
		}
	});

	it("pubmed_fetch with no ids says so", async () => {
		const tools = createLiteratureTools(fakeApis().fetchFn);
		const out = await tools.pubmed_fetch!.execute!("c", {});
		assert.match(out.details as string, /at least one PMID or DOI/);
	});

	it("no hits is a plain message, not an empty array", async () => {
		const tools = createLiteratureTools(fakeApis({ idlistByTerm: { nothing: [] } }).fetchFn);
		const out = await tools.pubmed_search!.execute!("c", { query: "nothing" });
		assert.match(out.details as string, /No records found/);
	});
});
