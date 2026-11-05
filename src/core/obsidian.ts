/**
 * THE OBSIDIAN COPY — pure core (medical fork, docs/medical-spec.md
 * "Obsidian copy and Review mode").
 *
 * LearnHarness stays the source of truth; this module turns the graph (and
 * the illness scripts) into the Markdown notes a vault holds, and decides —
 * as data, with no filesystem — what has to change on disk to make the vault
 * match. The filesystem itself sits behind `VaultPort` (src/store/obsidian-
 * vault.ts is the real one, confined to one app-owned folder); tests drive
 * the same reconciler with an in-memory vault.
 *
 * What the vault gets, all under ONE app-owned folder:
 *   Nodes/<name>.md              one note per proposition
 *   Systems/System - <x>.md      one index note per organ system
 *   Illness scripts/<x>.md       the Review-mode scripts (illness-script.ts)
 *   Attachments/<file>           images the scripts embed
 *
 * Rules the whole module obeys:
 *   - Every note the app writes carries `lh_managed: true`, `lh_kind` and
 *     `lh_id` in its frontmatter. Only such notes are ever rewritten, moved
 *     or removed; a file without them is the learner's and is left alone.
 *   - Everything below the My-notes marker is the learner's. It is carried
 *     over verbatim on every rewrite and on every move.
 *   - One-way: nothing here reads a vault edit back into the graph.
 */

import type { FactType, GraphChain, GraphNode } from "./contracts/graph.ts";
import { FACT_TYPES, ORGAN_SYSTEMS, factTypeLabel } from "./contracts/graph.ts";

// ─── layout ──────────────────────────────────────────────────────────────────

/** The one folder inside the vault the app may write to. */
export const OBSIDIAN_APP_FOLDER = "LearnHarness";
export const NODES_DIR = "Nodes";
export const SYSTEMS_DIR = "Systems";
export const SCRIPTS_DIR = "Illness scripts";
export const ASSETS_DIR = "Attachments";
/** Where a removed node's note goes when the learner had written in it. */
export const SALVAGE_DIR = "Removed nodes";

/** The marker line: the generated part of a note ends here, the learner's begins. */
export const MY_NOTES_MARKER = "%% LearnHarness: everything below this line is yours and is never overwritten. %%";
export const MY_NOTES_HEADING = "## My notes";
/** What a fresh note carries under the marker. */
export const DEFAULT_MY_NOTES = `${MY_NOTES_HEADING}\n\n`;

// ─── safe names ──────────────────────────────────────────────────────────────

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/** Characters a file system or an Obsidian link cannot carry; separators become a dash. */
const SEPARATORS = /[\\/:]+/g;
const FORBIDDEN = /[*?"<>|#^[\]]/g;
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** A file-name stem that is safe on macOS, Windows and Linux AND safe inside a
 *  [[wikilink]] (no `# ^ [ ] |`). Never empty, never hidden, never a reserved
 *  device name, at most `max` characters. */
export function safeFileStem(name: string, fallback = "Untitled", max = 90): string {
	let stem = name
		.normalize("NFC")
		.replace(CONTROL, " ")
		.replace(SEPARATORS, "-")
		.replace(FORBIDDEN, "")
		.replace(/\s+/g, " ")
		.trim();
	// No leading dots (hidden files; also blocks "." and ".."), no trailing dots/spaces (Windows).
	stem = stem.replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");
	const chars = [...stem];
	if (chars.length > max) stem = chars.slice(0, max).join("").replace(/[.\s]+$/, "");
	if (stem === "") return fallback;
	if (WINDOWS_RESERVED.test(stem)) stem = `${stem}_`;
	return stem;
}

/** Text safe to show inside a [[target|display]] link. */
export function linkDisplay(text: string): string {
	return text.replace(CONTROL, " ").replace(/[[\]|#^]/g, "").replace(/\s+/g, " ").trim();
}

/** `[[stem]]`, or `[[stem|display]]` when the shown text differs from the file name. */
export function wikilink(stem: string, display?: string): string {
	const shown = display === undefined ? stem : linkDisplay(display);
	return shown === "" || shown === stem ? `[[${stem}]]` : `[[${stem}|${shown}]]`;
}

/** Hands out collision-proof stems. Comparison is case-insensitive because the
 *  default macOS and Windows file systems are, and Obsidian resolves links
 *  without regard to case. */
export class StemRegistry {
	private readonly taken = new Set<string>();

	constructor(reservedLower: Iterable<string> = []) {
		for (const r of reservedLower) this.taken.add(r.toLowerCase());
	}

	/** The first free stem: `base`, else `base (idtail)`, else `base (idtail 2)`… */
	claim(base: string, idHint: string): string {
		const tail = idHint.replace(/[^a-z0-9]/gi, "").slice(-4) || "x";
		let candidate = base;
		let n = 1;
		while (this.taken.has(candidate.toLowerCase())) {
			n++;
			candidate = n === 2 ? `${base} (${tail})` : `${base} (${tail} ${n - 1})`;
		}
		this.taken.add(candidate.toLowerCase());
		return candidate;
	}
}

// ─── frontmatter ─────────────────────────────────────────────────────────────

export type NoteKind = "node" | "system" | "script";

const yamlString = (value: string): string => JSON.stringify(value);

/** A tiny YAML writer for exactly the shapes the app emits: scalar strings,
 *  booleans, and lists of strings. */
export function frontmatter(fields: Array<[string, string | boolean | string[] | undefined]>): string {
	const lines = ["---"];
	for (const [key, value] of fields) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			if (value.length === 0) continue;
			lines.push(`${key}:`);
			// Tags are plain YAML (Obsidian reads them unquoted); everything else is quoted.
			for (const item of value) lines.push(`  - ${key === "tags" ? item : yamlString(item)}`);
		} else if (typeof value === "boolean") {
			lines.push(`${key}: ${value}`);
		} else {
			lines.push(`${key}: ${yamlString(value)}`);
		}
	}
	lines.push("---");
	return lines.join("\n");
}

export interface ManagedHeader {
	kind: NoteKind;
	id: string;
}

/** The app's own marker out of a note's text: null for any note the app did not write. */
export function readManagedHeader(text: string): ManagedHeader | null {
	const src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
	if (!src.startsWith("---\n")) return null;
	const end = src.indexOf("\n---", 4);
	if (end === -1) return null;
	const fields: Record<string, string> = {};
	for (const line of src.slice(4, end).split("\n")) {
		const m = /^(lh_managed|lh_kind|lh_id):\s*(.*)$/.exec(line);
		if (!m) continue;
		const raw = m[2]!.trim();
		try {
			fields[m[1]!] = typeof JSON.parse(raw) === "string" ? (JSON.parse(raw) as string) : raw;
		} catch {
			fields[m[1]!] = raw;
		}
	}
	if (fields.lh_managed !== "true") return null;
	const kind = fields.lh_kind;
	const id = fields.lh_id;
	if ((kind !== "node" && kind !== "system" && kind !== "script") || !id) return null;
	return { kind, id };
}

export const noteKey = (kind: NoteKind, id: string): string => `${kind}:${id}`;

// ─── the My-notes area ───────────────────────────────────────────────────────

/** Split a note at the marker. `mine` is everything after the marker line
 *  (heading and the learner's text included), or null when there is no marker. */
export function splitMyNotes(text: string): { generated: string; mine: string | null } {
	const src = text.replace(/\r\n?/g, "\n");
	const at = src.indexOf(MY_NOTES_MARKER);
	if (at === -1) return { generated: src, mine: null };
	const afterMarker = src.slice(at + MY_NOTES_MARKER.length);
	// Drop the single newline that ends the marker line; keep the rest verbatim.
	return { generated: src.slice(0, at), mine: afterMarker.startsWith("\n") ? afterMarker.slice(1) : afterMarker };
}

/** The finished note: generated text, the marker, then the learner's area. */
export function joinMyNotes(generated: string, mine: string | null): string {
	return `${generated.trimEnd()}\n\n${MY_NOTES_MARKER}\n${mine ?? DEFAULT_MY_NOTES}`;
}

/** True when the learner has written anything under the marker (beyond the stock heading). */
export function hasUserNotes(mine: string | null): boolean {
	if (mine === null) return false;
	return mine.replace(MY_NOTES_HEADING, "").trim().length > 0;
}

// ─── the desired vault ───────────────────────────────────────────────────────

/** One note the vault should hold. `content` is the generated part only
 *  (frontmatter included); the learner's area is added at write time. */
export interface DesiredNote {
	kind: NoteKind;
	id: string;
	/** Path relative to the app folder, forward slashes. */
	path: string;
	content: string;
}

/** A file written once and never compared by content (images, diagrams). */
export interface DesiredAsset {
	path: string;
	/** Known without reading the file: the vault copy is current when its size matches. */
	size: number;
	bytes: () => Uint8Array;
}

export interface DesiredVault {
	notes: DesiredNote[];
	assets: DesiredAsset[];
}

/** Provenance the graph keeps for imported notes files: src id → file path. */
export type FileSources = Readonly<Record<string, string>>;

export interface NodeNamePlan {
	/** node id → file stem */
	stems: Map<string, string>;
	/** node id → relative path */
	paths: Map<string, string>;
}

/** Stems for every node, collision-proof and stable: the node that existed
 *  first keeps the plain name, later ones get an id-tail suffix. `reserved`
 *  holds stems that are already spoken for (index and script notes, files the
 *  learner put in the folder). */
export function planNodeNames(nodes: readonly GraphNode[], reserved: Iterable<string> = []): NodeNamePlan {
	const registry = new StemRegistry(reserved);
	const ordered = [...nodes].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
	const stems = new Map<string, string>();
	const paths = new Map<string, string>();
	for (const node of ordered) {
		const stem = registry.claim(safeFileStem(node.name, "Untitled node"), node.id);
		stems.set(node.id, stem);
		paths.set(node.id, `${NODES_DIR}/${stem}.md`);
	}
	return { stems, paths };
}

const SYSTEM_PREFIX = "System - ";
export const UNTAGGED_SYSTEM_ID = "untagged";

export function systemLabelOf(id: string): string {
	return id === UNTAGGED_SYSTEM_ID ? "Untagged" : (ORGAN_SYSTEMS.find((s) => s.id === id)?.label ?? id);
}

/** The stem of a system's index note. */
export function systemStem(id: string): string {
	return `${SYSTEM_PREFIX}${safeFileStem(systemLabelOf(id), id)}`;
}

/** Stems the index notes will use — reserved before node names are planned. */
export function systemStems(): string[] {
	return [...ORGAN_SYSTEMS.map((s) => s.id), UNTAGGED_SYSTEM_ID].map(systemStem);
}

/** A link target for an imported notes file: Markdown files link by name, anything else shows as text. */
function sourceLine(filePath: string): string {
	const base = filePath.split(/[\\/]/).pop() ?? filePath;
	if (/\.(md|markdown)$/i.test(base)) {
		const stem = safeFileStem(base.replace(/\.(md|markdown)$/i, ""), "Lecture note");
		return `- Lecture note: [[${stem}]]`;
	}
	return `- Imported file: ${linkDisplay(base)}`;
}

const clean = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Older wordings, as Obsidian aliases: not the name, not the statement, no repeats. */
export function aliasesOf(node: GraphNode): string[] {
	const skip = new Set([clean(node.name).toLowerCase(), clean(node.statement).toLowerCase()]);
	const out: string[] = [];
	for (const raw of node.aliases) {
		const alias = clean(raw);
		const key = alias.toLowerCase();
		if (alias === "" || skip.has(key)) continue;
		skip.add(key);
		out.push(alias);
	}
	return out;
}

export function nodeTags(node: Pick<GraphNode, "systems" | "factType">): string[] {
	return [
		...(node.systems ?? []).map((s) => `system/${s}`),
		...(node.factType ? [`fact/${node.factType}`] : []),
	];
}

export interface NodeNoteInput {
	node: GraphNode;
	stems: ReadonlyMap<string, string>;
	nodesById: ReadonlyMap<string, GraphNode>;
	chains: readonly GraphChain[];
	fileSources: FileSources;
}

function link(id: string, input: Pick<NodeNoteInput, "stems" | "nodesById">): string | null {
	const stem = input.stems.get(id);
	const node = input.nodesById.get(id);
	if (stem === undefined || node === undefined) return null;
	return wikilink(stem, node.name);
}

/** The generated part of one node's note. */
export function renderNodeNote(input: NodeNoteInput): string {
	const { node, chains } = input;
	const lines: string[] = [
		frontmatter([
			["lh_managed", true],
			["lh_kind", "node"],
			["lh_id", node.id],
			["aliases", aliasesOf(node)],
			["tags", nodeTags(node)],
		]),
		"",
		`# ${clean(node.name)}`,
		"",
		clean(node.statement),
	];

	const because: string[] = [];
	const leadsTo: string[] = [];
	for (const chain of chains) {
		if (chain.conclusion === node.id) {
			const premises = chain.premises.map((p) => link(p, input));
			if (premises.every((p) => p !== null)) because.push(`- ${premises.join(" + ")}`);
		} else if (chain.premises.includes(node.id)) {
			const conclusion = link(chain.conclusion, input);
			if (conclusion === null) continue;
			const others = chain.premises.filter((p) => p !== node.id).map((p) => link(p, input));
			if (others.some((o) => o === null)) continue;
			leadsTo.push(others.length > 0 ? `- ${conclusion} (together with ${others.join(" + ")})` : `- ${conclusion}`);
		}
	}
	if (because.length > 0) lines.push("", "## Because", "", ...because);
	if (leadsTo.length > 0) lines.push("", "## Leads to", "", ...leadsTo);

	const sources = new Set<string>();
	for (const point of node.provenance) {
		const file = input.fileSources[point.chatId];
		if (file !== undefined) sources.add(sourceLine(file));
	}
	if (sources.size > 0) lines.push("", "## Source", "", ...[...sources].sort());
	return lines.join("\n");
}

/** One index note per organ system that has nodes (plus "Untagged" when some node has no system). */
export function renderSystemNotes(
	nodes: readonly GraphNode[],
	stems: ReadonlyMap<string, string>,
): DesiredNote[] {
	const groups = new Map<string, GraphNode[]>();
	for (const node of nodes) {
		const systems = node.systems && node.systems.length > 0 ? node.systems : [UNTAGGED_SYSTEM_ID];
		for (const id of systems) groups.set(id, [...(groups.get(id) ?? []), node]);
	}
	const out: DesiredNote[] = [];
	for (const id of [...ORGAN_SYSTEMS.map((s) => s.id as string), UNTAGGED_SYSTEM_ID]) {
		const members = groups.get(id);
		if (!members || members.length === 0) continue;
		const stem = systemStem(id);
		const byName = (a: GraphNode, b: GraphNode) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
		const lines: string[] = [
			frontmatter([
				["lh_managed", true],
				["lh_kind", "system"],
				["lh_id", id],
				["tags", id === UNTAGGED_SYSTEM_ID ? ["lh-index"] : [`system/${id}`, "lh-index"]],
			]),
			"",
			`# ${systemLabelOf(id)}`,
			"",
			`${members.length} ${members.length === 1 ? "note" : "notes"} from your LearnHarness graph.`,
		];
		const typed: Array<[string, GraphNode[]]> = [
			...FACT_TYPES.map((t): [string, GraphNode[]] => [factTypeLabel(t.id as FactType), members.filter((m) => m.factType === t.id).sort(byName)]),
			["No fact type", members.filter((m) => m.factType === undefined).sort(byName)],
		];
		for (const [title, list] of typed) {
			if (list.length === 0) continue;
			lines.push("", `## ${title}`, "", ...list.map((m) => `- ${wikilink(stems.get(m.id) ?? safeFileStem(m.name), m.name)}`));
		}
		out.push({ kind: "system", id, path: `${SYSTEMS_DIR}/${stem}.md`, content: lines.join("\n") });
	}
	return out;
}

export interface GraphForVault {
	nodes: readonly GraphNode[];
	chains: readonly GraphChain[];
	fileSources: FileSources;
}

/** Everything the graph contributes to the vault: node notes + system indexes.
 *  `reserved` is stems already taken (scripts, files the learner added). */
export function buildGraphNotes(graph: GraphForVault, reserved: Iterable<string> = []): { notes: DesiredNote[]; names: NodeNamePlan } {
	const names = planNodeNames(graph.nodes, [...systemStems(), ...reserved]);
	const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
	const live = graph.chains.filter((c) => nodesById.has(c.conclusion) && c.premises.every((p) => nodesById.has(p)));
	const notes: DesiredNote[] = graph.nodes.map((node) => ({
		kind: "node",
		id: node.id,
		path: names.paths.get(node.id)!,
		content: renderNodeNote({ node, stems: names.stems, nodesById, chains: live, fileSources: graph.fileSources }),
	}));
	notes.push(...renderSystemNotes(graph.nodes, names.stems));
	return { notes, names };
}

// ─── the reconciler ──────────────────────────────────────────────────────────

/** The vault as the reconciler sees it: confined to the app folder, paths relative to it. */
export interface VaultPort {
	/** Every Markdown file under the app folder. */
	scan(): Array<{ path: string; text: string }>;
	writeText(path: string, text: string): void;
	remove(path: string): void;
	exists(path: string): boolean;
	/** Size in bytes, or null when the file is absent. */
	sizeOf(path: string): number | null;
	writeBinary(path: string, bytes: Uint8Array): void;
}

export interface SyncReport {
	written: number;
	unchanged: number;
	moved: number;
	removed: number;
	/** Removed notes whose My-notes text was kept in the salvage folder. */
	salvaged: number;
	/** Managed notes left alone because the learner deleted the My-notes marker. */
	skipped: number;
	assets: number;
	notes: number;
}

export interface ScannedNote {
	path: string;
	text: string;
	header: ManagedHeader | null;
	stem: string;
}

const stemOfPath = (p: string): string => (p.split("/").pop() ?? p).replace(/\.md$/i, "");

export function scanVault(vault: VaultPort): ScannedNote[] {
	return vault
		.scan()
		.map((f) => ({ path: f.path, text: f.text, header: readManagedHeader(f.text), stem: stemOfPath(f.path) }))
		.sort((a, b) => a.path.localeCompare(b.path));
}

/** Stems of notes in the folder the app did NOT write — names the plan must not reuse. */
export function foreignStems(scan: readonly ScannedNote[]): string[] {
	return scan.filter((s) => s.header === null).map((s) => s.stem);
}

/** Bring the vault in line with `desired`. Pure orchestration over the port. */
export function reconcileVault(vault: VaultPort, scan: readonly ScannedNote[], desired: DesiredVault, now: Date = new Date()): SyncReport {
	const report: SyncReport = { written: 0, unchanged: 0, moved: 0, removed: 0, salvaged: 0, skipped: 0, assets: 0, notes: desired.notes.length };
	const desiredPaths = new Set(desired.notes.map((n) => n.path.toLowerCase()));
	const wanted = new Map(desired.notes.map((n) => [noteKey(n.kind, n.id), n]));

	// Managed files by key; a duplicate key (a copied note) leaves the extra copies alone.
	const owned = new Map<string, ScannedNote>();
	for (const file of scan) {
		if (!file.header) continue;
		const key = noteKey(file.header.kind, file.header.id);
		if (!owned.has(key)) owned.set(key, file);
	}
	// Paths held by a file the app does not own; a desired note can never land there.
	const foreignPaths = new Set(scan.filter((s) => s.header === null).map((s) => s.path.toLowerCase()));
	const dupPaths = new Set(scan.filter((s) => s.header && owned.get(noteKey(s.header.kind, s.header.id)) !== s).map((s) => s.path.toLowerCase()));

	const oldPathsToRemove: string[] = [];
	for (const note of desired.notes) {
		if (foreignPaths.has(note.path.toLowerCase()) || dupPaths.has(note.path.toLowerCase())) {
			report.skipped++;
			continue;
		}
		const existing = owned.get(noteKey(note.kind, note.id));
		let mine: string | null = null;
		if (existing) {
			const split = splitMyNotes(existing.text);
			if (split.mine === null) {
				// The learner removed the marker: we cannot tell their text from ours. Leave it be.
				report.skipped++;
				continue;
			}
			mine = split.mine;
		}
		const text = joinMyNotes(note.content, mine);
		if (existing && existing.path === note.path) {
			if (existing.text === text) {
				report.unchanged++;
			} else {
				vault.writeText(note.path, text);
				report.written++;
			}
			continue;
		}
		vault.writeText(note.path, text);
		report.written++;
		if (existing) {
			report.moved++;
			oldPathsToRemove.push(existing.path);
		}
	}
	for (const old of oldPathsToRemove) {
		if (!desiredPaths.has(old.toLowerCase())) vault.remove(old);
	}

	// Notes the app wrote whose subject is gone. Illness scripts are never removed
	// this way: there is no "delete script", and rewriting one spends the learner's
	// ChatGPT allowance, so a script note whose record is momentarily unreadable
	// must survive.
	for (const [key, file] of owned) {
		if (wanted.has(key)) continue;
		if (file.header?.kind === "script") continue;
		if (desiredPaths.has(file.path.toLowerCase())) continue; // the path is taken by another note now
		const split = splitMyNotes(file.text);
		if (split.mine !== null && hasUserNotes(split.mine)) {
			// The learner wrote here. Keep their text as an ordinary note of theirs.
			const stem = safeFileStem(`${file.stem} (removed)`, "Removed note");
			let path = `${SALVAGE_DIR}/${stem}.md`;
			for (let n = 2; vault.exists(path) && n < 1000; n++) path = `${SALVAGE_DIR}/${stem} ${n}.md`;
			const stamp = now.toISOString().slice(0, 10);
			vault.writeText(path, `This note was removed from your LearnHarness graph on ${stamp}. Your own notes from it are kept below.\n\n${split.mine.trimStart()}`);
			report.salvaged++;
		}
		vault.remove(file.path);
		report.removed++;
	}

	// Images and diagrams: written when absent or a different size.
	for (const asset of desired.assets) {
		if (vault.sizeOf(asset.path) === asset.size) continue;
		vault.writeBinary(asset.path, asset.bytes());
		report.assets++;
	}
	return report;
}

/** Convenience for the orchestrator: scan, plan around foreign names, reconcile. */
export function syncVault(
	vault: VaultPort,
	build: (reservedStems: string[]) => DesiredVault,
	now: Date = new Date(),
): SyncReport {
	const scan = scanVault(vault);
	return reconcileVault(vault, scan, build(foreignStems(scan)), now);
}
