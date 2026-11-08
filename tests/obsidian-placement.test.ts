/**
 * The Obsidian copy mirrors the outline (src/core/obsidian.ts): notes live at
 * <System>/<Topic>/<fact>.md, each topic has an index note listing its facts by
 * aspect, the Systems notes stay maps of content, and moving a note — when a
 * fact is placed or re-placed — carries the learner's My-notes text over
 * verbatim and touches only app-written notes. Memory vault plus one temp
 * folder for the real adapter's tidy-up; no real vault, no model.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { GraphNode } from "../src/core/contracts.ts";
import type { PlacementView } from "../src/core/contracts/placement.ts";
import {
	MY_NOTES_MARKER,
	buildGraphNotes,
	readManagedHeader,
	reconcileVault,
	scanVault,
	splitMyNotes,
	type DesiredVault,
	type VaultPort,
} from "../src/core/obsidian.ts";
import { createVault } from "../src/store/obsidian-vault.ts";

const node = (id: string, name: string, over: Partial<GraphNode> = {}): GraphNode => ({
	id,
	name,
	statement: `${name} is a true statement.`,
	aliases: [],
	createdAt: "2026-10-01T00:00:00.000Z",
	provenance: [],
	...over,
});

function memoryVault(initial: Record<string, string> = {}) {
	const files = new Map<string, string>(Object.entries(initial));
	const port: VaultPort = {
		scan: () => [...files.entries()].filter(([p]) => p.endsWith(".md")).map(([p, text]) => ({ path: p, text })),
		writeText: (p, text) => void files.set(p, text),
		remove: (p) => void files.delete(p),
		exists: (p) => files.has(p),
		sizeOf: (p) => (files.has(p) ? Buffer.byteLength(files.get(p)!) : null),
		writeBinary: () => {},
	};
	return { port, files };
}

const sync = (vault: ReturnType<typeof memoryVault>, nodes: GraphNode[], placement?: PlacementView) => {
	const scan = scanVault(vault.port);
	const foreign = scan.filter((s) => s.header === null).map((s) => s.stem);
	const desired: DesiredVault = { notes: buildGraphNotes({ nodes, chains: [], fileSources: {}, ...(placement ? { placement } : {}) }, foreign).notes, assets: [] };
	return reconcileVault(vault.port, scan, desired, new Date("2026-11-09T00:00:00Z"));
};

const nodes = [
	node("n_aaaa0001", "Adhesions are the commonest cause", { systems: ["gi"] }),
	node("n_aaaa0002", "Vomiting is bilious when high", { systems: ["gi"] }),
	node("n_aaaa0003", "Amylase rises", { systems: ["gi"] }),
	node("n_aaaa0004", "Unplaced fact", { systems: ["renal"] }),
];

const placement: PlacementView = {
	topics: [
		{ id: "t_sbo", name: "Small-bowel obstruction", system: "gi" },
		{ id: "t_ap", name: "Acute pancreatitis", system: "gi" },
	],
	byNode: {
		n_aaaa0001: { topicId: "t_sbo", aspect: "risk-factors", source: "placer", confidence: "high" },
		n_aaaa0002: { topicId: "t_sbo", aspect: "presentation", source: "placer", confidence: "low" },
		n_aaaa0003: { topicId: "t_ap", aspect: "workup", source: "placer", confidence: "high" },
	},
	unplaced: 1,
	withdrawn: 0,
};

describe("the vault layout", () => {
	it("puts a placed fact under <System>/<Topic>/ and an unplaced one under Nodes/", () => {
		const notes = buildGraphNotes({ nodes, chains: [], fileSources: {}, placement }).notes;
		const pathOf = (id: string) => notes.find((n) => n.kind === "node" && n.id === id)!.path;
		assert.equal(pathOf("n_aaaa0001"), "GI-Hepatobiliary/Small-bowel obstruction/Adhesions are the commonest cause.md");
		assert.equal(pathOf("n_aaaa0003"), "GI-Hepatobiliary/Acute pancreatitis/Amylase rises.md");
		assert.equal(pathOf("n_aaaa0004"), "Nodes/Unplaced fact.md");
	});

	it("keeps the flat layout when no placement is given", () => {
		const notes = buildGraphNotes({ nodes, chains: [], fileSources: {} }).notes;
		assert.ok(notes.filter((n) => n.kind === "node").every((n) => n.path.startsWith("Nodes/")));
		assert.ok(!notes.some((n) => n.kind === "topic"));
	});

	it("gives each topic an index note listing its facts by aspect, in illness-script order", () => {
		const notes = buildGraphNotes({ nodes, chains: [], fileSources: {}, placement }).notes;
		const topic = notes.find((n) => n.kind === "topic" && n.id === "t_sbo")!;
		assert.equal(topic.path, "GI-Hepatobiliary/Small-bowel obstruction/Topic - Small-bowel obstruction.md");
		assert.deepEqual(readManagedHeader(topic.content), { kind: "topic", id: "t_sbo" });
		const risk = topic.content.indexOf("## Risk factors");
		const presentation = topic.content.indexOf("## Presentation");
		assert.ok(risk > 0 && presentation > risk);
		assert.match(topic.content, /- \[\[Adhesions are the commonest cause\]\]/);
		assert.match(topic.content, /\[\[System - GI-Hepatobiliary\|GI\/Hepatobiliary\]\]/);
	});

	it("a fact's note names its topic and aspect, with a link back to the topic note", () => {
		const notes = buildGraphNotes({ nodes, chains: [], fileSources: {}, placement }).notes;
		const fact = notes.find((n) => n.kind === "node" && n.id === "n_aaaa0001")!;
		assert.match(fact.content, /^topic: "Small-bowel obstruction"$/m);
		assert.match(fact.content, /^aspect: "Risk factors"$/m);
		assert.match(fact.content, /In \[\[Topic - Small-bowel obstruction\|Small-bowel obstruction\]\] › Risk factors \(GI\/Hepatobiliary\)/);
	});

	it("the Systems notes stay maps of content: topics with counts, then facts not yet placed", () => {
		const notes = buildGraphNotes({ nodes, chains: [], fileSources: {}, placement }).notes;
		const gi = notes.find((n) => n.kind === "system" && n.id === "gi")!;
		assert.equal(gi.path, "Systems/System - GI-Hepatobiliary.md");
		assert.match(gi.content, /- \[\[Topic - Small-bowel obstruction\|Small-bowel obstruction\]\] \(2\)/);
		assert.match(gi.content, /- \[\[Topic - Acute pancreatitis\|Acute pancreatitis\]\] \(1\)/);
		const renal = notes.find((n) => n.kind === "system" && n.id === "renal")!;
		assert.match(renal.content, /## Not placed yet/);
		assert.match(renal.content, /\[\[Unplaced fact\]\]/);
	});

	it("keeps every note name unique: a topic named like a fact, and two topics that fold to one folder", () => {
		const clash = [node("n_1", "Topic - Reflux"), node("n_2", "A"), node("n_3", "B")];
		const view: PlacementView = {
			topics: [
				{ id: "t_1", name: "Reflux", system: "gi" },
				{ id: "t_2", name: "A/B", system: "gi" },
				{ id: "t_3", name: "A-B", system: "gi" },
			],
			byNode: {
				n_1: { topicId: "t_1", aspect: "other", source: "placer", confidence: "high" },
				n_2: { topicId: "t_2", aspect: "other", source: "placer", confidence: "high" },
				n_3: { topicId: "t_3", aspect: "other", source: "placer", confidence: "high" },
			},
			unplaced: 0,
			withdrawn: 0,
		};
		const notes = buildGraphNotes({ nodes: clash, chains: [], fileSources: {}, placement: view }).notes;
		const stems = notes.filter((n) => n.kind !== "system").map((n) => n.path.split("/").pop()!.toLowerCase());
		assert.equal(new Set(stems).size, stems.length, "no two notes share a name");
		const folders = notes.filter((n) => n.kind === "topic").map((n) => n.path.split("/").slice(0, 2).join("/").toLowerCase());
		assert.equal(new Set(folders).size, folders.length, "no two topics share a folder");
	});
});

describe("moving notes into the outline", () => {
	it("moves a note when its fact is placed, carrying My notes over verbatim and leaving no copy behind", () => {
		const vault = memoryVault();
		sync(vault, nodes);
		const flat = "Nodes/Adhesions are the commonest cause.md";
		assert.ok(vault.files.has(flat));
		// The learner writes under the marker.
		const mine = "## My notes\n\nMy own mnemonic — keep this!\n\n- second line\n";
		vault.files.set(flat, splitMyNotes(vault.files.get(flat)!).generated.trimEnd() + `\n\n${MY_NOTES_MARKER}\n${mine}`);

		const report = sync(vault, nodes, placement);
		const moved = "GI-Hepatobiliary/Small-bowel obstruction/Adhesions are the commonest cause.md";
		assert.ok(vault.files.has(moved));
		assert.ok(!vault.files.has(flat), "the old note is gone");
		assert.equal(splitMyNotes(vault.files.get(moved)!).mine, mine, "My notes arrive exactly as written");
		assert.ok(report.moved >= 3);
		// A second sync with nothing changed writes nothing.
		assert.equal(sync(vault, nodes, placement).written, 0);
	});

	it("moves a note again when its fact is re-placed under another topic, My notes intact", () => {
		const vault = memoryVault();
		sync(vault, nodes, placement);
		const from = "GI-Hepatobiliary/Small-bowel obstruction/Vomiting is bilious when high.md";
		const mine = "## My notes\n\nSeen on the surgical ward.\n";
		vault.files.set(from, splitMyNotes(vault.files.get(from)!).generated.trimEnd() + `\n\n${MY_NOTES_MARKER}\n${mine}`);

		const replaced: PlacementView = {
			...placement,
			byNode: { ...placement.byNode, n_aaaa0002: { topicId: "t_ap", aspect: "presentation", source: "learner", confidence: "high" } },
		};
		sync(vault, nodes, replaced);
		const to = "GI-Hepatobiliary/Acute pancreatitis/Vomiting is bilious when high.md";
		assert.ok(vault.files.has(to));
		assert.ok(!vault.files.has(from));
		assert.equal(splitMyNotes(vault.files.get(to)!).mine, mine);
		// The topic notes follow: the old one no longer lists it, the new one does.
		assert.doesNotMatch(vault.files.get("GI-Hepatobiliary/Small-bowel obstruction/Topic - Small-bowel obstruction.md")!, /Vomiting/);
		assert.match(vault.files.get("GI-Hepatobiliary/Acute pancreatitis/Topic - Acute pancreatitis.md")!, /Vomiting is bilious/);
	});

	it("leaves the learner's own notes alone: foreign files in the folders, and a managed note whose marker they deleted", () => {
		const vault = memoryVault({
			"GI-Hepatobiliary/Small-bowel obstruction/My ward notes.md": "# mine\nnothing of the app's\n",
			"GI-Hepatobiliary/Acute pancreatitis/Amylase rises.md": "# a note of theirs with the same path\n",
		});
		sync(vault, nodes);
		const flat = "Nodes/Vomiting is bilious when high.md";
		vault.files.set(flat, vault.files.get(flat)!.replace(MY_NOTES_MARKER, "").trimEnd() + "\nMy words, no marker.\n");
		const frozen = vault.files.get(flat)!;

		sync(vault, nodes, placement);
		assert.equal(vault.files.get("GI-Hepatobiliary/Small-bowel obstruction/My ward notes.md"), "# mine\nnothing of the app's\n");
		assert.equal(vault.files.get("GI-Hepatobiliary/Acute pancreatitis/Amylase rises.md"), "# a note of theirs with the same path\n", "a foreign file at the target path is never overwritten");
		assert.equal(vault.files.get(flat), frozen, "a note with its marker removed is left exactly as it is");
	});

	it("removes a topic's index note when its last fact leaves, but only the app's own", () => {
		const vault = memoryVault();
		sync(vault, nodes, placement);
		const gone: PlacementView = {
			topics: [placement.topics[0]!],
			byNode: { n_aaaa0001: placement.byNode.n_aaaa0001!, n_aaaa0002: placement.byNode.n_aaaa0002! },
			unplaced: 2,
			withdrawn: 0,
		};
		sync(vault, nodes, gone);
		assert.ok(![...vault.files.keys()].some((p) => p.includes("Topic - Acute pancreatitis")));
		assert.ok(vault.files.has("Nodes/Amylase rises.md"));
	});
});

describe("the real vault adapter tidies up empty topic folders", () => {
	it("removes an emptied folder, keeps one that still holds a learner file, and stays inside the app folder", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-outline-vault-"));
		try {
			const vault = createVault(dir);
			vault.writeText("GI-Hepatobiliary/Ileus/a.md", "x");
			vault.writeText("GI-Hepatobiliary/Volvulus/b.md", "x");
			vault.writeText("GI-Hepatobiliary/Volvulus/theirs.txt", "learner file");
			vault.remove("GI-Hepatobiliary/Ileus/a.md");
			vault.remove("GI-Hepatobiliary/Volvulus/b.md");
			const app = path.join(dir, "LearnHarness");
			assert.ok(!fs.existsSync(path.join(app, "GI-Hepatobiliary", "Ileus")), "the empty topic folder is removed");
			assert.ok(fs.existsSync(path.join(app, "GI-Hepatobiliary", "Volvulus", "theirs.txt")), "a folder with a learner file stays");
			assert.ok(fs.existsSync(dir), "nothing above the app folder is touched");
			vault.writeText("Only/c.md", "x");
			vault.remove("Only/c.md");
			assert.ok(fs.existsSync(app), "the app folder itself stays");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
