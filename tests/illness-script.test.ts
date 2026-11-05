/**
 * Illness scripts, the pure side (medical fork, Review mode): what a draft may
 * cite, how a script is judged out of date, and how it renders into a note.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GraphChain, GraphNode } from "../src/core/contracts.ts";
import { SCRIPT_SECTIONS, type IllnessScript, type ScriptSection } from "../src/core/contracts.ts";
import {
	buildBasis,
	collectSources,
	fingerprint,
	illnessTerms,
	mechanismMap,
	newSeenSources,
	renderScriptNote,
	scriptFreshness,
	scriptSlug,
	scriptStem,
	seenPageKey,
	validateDraft,
	type RawScriptDraft,
	type SeenSources,
} from "../src/core/illness-script.ts";
import { MY_NOTES_MARKER, joinMyNotes, readManagedHeader } from "../src/core/obsidian.ts";

const node = (id: string, name: string, over: Partial<GraphNode> = {}): GraphNode => ({
	id,
	name,
	statement: `${name} is true.`,
	aliases: [],
	createdAt: "2026-10-01T00:00:00.000Z",
	provenance: [],
	...over,
});
const chain = (id: string, premises: string[], conclusion: string): GraphChain => ({ id, premises, conclusion, provenance: [], createdAt: "2026-10-01T00:00:00.000Z" });

function seen(): SeenSources {
	const s = newSeenSources();
	s.nodes.set("n_amy", { id: "n_amy", name: "Amylase rises" });
	s.nodes.set("n_gall", { id: "n_gall", name: "Gallstones block the duct" });
	s.pages.set(seenPageKey("bk_lec", 12), { bookId: "bk_lec", title: "Pancreas lecture", kind: "slidescribe", page: 12 });
	s.pages.set(seenPageKey("bk_lec", 13), { bookId: "bk_lec", title: "Pancreas lecture", kind: "slidescribe", page: 13 });
	s.pages.set(seenPageKey("bk_hb", 801), { bookId: "bk_hb", title: "Harrison", kind: "pdf", page: 801 });
	s.expert.set("vi_1", { id: "vi_1", date: "2026-11-02", prompt: "Initial fluid management in acute pancreatitis" });
	return s;
}

/** A complete, valid draft: every section has at least a sourced claim. */
function draft(over: Partial<RawScriptDraft> = {}): RawScriptDraft {
	return {
		title: "Acute pancreatitis",
		sections: SCRIPT_SECTIONS.map((s) => ({
			id: s.id,
			claims: [{ text: `${s.title} claim.`, graph: ["n_amy"], ...(s.id === "management" ? { library: [{ book: "Pancreas lecture", page: 12 }] } : {}) }],
		})),
		...over,
	};
}

describe("slugs and fingerprints", () => {
	it("gives one slug to one illness however it is typed", () => {
		assert.equal(scriptSlug("Acute Pancreatitis"), "acute-pancreatitis");
		assert.equal(scriptSlug("  acute   pancreatitis! "), "acute-pancreatitis");
		assert.equal(scriptSlug("Crohn’s disease"), "crohn-s-disease");
		assert.equal(scriptSlug("???"), "");
		assert.ok(scriptSlug("x".repeat(200)).length <= 64);
	});

	it("fingerprints are stable and tell texts apart", () => {
		assert.equal(fingerprint("a"), fingerprint("a"));
		assert.notEqual(fingerprint("a"), fingerprint("b"));
		assert.equal(fingerprint("a").length, 16);
	});
});

describe("validating a draft", () => {
	it("accepts a complete draft whose citations were all shown to the writer", () => {
		const r = validateDraft(draft(), seen());
		assert.ok(r.ok, r.ok ? "" : r.problems.join("\n"));
		assert.deepEqual(r.draft.sections.map((s) => s.id), SCRIPT_SECTIONS.map((s) => s.id));
		const mgmt = r.draft.sections.find((s) => s.id === "management")!.claims[0]!;
		assert.equal(mgmt.changing, true, "management is always the changing tier");
		assert.deepEqual(mgmt.sources.map((x) => x.type).sort(), ["graph", "library"]);
		const lib = mgmt.sources.find((x) => x.type === "library")!;
		assert.equal(lib.type === "library" && lib.label, "Pancreas lecture, slide 12");
	});

	it("refuses a citation to a node, page or answer that was never shown", () => {
		const d = draft();
		d.sections[0]!.claims![0] = { text: "Defined.", graph: ["n_made_up"] };
		d.sections[1]!.claims![0] = { text: "Who.", library: [{ book: "Pancreas lecture", page: 99 }] };
		d.sections[2]!.claims![0] = { text: "Path.", expert: ["vi_999"] };
		d.sections[3]!.claims![0] = { text: "Presentation.", library: [{ book: "Imaginary textbook", page: 3 }] };
		const r = validateDraft(d, seen());
		assert.ok(!r.ok);
		const text = r.problems.join("\n");
		assert.match(text, /graph source "n_made_up" was not returned/);
		assert.match(text, /"Pancreas lecture" page 99 was not shown/);
		assert.match(text, /Expert AI answer "vi_999" was not returned/);
		assert.match(text, /"Imaginary textbook" page 3 was not shown/);
	});

	it("accepts a node cited by its exact name when the name is unique", () => {
		const d = draft();
		d.sections[0]!.claims![0] = { text: "Defined.", graph: ["Amylase rises"] };
		const r = validateDraft(d, seen());
		assert.ok(r.ok);
		assert.deepEqual(r.draft.nodeIds, ["n_amy"]);
	});

	it("requires a source for every claim, or an explicit general-knowledge mark on settled science only", () => {
		const d = draft();
		d.sections[0]!.claims![0] = { text: "No source at all." };
		let r = validateDraft(d, seen());
		assert.ok(!r.ok && /cites no source/.test(r.problems.join()));

		d.sections[0]!.claims![0] = { text: "Plain textbook science.", general: true };
		r = validateDraft(d, seen());
		assert.ok(r.ok);
		assert.equal(r.draft.sections[0]!.claims[0]!.general, true);

		d.sections[0]!.claims![0] = { text: "The dose is 5 mg.", general: true, changing: true };
		r = validateDraft(d, seen());
		assert.ok(!r.ok && /changing-tier/.test(r.problems.join()));

		d.sections[0]!.claims![0] = { text: "Defined.", graph: ["n_amy"] };
		d.sections[6]!.claims![0] = { text: "Give fluids.", general: true };
		r = validateDraft(d, seen());
		assert.ok(!r.ok, "management can never rest on general knowledge");
	});

	it("demands all nine sections, and a gap note where a section has nothing", () => {
		const d = draft();
		d.sections = d.sections.filter((s) => s.id !== "pearls");
		let r = validateDraft(d, seen());
		assert.ok(!r.ok && /section "pearls" is missing/.test(r.problems.join()));

		const empty = draft();
		empty.sections[1] = { id: "who", claims: [] };
		r = validateDraft(empty, seen());
		assert.ok(!r.ok && /section "who" has no claims and no gaps/.test(r.problems.join()));

		const gap = draft();
		gap.sections[1] = { id: "who", claims: [], gaps: ["Your sources give no incidence figures."] };
		r = validateDraft(gap, seen());
		assert.ok(r.ok);
		assert.deepEqual(r.draft.sections[1]!.gaps, ["Your sources give no incidence figures."]);
	});

	it("takes images only from pages it read and limits diagrams", () => {
		const d = draft();
		d.sections[2]!.images = [{ book: "Pancreas lecture", page: 12, caption: "The cascade" }];
		d.sections[2]!.diagrams = [{ brief: "Draw the cascade", caption: "Cascade" }];
		let r = validateDraft(d, seen());
		assert.ok(r.ok);
		assert.deepEqual(r.draft.pageImages.map((i) => [i.bookId, i.page, i.label]), [["bk_lec", 12, "Pancreas lecture, slide 12"]]);
		assert.equal(r.draft.diagrams.length, 1);

		d.sections[2]!.images = [{ book: "Pancreas lecture", page: 40, caption: "Not read" }];
		r = validateDraft(d, seen());
		assert.ok(!r.ok && /not a page you were shown/.test(r.problems.join()));

		d.sections[2]!.images = [];
		d.sections[2]!.diagrams = [1, 2, 3].map((n) => ({ brief: `b${n}`, caption: "c" }));
		r = validateDraft(d, seen());
		assert.ok(!r.ok && /too many diagrams/.test(r.problems.join()));
	});

	it("collects the books and answers a script rests on", () => {
		const d = draft();
		d.sections[6]!.claims![0] = { text: "Fluids.", expert: ["vi_1"], library: [{ book: "Harrison", page: 801 }] };
		d.sections[0]!.claims![0] = { text: "Defined.", library: [{ book: "Pancreas lecture", page: 12 }] };
		const r = validateDraft(d, seen());
		assert.ok(r.ok);
		const sources = collectSources(r.draft.sections, seen());
		assert.deepEqual(sources.library.map((l) => [l.label, l.pages]).sort(), [["Harrison", [801]], ["Pancreas lecture", [12]]]);
		assert.deepEqual(sources.expert, [{ id: "vi_1", date: "2026-11-02", prompt: "Initial fluid management in acute pancreatitis" }]);
	});
});

function script(over: Partial<IllnessScript> = {}): IllnessScript {
	const sections: ScriptSection[] = SCRIPT_SECTIONS.map((s) => ({ id: s.id, claims: [], gaps: [], images: [] }));
	const nodes = [node("n_amy", "Amylase rises"), node("n_gall", "Gallstones block the duct")];
	return {
		slug: "acute-pancreatitis",
		title: "Acute pancreatitis",
		aliases: ["Pancreatitis, acute"],
		systems: ["gi"],
		generatedAt: "2026-11-05T08:00:00.000Z",
		sections,
		basis: buildBasis(["n_amy", "n_gall"], { nodes, chains: [chain("arg_1", ["n_gall"], "n_amy")] }, illnessTerms("Acute pancreatitis", ["Pancreatitis, acute"])),
		sources: { library: [], expert: [] },
		usage: { calls: 3, inputTokens: 100, outputTokens: 50 },
		...over,
	};
}

describe("knowing a script is out of date", () => {
	const nodes = [node("n_amy", "Amylase rises"), node("n_gall", "Gallstones block the duct")];
	const chains = [chain("arg_1", ["n_gall"], "n_amy")];
	const s = script();

	it("is current while the graph is as it was", () => {
		const f = scriptFreshness(s, { nodes, chains });
		assert.equal(f.freshness, "current");
		assert.deepEqual(f.reasons, []);
	});

	it("is not disturbed by unrelated nodes, or by a node's aliases growing", () => {
		const unrelated = node("n_x", "Insulin binds its receptor", { createdAt: "2026-11-06T00:00:00.000Z" });
		const grown = node("n_amy", "Amylase rises", { aliases: ["a new wording"] });
		assert.equal(scriptFreshness(s, { nodes: [grown, nodes[1]!, unrelated], chains }).freshness, "current");
	});

	it("goes out of date when a node it was built from changes or is removed", () => {
		const edited = node("n_amy", "Amylase rises", { statement: "Serum amylase rises above three times normal." });
		const f = scriptFreshness(s, { nodes: [edited, nodes[1]!], chains });
		assert.equal(f.freshness, "outdated");
		assert.equal(f.changed, 1);
		assert.match(f.reasons[0]!, /1 note it was built from changed/);

		const gone = scriptFreshness(s, { nodes: [nodes[0]!], chains: [] });
		assert.equal(gone.removed, 1);
		assert.match(gone.reasons.join(), /was removed/);
	});

	it("goes out of date when a new related node appears: by name, or by a connection to its nodes", () => {
		const byName = node("n_new1", "Pancreatitis severity scores", { createdAt: "2026-11-06T00:00:00.000Z", statement: "Acute pancreatitis severity is scored." });
		assert.equal(scriptFreshness(s, { nodes: [...nodes, byName], chains }).added, 1);
		const linked = node("n_new2", "Hypocalcaemia", { createdAt: "2026-11-06T00:00:00.000Z" });
		const f = scriptFreshness(s, { nodes: [...nodes, linked], chains: [...chains, chain("arg_9", ["n_amy"], "n_new2")] });
		assert.equal(f.freshness, "outdated");
		assert.equal(f.added, 1);
		assert.ok(f.connectionsChanged);
	});

	it("goes out of date when the connections among its nodes change", () => {
		const f = scriptFreshness(s, { nodes, chains: [] });
		assert.equal(f.freshness, "outdated");
		assert.ok(f.connectionsChanged);
	});
});

describe("rendering the script note", () => {
	const nodes = [node("n_amy", "Amylase rises"), node("n_gall", "Gallstones block the duct")];
	const chains = [chain("arg_1", ["n_gall"], "n_amy")];
	const stems = new Map([["n_amy", "Amylase rises"], ["n_gall", "Gallstones block the duct"]]);
	const nodesById = new Map(nodes.map((n) => [n.id, n]));
	const ctx = { stems, nodesById, chains, freshness: scriptFreshness(script(), { nodes, chains }) };

	function full(): IllnessScript {
		const s = script();
		const def = s.sections.find((x) => x.id === "definition")!;
		def.claims = [
			{ text: "Acute pancreatitis is acute inflammation of the pancreas.", sources: [{ type: "graph", nodeId: "n_amy" }], general: false, changing: false, bullet: false },
			{ text: "It is a clinical diagnosis supported by a lipase result.", sources: [{ type: "library", bookId: "bk_lec", page: 12, label: "Pancreas lecture, slide 12" }], general: false, changing: false, bullet: false },
		];
		const path = s.sections.find((x) => x.id === "pathophysiology")!;
		path.claims = [{ text: "Trypsinogen activates inside the gland.", sources: [], general: true, changing: false, bullet: false }];
		path.images = [{ kind: "page", file: "acute-pancreatitis--bk_lec-p12.png", caption: "The activation cascade", source: { bookId: "bk_lec", page: 12, label: "Pancreas lecture, slide 12" } }];
		const mgmt = s.sections.find((x) => x.id === "management")!;
		mgmt.claims = [
			{ text: "Give early aggressive fluids.", sources: [{ type: "expert", id: "vi_1", date: "2026-11-02" }], general: false, changing: true, bullet: true },
			{ text: "Analgesia is first.", sources: [{ type: "graph", nodeId: "n_gall" }], general: false, changing: true, bullet: true },
		];
		mgmt.gaps = ["Your sources give no timing for feeding."];
		s.sources = { library: [{ bookId: "bk_lec", label: "Pancreas lecture", pages: [12] }], expert: [{ id: "vi_1", date: "2026-11-02", prompt: "Initial fluid management in acute pancreatitis" }] };
		return s;
	}

	it("writes the sections in illness-script order with its own frontmatter marker", () => {
		const note = renderScriptNote(full(), ctx);
		assert.deepEqual(readManagedHeader(note.content), { kind: "script", id: "acute-pancreatitis" });
		assert.equal(note.path, `Illness scripts/${scriptStem("Acute pancreatitis")}.md`);
		const headings = [...note.content.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
		assert.deepEqual(headings, ["Definition", "Pathophysiology", "Management", "Sources"]);
		assert.match(note.content, /^# Acute pancreatitis$/m);
		assert.match(note.content, /tags:\n {2}- illness-script\n {2}- system\/gi\n/);
		assert.match(note.content, /aliases:\n {2}- "Pancreatitis, acute"\n/);
	});

	it("cites each fact where it came from: graph notes as links, pages by name, answers by date", () => {
		const text = renderScriptNote(full(), ctx).content;
		assert.match(text, /acute inflammation of the pancreas\. \(\[\[Amylase rises\]\]\)/);
		assert.match(text, /lipase result\. \(Pancreas lecture, slide 12\)/);
		assert.match(text, /- Give early aggressive fluids\. \(UpToDate Expert AI, 2026-11-02\)/);
	});

	it("marks unsourced management as unverified and general knowledge as such", () => {
		const text = renderScriptNote(full(), ctx).content;
		assert.match(text, /- Analgesia is first\. \(\[\[Gallstones block the duct\]\]; \*unverified: no guideline, book page or Expert AI answer was read for this\*\)/);
		assert.match(text, /Trypsinogen activates inside the gland\. \(\*general knowledge, not from your sources\*\)/);
		assert.doesNotMatch(text, /Give early aggressive fluids\. \([^)]*unverified/);
	});

	it("embeds images with Obsidian syntax and a source caption, and shows gaps as a callout", () => {
		const text = renderScriptNote(full(), ctx).content;
		assert.match(text, /!\[\[acute-pancreatitis--bk_lec-p12\.png\|560\]\]\n\*The activation cascade — Pancreas lecture, slide 12\*/);
		assert.match(text, /> \[!question\] Not in your sources\n> - Your sources give no timing for feeding\./);
	});

	it("draws a mechanism map from the learner's own connections, and lists sources", () => {
		const text = renderScriptNote(full(), ctx).content;
		assert.match(text, /```mermaid\nflowchart TD\n {2}n1\["Amylase rises"\]\n {2}n2\["Gallstones block the duct"\]\n {2}n2 --> n1\n```/);
		assert.match(text, /\*\*Graph notes:\*\* \[\[Amylase rises\]\], \[\[Gallstones block the duct\]\]/);
		assert.match(text, /- Pancreas lecture: page 12/);
		assert.match(text, /- 2026-11-02: Initial fluid management/);
		assert.equal(mechanismMap(script(), { nodesById, chains: [] }), null);
	});

	it("says it is out of date when the graph has moved on", () => {
		const outdated = scriptFreshness(full(), { nodes: [nodes[0]!], chains: [] });
		const text = renderScriptNote(full(), { ...ctx, freshness: outdated }).content;
		assert.match(text, /> \[!warning\] Out of date\n> Your graph has changed since this script was written: /);
		assert.doesNotMatch(renderScriptNote(full(), ctx).content, /Out of date/);
	});

	it("names a deleted node without linking to it", () => {
		const s = full();
		const text = renderScriptNote(s, { ...ctx, nodesById: new Map([["n_amy", nodes[0]!]]), stems: new Map([["n_amy", "Amylase rises"]]) }).content;
		assert.match(text, /Gallstones block the duct \(removed from the graph\)/);
		assert.doesNotMatch(text, /\[\[Gallstones/);
	});

	it("leaves the learner's own notes to the reconciler: the rendered note has no My notes yet", () => {
		const note = renderScriptNote(full(), ctx);
		assert.ok(!note.content.includes(MY_NOTES_MARKER));
		assert.ok(joinMyNotes(note.content, null).includes(MY_NOTES_MARKER));
	});
});
