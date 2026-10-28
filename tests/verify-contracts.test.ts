/**
 * The pure half of the verify loop (src/core/contracts/verify.ts): the
 * no-identifiers guard, PMID/DOI extraction, and the brief the teacher
 * reads when an Expert AI answer arrives. No IO.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ANKI_OFFER_INSTRUCTION,
	buildAnswerBrief,
	buildHighlightBrief,
	expertAiCitation,
	extractCitationIds,
	identifierProblems,
	verifyPromptProblems,
	VERIFY_LIMITS,
} from "../src/core/contracts.ts";

describe("identifierProblems — the no-identifiers backstop", () => {
	const generic = [
		"A man in his late fifties with HFrEF (EF 30%) on an ACE inhibitor and beta-blocker. What is the guideline basis for adding an MRA, and at what potassium and eGFR thresholds?",
		"A 34-year-old woman, 12 weeks pregnant, with new hypertension at 150/95. First-line agent and why?",
		"What does the 2023 ESC guideline say about DOAC dosing when creatinine clearance is 25-30 mL/min?",
	];
	for (const prompt of generic) {
		it(`passes a generic clinical prompt: “${prompt.slice(0, 40)}…”`, () => {
			assert.deepEqual(identifierProblems(prompt), []);
			assert.deepEqual(verifyPromptProblems(prompt), []);
		});
	}

	const identifying: string[] = [
		"Patient HN 4521987 with sepsis, what antibiotic?",
		"MRN: 88123 needs a statin?",
		"Mr Somchai has atrial fibrillation, anticoagulate?",
		"Email the answer to dr.who@hospital.org about this case",
		"Call 081-234-5678 about the diabetic foot",
		"Thai ID 1103700123456 admitted with MI",
		"Born on 3 March, DOB 03/03/1962, chest pain",
		"Seen on 14/10/2026 with fever, antibiotics?",
		"นายสมชาย เป็นเบาหวาน ควรเริ่มยาอะไร",
		"Patient named Anan with asthma",
	];
	for (const prompt of identifying) {
		it(`flags: ${prompt.slice(0, 48)}`, () => {
			assert.ok(identifierProblems(prompt).length > 0, "something is flagged");
		});
	}

	it("verifyPromptProblems also bounces empty and over-long prompts", () => {
		assert.ok(verifyPromptProblems("   ").some((p) => p.includes("empty")));
		assert.ok(verifyPromptProblems("x".repeat(VERIFY_LIMITS.promptChars + 1)).some((p) => p.includes("keep it under")));
	});

	it("an identifier problem tells the teacher how to fix it", () => {
		const [problem] = verifyPromptProblems("Mr Somchai with AF");
		assert.ok(problem?.includes("Rewrite it generic"));
	});
});

describe("extractCitationIds", () => {
	it("finds PMIDs in prose and PubMed URLs, and DOIs, deduped in order", () => {
		const ids = extractCitationIds(
			"See PMID: 12345678 and PMID 87654321 (also https://pubmed.ncbi.nlm.nih.gov/12345678/).",
			"doi:10.1056/NEJMoa2034577. Again 10.1056/NEJMoa2034577, plus https://doi.org/10.1161/CIR.0000000000001063)",
		);
		assert.deepEqual(ids.pmids, ["12345678", "87654321"]);
		assert.deepEqual(ids.dois, ["10.1056/nejmoa2034577", "10.1161/cir.0000000000001063"]);
	});

	it("returns nothing for text with no citations", () => {
		assert.deepEqual(extractCitationIds("Start an MRA if K < 5.0 and eGFR > 30."), { pmids: [], dois: [] });
	});
});

describe("the briefs the teacher reads", () => {
	const answer = {
		text: "Add an MRA when EF is 35% or less despite ACEi and beta-blocker (PMID 111111).",
		references: [{ title: "2022 AHA/ACC/HFSA guideline", url: "https://doi.org/10.1161/CIR.0000000000001063" }],
		receivedAt: "2026-10-29T08:15:00.000Z",
	};

	it("citation form is “UpToDate Expert AI, [date]”", () => {
		assert.equal(expertAiCitation(answer.receivedAt), "UpToDate Expert AI, 2026-10-29");
	});

	it("an answer brief carries the question, the provisional claim, the answer, the references and the cross-check", () => {
		const brief = buildAnswerBrief(
			{ prompt: "When to add an MRA in HFrEF?", provisionalClaim: "Add an MRA at EF ≤ 40%." },
			answer,
			[
				{ kind: "pmid", id: "111111", found: true, title: "RALES", journal: "NEJM", year: "1999" },
				{ kind: "doi", id: "10.9999/fake", found: false },
			],
			false,
		);
		assert.match(brief, /When to add an MRA in HFrEF\?/);
		assert.match(brief, /What you taught provisionally while waiting:\nAdd an MRA at EF ≤ 40%\./);
		assert.match(brief, /Add an MRA when EF is 35% or less/);
		assert.match(brief, /2022 AHA\/ACC\/HFSA guideline — https:\/\/doi\.org\/10\.1161/);
		assert.match(brief, /PMID 111111: found — "RALES" \(NEJM, 1999\)/);
		assert.match(brief, /DOI 10\.9999\/fake: NOT FOUND in PubMed/);
		assert.match(brief, /“UpToDate Expert AI, 2026-10-29”|"UpToDate Expert AI, 2026-10-29"/);
		assert.ok(brief.includes(ANKI_OFFER_INSTRUCTION), "the Anki offer hook rides every answer brief");
	});

	it("a failed PubMed lookup says UNVERIFIED — never an implied pass", () => {
		const brief = buildAnswerBrief({ prompt: "q" }, answer, [], true);
		assert.match(brief, /could not reach PubMed, so the citations above are UNVERIFIED/);
		assert.match(brief, /You did not record a provisional claim/);
	});

	it("no citations → says there was nothing to cross-check", () => {
		const brief = buildAnswerBrief({ prompt: "q" }, { ...answer, references: [], text: "No ids here." }, [], false);
		assert.match(brief, /nothing to cross-check/);
		assert.match(brief, /Reference links it gave:\n\(none sent\)/);
	});

	it("a highlight brief names the page and the text", () => {
		const brief = buildHighlightBrief({
			text: "Target BP is below 130/80.",
			url: "https://example.org/guideline",
			title: "Hypertension guideline",
			references: [],
			receivedAt: "2026-10-29T09:00:00.000Z",
		});
		assert.match(brief, /Hypertension guideline — https:\/\/example\.org\/guideline/);
		assert.match(brief, /Target BP is below 130\/80\./);
	});
});
