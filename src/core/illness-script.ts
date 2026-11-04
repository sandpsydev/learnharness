/**
 * ILLNESS SCRIPTS — pure core (medical fork, Review mode).
 *
 * An illness script is one long review note per condition, in the order a
 * clinician thinks about it: definition, who gets it, pathophysiology,
 * presentation, differentials, investigations, management, complications and
 * prognosis, high-yield pearls. The scriptwriter agent (agent/subagents/
 * scriptwriter.ts) drafts it; THIS module decides what is allowed to stand:
 *
 *   validateDraft   every claim must name a source the agent actually read in
 *                   this run (a graph node, a library page, an Expert AI
 *                   answer). An unknown citation is refused, so a citation
 *                   can never be invented. Management content that rests on
 *                   no library page or Expert AI answer is rendered as
 *                   "unverified"; settled science from general knowledge is
 *                   allowed only when plainly marked.
 *   scriptFreshness compares the graph now with what the script was built
 *                   from, so a script can say it is out of date.
 *   renderScriptNote turns the stored script into Markdown for the vault.
 *
 * No IO, no model calls, no node builtins.
 */

import type { GraphChain, GraphNode, OrganSystem } from "./contracts/graph.ts";
import type { LibraryBookKind } from "./contracts/library.ts";
import {
	SCRIPT_SECTIONS,
	isScriptSectionId,
	type IllnessScript,
	type ScriptBasis,
	type ScriptClaim,
	type ScriptFreshness,
	type ScriptImage,
	type ScriptSection,
	type ScriptSectionId,
	type ScriptSourceRef,
} from "./contracts/review.ts";
import { citationFor } from "./library.ts";
import { frontmatter, joinMyNotes, safeFileStem, SCRIPTS_DIR, wikilink, type DesiredNote } from "./obsidian.ts";

// ─── identity and fingerprints ───────────────────────────────────────────────

/** The stable key of an illness: the same words in any case or punctuation give the same slug. */
export function scriptSlug(title: string): string {
	const slug = title
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64)
		.replace(/-+$/g, "");
	return slug;
}

/** A small, fast, non-cryptographic fingerprint (two FNV-1a passes → 16 hex). */
export function fingerprint(text: string): string {
	let a = 0x811c9dc5;
	let b = 0x01000193 ^ text.length;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		a = Math.imul(a ^ c, 0x01000193) >>> 0;
		b = Math.imul(b ^ c ^ (i & 0xff), 0x85ebca6b) >>> 0;
	}
	return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** What a script depends on in a node: its words and its tags (not its aliases — those grow on every re-encounter). */
export function nodeFingerprint(node: Pick<GraphNode, "name" | "statement" | "systems" | "factType">): string {
	return fingerprint([node.name, node.statement, (node.systems ?? []).join(","), node.factType ?? ""].join("\u0001"));
}

/** The connections that touch any of `ids`, as one fingerprint. */
export function chainsFingerprint(ids: ReadonlySet<string>, chains: readonly GraphChain[]): string {
	const touching = chains
		.filter((c) => ids.has(c.conclusion) || c.premises.some((p) => ids.has(p)))
		.map((c) => c.id)
		.sort();
	return fingerprint(touching.join(","));
}

/** The graph as a whole, for the illness list's "built from this graph" check. */
export function graphFingerprint(nodes: readonly GraphNode[]): string {
	return fingerprint(
		nodes
			.map((n) => `${n.id}:${nodeFingerprint(n)}`)
			.sort()
			.join("|"),
	);
}

/** Words that name an illness, lowercase, for spotting new related nodes. */
export function illnessTerms(title: string, aliases: readonly string[] = []): string[] {
	const terms = new Set<string>();
	for (const t of [title, ...aliases]) {
		const term = t.toLowerCase().replace(/\s+/g, " ").trim();
		if (term.length >= 4) terms.add(term);
	}
	return [...terms];
}

export function buildBasis(
	nodeIds: Iterable<string>,
	graph: { nodes: readonly GraphNode[]; chains: readonly GraphChain[] },
	terms: string[],
): ScriptBasis {
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const nodes: Record<string, string> = {};
	const names: Record<string, string> = {};
	const ids = new Set<string>();
	for (const id of nodeIds) {
		const node = byId.get(id);
		if (!node) continue;
		nodes[id] = nodeFingerprint(node);
		names[id] = node.name;
		ids.add(id);
	}
	return { nodes, names, chainsFp: chainsFingerprint(ids, graph.chains), terms };
}

// ─── freshness ───────────────────────────────────────────────────────────────

export interface Freshness {
	freshness: ScriptFreshness;
	reasons: string[];
	changed: number;
	removed: number;
	added: number;
	connectionsChanged: boolean;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Is the script still a fair picture of the graph? Nodes it was built from
 *  that changed or vanished, connections that touch them, and nodes born
 *  after it that are plainly about the same illness all make it out of date. */
export function scriptFreshness(script: Pick<IllnessScript, "generatedAt" | "basis">, graph: { nodes: readonly GraphNode[]; chains: readonly GraphChain[] }): Freshness {
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const known = new Set(Object.keys(script.basis.nodes));
	let changed = 0;
	let removed = 0;
	for (const [id, fp] of Object.entries(script.basis.nodes)) {
		const node = byId.get(id);
		if (!node) removed++;
		else if (nodeFingerprint(node) !== fp) changed++;
	}
	const liveKnown = new Set([...known].filter((id) => byId.has(id)));
	const connectionsChanged = chainsFingerprint(known, graph.chains) !== script.basis.chainsFp && removed === 0;

	let added = 0;
	if (script.basis.terms.length > 0 || known.size > 0) {
		const adjacent = new Set<string>();
		for (const c of graph.chains) {
			const members = [c.conclusion, ...c.premises];
			if (members.some((m) => liveKnown.has(m))) for (const m of members) adjacent.add(m);
		}
		for (const node of graph.nodes) {
			if (known.has(node.id) || node.createdAt <= script.generatedAt) continue;
			const text = `${node.name} ${node.statement}`.toLowerCase();
			if (adjacent.has(node.id) || script.basis.terms.some((t) => text.includes(t))) added++;
		}
	}

	const reasons: string[] = [];
	if (changed > 0) reasons.push(`${plural(changed, "note", "notes")} it was built from changed`);
	if (removed > 0) reasons.push(`${plural(removed, "note", "notes")} it was built from ${removed === 1 ? "was" : "were"} removed`);
	if (added > 0) reasons.push(`${plural(added, "new related note", "new related notes")} in the graph`);
	if (connectionsChanged) reasons.push("the connections between its notes changed");
	return {
		freshness: reasons.length === 0 ? "current" : "outdated",
		reasons,
		changed,
		removed,
		added,
		connectionsChanged,
	};
}

// ─── the draft the agent submits ─────────────────────────────────────────────

export interface RawClaim {
	text: string;
	bullet?: boolean;
	changing?: boolean;
	general?: boolean;
	graph?: string[];
	library?: Array<{ book: string; page: number }>;
	expert?: string[];
}

export interface RawSection {
	id: string;
	claims?: RawClaim[];
	gaps?: string[];
	images?: Array<{ book: string; page: number; caption: string }>;
	diagrams?: Array<{ brief: string; caption: string }>;
}

export interface RawScriptDraft {
	title: string;
	aliases?: string[];
	sections: RawSection[];
}

export interface SeenPage {
	bookId: string;
	title: string;
	kind: LibraryBookKind;
	page: number;
}

/** Everything the agent has actually been shown in this run. A citation is valid only if it is in here. */
export interface SeenSources {
	nodes: Map<string, { id: string; name: string }>;
	pages: Map<string, SeenPage>;
	expert: Map<string, { id: string; date: string; prompt: string }>;
}

export const newSeenSources = (): SeenSources => ({ nodes: new Map(), pages: new Map(), expert: new Map() });

export const seenPageKey = (bookId: string, page: number): string => `${bookId}:${page}`;

export const SCRIPT_LIMITS = {
	titleChars: 120,
	claimChars: 1400,
	claims: 220,
	gapChars: 400,
	gapsPerSection: 8,
	captionChars: 200,
	pageImages: 10,
	diagrams: 2,
	briefChars: 1200,
} as const;

export interface ImageRequest {
	sectionId: ScriptSectionId;
	bookId: string;
	page: number;
	label: string;
	caption: string;
}

export interface DiagramRequest {
	sectionId: ScriptSectionId;
	brief: string;
	caption: string;
}

export interface ValidatedDraft {
	title: string;
	aliases: string[];
	sections: ScriptSection[];
	pageImages: ImageRequest[];
	diagrams: DiagramRequest[];
	/** Graph nodes cited anywhere. */
	nodeIds: string[];
}

const clean = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Check a draft against what the agent saw. Returns the cleaned script parts or the full list of problems. */
export function validateDraft(raw: RawScriptDraft, seen: SeenSources): { ok: true; draft: ValidatedDraft } | { ok: false; problems: string[] } {
	const problems: string[] = [];
	const problem = (p: string): void => {
		if (problems.length < 14) problems.push(p);
	};

	const title = clean(raw.title ?? "");
	if (title === "") problem("title is empty.");
	else if (title.length > SCRIPT_LIMITS.titleChars) problem(`title is longer than ${SCRIPT_LIMITS.titleChars} characters.`);

	const nodeByName = new Map<string, string[]>();
	for (const n of seen.nodes.values()) {
		const key = n.name.toLowerCase();
		nodeByName.set(key, [...(nodeByName.get(key) ?? []), n.id]);
	}
	const pagesByTitle = (t: string): SeenPage[] => [...seen.pages.values()].filter((p) => p.title.toLowerCase() === t.trim().toLowerCase());

	const sections = new Map<ScriptSectionId, ScriptSection>();
	const pageImages: ImageRequest[] = [];
	const diagrams: DiagramRequest[] = [];
	const nodeIds = new Set<string>();
	let claimCount = 0;

	for (const rs of raw.sections ?? []) {
		if (!isScriptSectionId(rs.id)) {
			problem(`unknown section "${rs.id}". Use exactly: ${SCRIPT_SECTIONS.map((s) => s.id).join(", ")}.`);
			continue;
		}
		if (sections.has(rs.id)) {
			problem(`section "${rs.id}" appears twice.`);
			continue;
		}
		const claims: ScriptClaim[] = [];
		const forceChanging = rs.id === "management";
		for (const rc of rs.claims ?? []) {
			claimCount++;
			const text = clean(rc.text ?? "");
			const where = `${rs.id}: "${text.slice(0, 50)}${text.length > 50 ? "…" : ""}"`;
			if (text === "") {
				problem(`${rs.id}: a claim has no text.`);
				continue;
			}
			if (text.length > SCRIPT_LIMITS.claimChars) {
				problem(`${where} is longer than ${SCRIPT_LIMITS.claimChars} characters — split it.`);
				continue;
			}
			const sources: ScriptSourceRef[] = [];
			for (const ref of rc.graph ?? []) {
				const id = seen.nodes.has(ref) ? ref : nodeByName.get(ref.trim().toLowerCase())?.length === 1 ? nodeByName.get(ref.trim().toLowerCase())![0]! : undefined;
				if (id === undefined) {
					problem(`${where}: graph source "${ref}" was not returned by any graph tool in this run. Cite a node id from find_nodes / get_node.`);
					continue;
				}
				nodeIds.add(id);
				if (!sources.some((s) => s.type === "graph" && s.nodeId === id)) sources.push({ type: "graph", nodeId: id });
			}
			for (const ref of rc.library ?? []) {
				const matches = pagesByTitle(ref.book).filter((p) => p.page === ref.page);
				const hit = matches[0];
				if (!hit) {
					const shown = [...new Set(pagesByTitle(ref.book).map((p) => p.page))].sort((a, b) => a - b).slice(0, 12);
					problem(
						`${where}: library source "${ref.book}" page ${ref.page} was not shown to you in this run` +
							(shown.length > 0 ? ` (pages of that book you saw: ${shown.join(", ")}).` : `. Cite only books and pages that library_search or library_read returned.`),
					);
					continue;
				}
				const label = citationFor({ kind: hit.kind, title: hit.title }, hit.page);
				if (!sources.some((s) => s.type === "library" && s.bookId === hit.bookId && s.page === hit.page)) {
					sources.push({ type: "library", bookId: hit.bookId, page: hit.page, label });
				}
			}
			for (const id of rc.expert ?? []) {
				const answer = seen.expert.get(id);
				if (!answer) {
					problem(`${where}: Expert AI answer "${id}" was not returned by expert_search / expert_read in this run.`);
					continue;
				}
				if (!sources.some((s) => s.type === "expert" && s.id === id)) sources.push({ type: "expert", id, date: answer.date });
			}
			const changing = forceChanging || rc.changing === true;
			const general = sources.length === 0;
			if (general && rc.general !== true) {
				problem(`${where} cites no source. Cite what you read, or set general=true for settled science you are stating from general knowledge, or leave it out and add a gap.`);
				continue;
			}
			if (general && changing) {
				problem(`${where} is management or another changing-tier fact (drug, dose, threshold, schedule) with no source. Cite a library page or Expert AI answer, or cite the graph node and let it show as unverified, or list it as a gap.`);
				continue;
			}
			claims.push({ text, sources, general, changing, bullet: rc.bullet === true });
		}
		const gaps: string[] = [];
		for (const g of rs.gaps ?? []) {
			const gap = clean(g);
			if (gap === "") continue;
			if (gap.length > SCRIPT_LIMITS.gapChars) problem(`${rs.id}: a gap note is longer than ${SCRIPT_LIMITS.gapChars} characters.`);
			else gaps.push(gap);
		}
		if (gaps.length > SCRIPT_LIMITS.gapsPerSection) problem(`${rs.id}: at most ${SCRIPT_LIMITS.gapsPerSection} gap notes per section.`);
		if (claims.length === 0 && gaps.length === 0 && (rs.claims ?? []).length === 0) {
			problem(`section "${rs.id}" has no claims and no gaps. If your sources say nothing about it, add a gap note saying so.`);
		}
		for (const img of rs.images ?? []) {
			const caption = clean(img.caption ?? "");
			if (caption === "" || caption.length > SCRIPT_LIMITS.captionChars) {
				problem(`${rs.id}: every image needs a caption of at most ${SCRIPT_LIMITS.captionChars} characters.`);
				continue;
			}
			const hit = pagesByTitle(img.book).find((p) => p.page === img.page);
			if (!hit || img.page < 1) {
				problem(`${rs.id}: image "${img.book}" page ${img.page} is not a page you were shown in this run. Images come only from library pages you read.`);
				continue;
			}
			pageImages.push({ sectionId: rs.id, bookId: hit.bookId, page: hit.page, label: citationFor({ kind: hit.kind, title: hit.title }, hit.page), caption });
		}
		for (const d of rs.diagrams ?? []) {
			const brief = clean(d.brief ?? "");
			const caption = clean(d.caption ?? "");
			if (brief === "" || brief.length > SCRIPT_LIMITS.briefChars || caption === "" || caption.length > SCRIPT_LIMITS.captionChars) {
				problem(`${rs.id}: a diagram needs a brief (at most ${SCRIPT_LIMITS.briefChars} characters) and a caption.`);
				continue;
			}
			diagrams.push({ sectionId: rs.id, brief, caption });
		}
		sections.set(rs.id, { id: rs.id, claims, gaps, images: [] });
	}

	for (const s of SCRIPT_SECTIONS) {
		if (!sections.has(s.id)) problem(`section "${s.id}" is missing. All nine sections are required, in this set: ${SCRIPT_SECTIONS.map((x) => x.id).join(", ")}.`);
	}
	if (claimCount > SCRIPT_LIMITS.claims) problem(`too many claims (${claimCount}; at most ${SCRIPT_LIMITS.claims}).`);
	if (pageImages.length > SCRIPT_LIMITS.pageImages) problem(`too many page images (${pageImages.length}; at most ${SCRIPT_LIMITS.pageImages}).`);
	if (diagrams.length > SCRIPT_LIMITS.diagrams) problem(`too many diagrams (${diagrams.length}; at most ${SCRIPT_LIMITS.diagrams}).`);
	const total = [...sections.values()].reduce((n, s) => n + s.claims.length, 0);
	if (problems.length === 0 && total === 0) problem("the script has no claims at all.");
	if (problems.length > 0) return { ok: false, problems };

	const aliases = [...new Set((raw.aliases ?? []).map(clean).filter((a) => a !== "" && a.toLowerCase() !== title.toLowerCase()))].slice(0, 8);
	return {
		ok: true,
		draft: {
			title,
			aliases,
			sections: SCRIPT_SECTIONS.map((s) => sections.get(s.id)!),
			pageImages,
			diagrams,
			nodeIds: [...nodeIds],
		},
	};
}

/** Library books and Expert AI answers a script used, for its Sources list. */
export function collectSources(sections: readonly ScriptSection[], seen: SeenSources): IllnessScript["sources"] {
	const lib = new Map<string, { bookId: string; label: string; pages: Set<number> }>();
	const expert = new Map<string, { id: string; date: string; prompt: string }>();
	const addPage = (bookId: string, page: number): void => {
		const p = seen.pages.get(seenPageKey(bookId, page));
		if (!p) return;
		const entry = lib.get(bookId) ?? { bookId, label: p.title, pages: new Set<number>() };
		entry.pages.add(page);
		lib.set(bookId, entry);
	};
	for (const section of sections) {
		for (const claim of section.claims) {
			for (const s of claim.sources) {
				if (s.type === "library") addPage(s.bookId, s.page);
				if (s.type === "expert") {
					const a = seen.expert.get(s.id);
					if (a) expert.set(s.id, a);
				}
			}
		}
		for (const img of section.images) if (img.source) addPage(img.source.bookId, img.source.page);
	}
	return {
		library: [...lib.values()].map((l) => ({ bookId: l.bookId, label: l.label, pages: [...l.pages].sort((a, b) => a - b) })),
		expert: [...expert.values()],
	};
}

// ─── rendering ───────────────────────────────────────────────────────────────

export function scriptStem(title: string): string {
	return safeFileStem(`${title} (illness script)`, "Illness script");
}

export interface ScriptRenderContext {
	/** The file stem to use; defaults to the title-derived one (the caller makes it collision-proof). */
	stem?: string;
	/** node id → file stem, from the node-name plan */
	stems: ReadonlyMap<string, string>;
	nodesById: ReadonlyMap<string, GraphNode>;
	chains: readonly GraphChain[];
	freshness: Freshness;
}

function nodeCite(id: string, script: IllnessScript, ctx: ScriptRenderContext): string {
	const stem = ctx.stems.get(id);
	const node = ctx.nodesById.get(id);
	if (stem !== undefined && node !== undefined) return wikilink(stem, node.name);
	return `${script.basis.names[id] ?? "a removed note"} (removed from the graph)`;
}

function citeText(claim: ScriptClaim, script: IllnessScript, ctx: ScriptRenderContext): string {
	const parts = claim.sources.map((s) => {
		if (s.type === "graph") return nodeCite(s.nodeId, script, ctx);
		if (s.type === "library") return s.label;
		return `UpToDate Expert AI, ${s.date}`;
	});
	const flags: string[] = [];
	if (claim.general) flags.push("*general knowledge, not from your sources*");
	if (claim.changing && !claim.sources.some((s) => s.type === "library" || s.type === "expert")) {
		flags.push("*unverified: no guideline, book page or Expert AI answer was read for this*");
	}
	const inner = [...parts, ...flags].join("; ");
	return inner === "" ? "" : ` (${inner})`;
}

/** Running text and list items, in the order the writer gave them. */
function renderClaims(section: ScriptSection, script: IllnessScript, ctx: ScriptRenderContext): string[] {
	const out: string[] = [];
	let paragraph: string[] = [];
	const flush = (): void => {
		if (paragraph.length > 0) out.push(paragraph.join(" "), "");
		paragraph = [];
	};
	for (const claim of section.claims) {
		const piece = `${claim.text}${citeText(claim, script, ctx)}`;
		if (claim.bullet) {
			flush();
			out.push(`- ${piece}`);
		} else {
			if (out.length > 0 && out[out.length - 1]!.startsWith("- ")) out.push("");
			paragraph.push(piece);
		}
	}
	flush();
	return out;
}

const mermaidLabel = (s: string): string => clean(s).replace(/["[\]()<>{}|#&;]/g, "'").slice(0, 70);

/** The mechanism map: the learner's own connections among the notes the script is built from. */
export function mechanismMap(script: IllnessScript, ctx: Pick<ScriptRenderContext, "nodesById" | "chains">, maxEdges = 30): string | null {
	const ids = new Set(Object.keys(script.basis.nodes));
	const picked = ctx.chains
		.filter((c) => ids.has(c.conclusion) && c.premises.every((p) => ids.has(p)) && ctx.nodesById.has(c.conclusion) && c.premises.every((p) => ctx.nodesById.has(p)))
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
		.slice(0, maxEdges);
	if (picked.length === 0) return null;
	const alias = new Map<string, string>();
	const label = (id: string): string => {
		let a = alias.get(id);
		if (!a) {
			a = `n${alias.size + 1}`;
			alias.set(id, a);
		}
		return a;
	};
	const lines: string[] = ["flowchart TD"];
	const declared = new Set<string>();
	const declare = (id: string): string => {
		const a = label(id);
		if (!declared.has(a)) {
			declared.add(a);
			lines.push(`  ${a}["${mermaidLabel(ctx.nodesById.get(id)!.name)}"]`);
		}
		return a;
	};
	let joins = 0;
	for (const c of picked) {
		const to = declare(c.conclusion);
		if (c.premises.length === 1) {
			lines.push(`  ${declare(c.premises[0]!)} --> ${to}`);
		} else {
			const j = `j${++joins}`;
			lines.push(`  ${j}(( ))`);
			for (const p of c.premises) lines.push(`  ${declare(p)} --- ${j}`);
			lines.push(`  ${j} --> ${to}`);
		}
	}
	return lines.join("\n");
}

function imageLines(images: readonly ScriptImage[]): string[] {
	const out: string[] = [];
	for (const img of images) {
		out.push(`![[${img.file}|560]]`, `*${img.caption}${img.source ? ` — ${img.source.label}` : " — drawn by LearnHarness"}*`, "");
	}
	return out;
}

/** The generated part of a script's note (frontmatter included, the learner's area not). */
export function renderScriptNote(script: IllnessScript, ctx: ScriptRenderContext): DesiredNote {
	const systemTags = script.systems.map((s) => `system/${s}`);
	const lines: string[] = [
		frontmatter([
			["lh_managed", true],
			["lh_kind", "script"],
			["lh_id", script.slug],
			["aliases", script.aliases],
			["tags", ["illness-script", ...systemTags]],
			["lh_written", script.generatedAt.slice(0, 10)],
		]),
		"",
	];
	if (ctx.freshness.freshness === "outdated") {
		lines.push(
			"> [!warning] Out of date",
			`> Your graph has changed since this script was written: ${ctx.freshness.reasons.join("; ")}. Open LearnHarness → Review and refresh it. Your own notes at the bottom will be kept.`,
			"",
		);
	}
	lines.push(
		`# ${script.title}`,
		"",
		`*Illness script written ${script.generatedAt.slice(0, 10)} from your graph notes, your library and Expert AI answers. Each statement names where it came from.*`,
		"",
	);
	const stats = (s: ScriptSection): boolean => s.claims.length > 0 || s.gaps.length > 0 || s.images.length > 0;
	const map = mechanismMap(script, ctx);
	for (const def of SCRIPT_SECTIONS) {
		const section = script.sections.find((s) => s.id === def.id);
		if (!section || !stats(section)) continue;
		lines.push(`## ${def.title}`, "", ...renderClaims(section, script, ctx));
		if (def.id === "pathophysiology" && map) {
			lines.push("```mermaid", map, "```", "*Mechanism map: how your own graph connects these notes.*", "");
		}
		lines.push(...imageLines(section.images));
		if (section.gaps.length > 0) {
			lines.push("> [!question] Not in your sources", ...section.gaps.map((g) => `> - ${g}`), "");
		}
	}

	lines.push("## Sources", "");
	const graphIds = new Set<string>();
	for (const s of script.sections) for (const c of s.claims) for (const src of c.sources) if (src.type === "graph") graphIds.add(src.nodeId);
	if (graphIds.size > 0) {
		lines.push("**Graph notes:** " + [...graphIds].map((id) => nodeCite(id, script, ctx)).join(", "), "");
	}
	if (script.sources.library.length > 0) {
		lines.push("**Library:**", ...script.sources.library.map((l) => `- ${l.label}: page${l.pages.length === 1 ? "" : "s"} ${l.pages.join(", ")}`), "");
	}
	if (script.sources.expert.length > 0) {
		lines.push(
			"**UpToDate Expert AI answers:**",
			...script.sources.expert.map((e) => `- ${e.date}: ${clean(e.prompt).slice(0, 160)}${e.prompt.length > 160 ? "…" : ""}`),
			"",
		);
	}
	lines.push(
		"*Marks: \"unverified\" means a management fact was not backed by a guideline, book page or Expert AI answer that was read; \"general knowledge\" means settled science stated without one of your sources.*",
	);
	const stem = ctx.stem ?? scriptStem(script.title);
	return { kind: "script", id: script.slug, path: `${SCRIPTS_DIR}/${stem}.md`, content: lines.join("\n") };
}

/** A finished note as it would sit in the vault when the learner has written nothing yet. */
export const withEmptyMyNotes = (note: DesiredNote): string => joinMyNotes(note.content, null);

/** Systems a script spans, from the nodes it cites (most common first). */
export function systemsOf(nodeIds: Iterable<string>, nodesById: ReadonlyMap<string, GraphNode>): OrganSystem[] {
	const counts = new Map<OrganSystem, number>();
	for (const id of nodeIds) for (const s of nodesById.get(id)?.systems ?? []) counts.set(s, (counts.get(s) ?? 0) + 1);
	return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s]) => s).slice(0, 3);
}
