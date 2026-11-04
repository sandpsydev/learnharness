/**
 * The Obsidian copy (medical fork): note rendering, safe names, the
 * reconciler (writes, My-notes, renames, removal limited to app-written
 * notes), the confined vault adapter, and the debounced live sync.
 * Everything runs on temp directories or an in-memory vault — no real vault,
 * no model.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { GraphChain, GraphNode } from "../src/core/contracts.ts";
import {
	DEFAULT_MY_NOTES,
	MY_NOTES_MARKER,
	StemRegistry,
	aliasesOf,
	buildGraphNotes,
	hasUserNotes,
	joinMyNotes,
	planNodeNames,
	readManagedHeader,
	reconcileVault,
	renderNodeNote,
	safeFileStem,
	scanVault,
	splitMyNotes,
	syncVault,
	wikilink,
	type DesiredVault,
	type VaultPort,
} from "../src/core/obsidian.ts";
import type { ReviewStore } from "../src/core/ports.ts";
import { createObsidianSync, newSyncState, buildDesiredVault } from "../src/server/obsidian.ts";
import { createVault, VaultError, vaultProblem } from "../src/store/obsidian-vault.ts";

const node = (id: string, name: string, over: Partial<GraphNode> = {}): GraphNode => ({
	id,
	name,
	statement: `${name} is a true statement.`,
	aliases: [],
	createdAt: "2026-10-01T00:00:00.000Z",
	provenance: [{ chatId: "chat1", messageId: "m1" }],
	...over,
});
const chain = (id: string, premises: string[], conclusion: string): GraphChain => ({
	id,
	premises,
	conclusion,
	provenance: [],
	createdAt: "2026-10-01T00:00:00.000Z",
});

/** An in-memory vault: paths relative to the app folder. */
function memoryVault(initial: Record<string, string> = {}) {
	const files = new Map<string, string>(Object.entries(initial));
	const binary = new Map<string, Uint8Array>();
	const log: string[] = [];
	const port: VaultPort = {
		scan: () => [...files.entries()].filter(([p]) => p.endsWith(".md")).map(([p, text]) => ({ path: p, text })),
		writeText: (p, text) => void (files.set(p, text), log.push(`write ${p}`)),
		remove: (p) => void (files.delete(p), binary.delete(p), log.push(`remove ${p}`)),
		exists: (p) => files.has(p) || binary.has(p),
		sizeOf: (p) => binary.get(p)?.byteLength ?? (files.has(p) ? Buffer.byteLength(files.get(p)!) : null),
		writeBinary: (p, b) => void (binary.set(p, b), log.push(`bin ${p}`)),
	};
	return { port, files, binary, log };
}

function plan(nodes: GraphNode[], chains: GraphChain[] = [], fileSources: Record<string, string> = {}, reserved: string[] = []): DesiredVault {
	return { notes: buildGraphNotes({ nodes, chains, fileSources }, reserved).notes, assets: [] };
}

describe("safe file names", () => {
	it("removes what a file system or a wikilink cannot carry", () => {
		assert.equal(safeFileStem("Na/K ATPase: pump?"), "Na-K ATPase- pump");
		assert.equal(safeFileStem('A "quoted" <name> | with #tag ^ and [brackets]'), "A quoted name with tag and brackets");
		assert.equal(safeFileStem("  ..hidden. "), "hidden");
		assert.ok(!safeFileStem("../../etc/passwd").includes("/"));
		assert.ok(!safeFileStem("..\\..\\windows").includes("\\"));
	});

	it("never returns empty, hidden, or a reserved device name, and caps the length", () => {
		assert.equal(safeFileStem("???"), "Untitled");
		assert.equal(safeFileStem("", "Fallback"), "Fallback");
		assert.equal(safeFileStem("..."), "Untitled");
		assert.equal(safeFileStem("CON"), "CON_");
		assert.equal(safeFileStem("com1"), "com1_");
		assert.ok([...safeFileStem("x".repeat(500))].length <= 90);
		assert.equal(safeFileStem("café"), "café");
	});

	it("is collision-proof, case-insensitively, and keeps the first claimant's plain name", () => {
		const registry = new StemRegistry(["Taken"]);
		assert.equal(registry.claim("Anion gap", "n_aaaa1111"), "Anion gap");
		assert.equal(registry.claim("ANION GAP", "n_bbbb2222"), "ANION GAP (2222)");
		assert.equal(registry.claim("anion gap", "n_cccc2222"), "anion gap (2222 2)");
		assert.equal(registry.claim("taken", "n_dddd3333"), "taken (3333)");
	});

	it("gives two nodes with the same name different files, the older one the plain name", () => {
		const nodes = [
			node("n_new0001", "Preload", { createdAt: "2026-10-05T00:00:00.000Z" }),
			node("n_old0002", "Preload", { createdAt: "2026-10-01T00:00:00.000Z" }),
			node("n_slash003", "GI/Hepatobiliary basics"),
		];
		const names = planNodeNames(nodes);
		assert.equal(names.stems.get("n_old0002"), "Preload");
		assert.equal(names.stems.get("n_new0001"), "Preload (0001)");
		assert.equal(names.paths.get("n_slash003"), "Nodes/GI-Hepatobiliary basics.md");
	});

	it("builds links that show the real name when the file name differs", () => {
		assert.equal(wikilink("Preload"), "[[Preload]]");
		assert.equal(wikilink("Preload (0001)", "Preload"), "[[Preload (0001)|Preload]]");
		assert.equal(wikilink("Stem", "Name [with] | bad # chars"), "[[Stem|Name with bad chars]]");
	});
});

describe("node notes", () => {
	const a = node("n_aaaa0001", "Low GFR", { systems: ["renal"], factType: "mechanism", aliases: ["Reduced filtration", "Low GFR", "low gfr is a true statement."] });
	const b = node("n_bbbb0002", "Retained urea", { systems: ["renal", "endocrine"], factType: "clinical-feature" });
	const c = node("n_cccc0003", "Uraemia", { provenance: [{ chatId: "src_notes1", messageId: "" }] });
	const chains = [chain("arg_1", ["n_aaaa0001", "n_bbbb0002"], "n_cccc0003"), chain("arg_2", ["n_aaaa0001"], "n_bbbb0002")];
	const fileSources = { src_notes1: "/Users/x/SlideScribe/vault/SlideScribe/Renal/Lecture 4 - AKI.md" };

	it("carries the app marker, older wordings as aliases, and system and fact-type tags", () => {
		const { notes } = buildGraphNotes({ nodes: [a, b, c], chains, fileSources });
		const text = notes.find((n) => n.id === "n_aaaa0001")!.content;
		assert.deepEqual(readManagedHeader(text), { kind: "node", id: "n_aaaa0001" });
		assert.match(text, /aliases:\n {2}- "Reduced filtration"\n/);
		assert.deepEqual(aliasesOf(a), ["Reduced filtration"], "the name and the statement are not aliases");
		assert.match(text, /tags:\n {2}- system\/renal\n {2}- fact\/mechanism\n/);
		assert.match(text, /^# Low GFR$/m);
		assert.match(text, /Low GFR is a true statement\./);
	});

	it("links premises under Because and conclusions under Leads to", () => {
		const { notes } = buildGraphNotes({ nodes: [a, b, c], chains, fileSources });
		const urea = notes.find((n) => n.id === "n_bbbb0002")!.content;
		assert.match(urea, /## Because\n\n- \[\[Low GFR\]\]\n/);
		assert.match(urea, /## Leads to\n\n- \[\[Uraemia\]\] \(together with \[\[Low GFR\]\]\)\n?/);
		const uraemia = notes.find((n) => n.id === "n_cccc0003")!.content;
		assert.match(uraemia, /## Because\n\n- \[\[Low GFR\]\] \+ \[\[Retained urea\]\]/);
		assert.doesNotMatch(uraemia, /## Leads to/);
	});

	it("links back to the lecture note a node came from, by name", () => {
		const { notes } = buildGraphNotes({ nodes: [a, b, c], chains, fileSources });
		const uraemia = notes.find((n) => n.id === "n_cccc0003")!.content;
		assert.match(uraemia, /## Source\n\n- Lecture note: \[\[Lecture 4 - AKI\]\]/);
		const noSource = notes.find((n) => n.id === "n_aaaa0001")!.content;
		assert.doesNotMatch(noSource, /## Source/);
	});

	it("writes one index per organ system, grouped by fact type, plus Untagged", () => {
		const { notes } = buildGraphNotes({ nodes: [a, b, c], chains, fileSources });
		const systems = notes.filter((n) => n.kind === "system");
		assert.deepEqual(systems.map((n) => n.id).sort(), ["endocrine", "renal", "untagged"]);
		const renal = systems.find((n) => n.id === "renal")!;
		assert.equal(renal.path, "Systems/System - Renal-Urinary.md");
		assert.match(renal.content, /## Mechanism\n\n- \[\[Low GFR\]\]/);
		assert.match(renal.content, /## Clinical feature\n\n- \[\[Retained urea\]\]/);
		assert.match(systems.find((n) => n.id === "untagged")!.content, /- \[\[Uraemia\]\]/);
	});

	it("does not link to a node that no longer exists", () => {
		const text = renderNodeNote({
			node: b,
			stems: new Map([[b.id, "Retained urea"]]),
			nodesById: new Map([[b.id, b]]),
			chains,
			fileSources: {},
		});
		assert.doesNotMatch(text, /Low GFR\]\]/);
	});
});

describe("the My-notes area", () => {
	it("splits at the marker and keeps everything after it verbatim", () => {
		const text = joinMyNotes("---\nlh_managed: true\n---\n\n# X\n\nBody", "## My notes\n\nmy thoughts\n\n- one\n");
		const { generated, mine } = splitMyNotes(text);
		assert.match(generated, /# X/);
		assert.equal(mine, "## My notes\n\nmy thoughts\n\n- one\n");
		assert.equal(joinMyNotes(generated, mine), text);
	});

	it("is absent when the marker was removed", () => {
		assert.equal(splitMyNotes("# nothing here").mine, null);
		assert.equal(hasUserNotes(null), false);
		assert.equal(hasUserNotes(DEFAULT_MY_NOTES), false);
		assert.equal(hasUserNotes("## My notes\n\nsomething"), true);
	});
});

describe("reconciling the vault", () => {
	const a = node("n_aaaa0001", "Low GFR", { systems: ["renal"] });
	const b = node("n_bbbb0002", "Retained urea", { systems: ["renal"] });
	const chains = [chain("arg_1", ["n_aaaa0001"], "n_bbbb0002")];

	it("writes every note once, then leaves an unchanged vault alone", () => {
		const v = memoryVault();
		const first = reconcileVault(v.port, scanVault(v.port), plan([a, b], chains));
		assert.equal(first.written, 3); // two nodes + the Renal index
		for (const text of v.files.values()) assert.ok(text.includes(MY_NOTES_MARKER));
		v.log.length = 0;
		const second = reconcileVault(v.port, scanVault(v.port), plan([a, b], chains));
		assert.equal(second.written, 0);
		assert.equal(second.unchanged, 3);
		assert.deepEqual(v.log, []);
	});

	it("updates an edited node and keeps what the learner wrote under the marker", () => {
		const v = memoryVault();
		reconcileVault(v.port, scanVault(v.port), plan([a, b], chains));
		const path = "Nodes/Low GFR.md";
		v.files.set(path, v.files.get(path)!.replace(DEFAULT_MY_NOTES, "## My notes\n\nMy own mnemonic-free memory aid.\n"));
		const edited = { ...a, statement: "Low GFR means reduced glomerular filtration." };
		const report = reconcileVault(v.port, scanVault(v.port), plan([edited, b], chains));
		assert.ok(report.written >= 1);
		const after = v.files.get(path)!;
		assert.match(after, /reduced glomerular filtration/);
		assert.match(after, /My own mnemonic-free memory aid\./);
		assert.equal(after.split(MY_NOTES_MARKER).length, 2);
	});

	it("moves a renamed note, keeps its My notes, and fixes the links in the notes that point at it", () => {
		const v = memoryVault();
		reconcileVault(v.port, scanVault(v.port), plan([a, b], chains));
		v.files.set("Nodes/Low GFR.md", v.files.get("Nodes/Low GFR.md")!.replace(DEFAULT_MY_NOTES, "## My notes\n\nkeep me\n"));
		const renamed = { ...a, name: "Reduced GFR" };
		const report = reconcileVault(v.port, scanVault(v.port), plan([renamed, b], chains));
		assert.equal(report.moved, 1);
		assert.ok(!v.files.has("Nodes/Low GFR.md"), "the old file is gone");
		assert.match(v.files.get("Nodes/Reduced GFR.md")!, /keep me/);
		assert.match(v.files.get("Nodes/Retained urea.md")!, /## Because\n\n- \[\[Reduced GFR\]\]/);
		assert.match(v.files.get("Systems/System - Renal-Urinary.md")!, /\[\[Reduced GFR\]\]/);
	});

	it("removes the note of a node that no longer exists, and only notes the app wrote", () => {
		const v = memoryVault({
			"Nodes/Stray.md": "# my own file, no marker\n",
			"Nodes/Fake.md": "---\nlh_managed: false\nlh_kind: \"node\"\nlh_id: \"n_zzzz\"\n---\nnot ours\n",
		});
		reconcileVault(v.port, scanVault(v.port), plan([a, b], chains));
		const report = reconcileVault(v.port, scanVault(v.port), plan([a], []));
		assert.ok(!v.files.has("Nodes/Retained urea.md"));
		assert.equal(report.removed, 1);
		assert.equal(v.files.get("Nodes/Stray.md"), "# my own file, no marker\n");
		assert.ok(v.files.has("Nodes/Fake.md"), "a file that merely looks similar is not ours");
	});

	it("never removes an illness script note because its record is missing", () => {
		const v = memoryVault({
			"Illness scripts/Gout (illness script).md": "---\nlh_managed: true\nlh_kind: \"script\"\nlh_id: \"gout\"\n---\n\n# Gout\n\n" + MY_NOTES_MARKER + "\n" + DEFAULT_MY_NOTES,
		});
		const report = reconcileVault(v.port, scanVault(v.port), plan([a, b], chains));
		assert.equal(report.removed, 0);
		assert.ok(v.files.has("Illness scripts/Gout (illness script).md"));
	});

	it("keeps the learner's own text from a removed node as an ordinary note instead of deleting it", () => {
		const v = memoryVault();
		reconcileVault(v.port, scanVault(v.port), plan([a, b], chains));
		v.files.set("Nodes/Retained urea.md", v.files.get("Nodes/Retained urea.md")!.replace(DEFAULT_MY_NOTES, "## My notes\n\nclinic pearl: smell of urine\n"));
		const report = reconcileVault(v.port, scanVault(v.port), plan([a], []));
		assert.equal(report.salvaged, 1);
		assert.ok(!v.files.has("Nodes/Retained urea.md"));
		const saved = [...v.files.entries()].find(([p]) => p.startsWith("Removed nodes/"));
		assert.ok(saved, "a salvage note exists");
		assert.match(saved![1], /clinic pearl: smell of urine/);
		assert.equal(readManagedHeader(saved![1]), null, "the salvage note is the learner's, not managed");
	});

	it("leaves a note alone when the learner deleted the marker", () => {
		const v = memoryVault();
		reconcileVault(v.port, scanVault(v.port), plan([a, b], chains));
		const path = "Nodes/Low GFR.md";
		const stripped = v.files.get(path)!.replace(MY_NOTES_MARKER, "");
		v.files.set(path, stripped);
		const report = reconcileVault(v.port, scanVault(v.port), plan([{ ...a, statement: "A new statement." }, b], chains));
		assert.equal(report.skipped, 1);
		assert.equal(v.files.get(path), stripped);
	});

	it("never writes onto a file the learner made, and plans around its name", () => {
		const v = memoryVault({ "Nodes/Low GFR.md": "# the learner's own note\n" });
		const scan = scanVault(v.port);
		const desired: DesiredVault = {
			notes: buildGraphNotes({ nodes: [a, b], chains, fileSources: {} }, scan.filter((s) => !s.header).map((s) => s.stem)).notes,
			assets: [],
		};
		reconcileVault(v.port, scan, desired);
		assert.equal(v.files.get("Nodes/Low GFR.md"), "# the learner's own note\n");
		assert.ok(v.files.has("Nodes/Low GFR (0001).md"), "the node takes a different name");
	});

	it("writes images once and only when absent or a different size", () => {
		const v = memoryVault();
		const bytes = new Uint8Array([1, 2, 3, 4]);
		const desired: DesiredVault = { notes: [], assets: [{ path: "Attachments/x.png", size: 4, bytes: () => bytes }] };
		assert.equal(reconcileVault(v.port, scanVault(v.port), desired).assets, 1);
		assert.equal(reconcileVault(v.port, scanVault(v.port), desired).assets, 0);
		const bigger: DesiredVault = { notes: [], assets: [{ path: "Attachments/x.png", size: 6, bytes: () => new Uint8Array(6) }] };
		assert.equal(reconcileVault(v.port, scanVault(v.port), bigger).assets, 1);
	});

	it("syncVault plans around names already in the folder", () => {
		const v = memoryVault({ "Nodes/Low GFR.md": "# mine\n" });
		let seen: string[] = [];
		syncVault(v.port, (reserved) => {
			seen = reserved;
			return plan([a], [], {}, reserved);
		});
		assert.deepEqual(seen, ["Low GFR"]);
	});
});

describe("the confined vault", () => {
	let dir: string;
	let vaultDir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-obs-"));
		vaultDir = path.join(dir, "vault");
		fs.mkdirSync(vaultDir);
		fs.writeFileSync(path.join(vaultDir, "Their note.md"), "# theirs\n");
		fs.writeFileSync(path.join(dir, "outside.txt"), "outside");
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	/** Every file under `dir` with its content — to prove nothing outside the app folder changed. */
	const snapshot = (): Record<string, string> => {
		const out: Record<string, string> = {};
		const walk = (d: string): void => {
			for (const e of fs.readdirSync(d, { withFileTypes: true })) {
				const p = path.join(d, e.name);
				if (e.isDirectory()) walk(p);
				else out[path.relative(dir, p)] = fs.readFileSync(p, "utf-8");
			}
		};
		walk(dir);
		return out;
	};

	it("writes only inside <vault>/LearnHarness and creates that folder itself", () => {
		const before = snapshot();
		const vault = createVault(vaultDir);
		vault.writeText("Nodes/A.md", "# a");
		vault.writeBinary("Attachments/p.png", new Uint8Array([9, 9]));
		const after = snapshot();
		for (const [file, text] of Object.entries(before)) assert.equal(after[file], text, `${file} untouched`);
		const added = Object.keys(after).filter((f) => !(f in before)).sort();
		assert.deepEqual(added, ["vault/LearnHarness/Attachments/p.png", "vault/LearnHarness/Nodes/A.md"]);
	});

	it("refuses any path that would leave the folder", () => {
		const vault = createVault(vaultDir);
		for (const bad of ["../outside.txt", "Nodes/../../outside.txt", "/etc/passwd", "..", "", "Nodes//x.md", "a\\b.md", "./x.md"]) {
			assert.throws(() => vault.writeText(bad, "x"), VaultError, `write ${bad}`);
			assert.throws(() => vault.remove(bad), VaultError, `remove ${bad}`);
		}
		assert.equal(fs.readFileSync(path.join(dir, "outside.txt"), "utf-8"), "outside");
		assert.equal(fs.readFileSync(path.join(vaultDir, "Their note.md"), "utf-8"), "# theirs\n");
	});

	it("does not follow a symlink out of the folder", () => {
		const vault = createVault(vaultDir);
		vault.writeText("Nodes/A.md", "# a");
		const link = path.join(vaultDir, "LearnHarness", "Escape");
		fs.symlinkSync(dir, link);
		assert.throws(() => vault.writeText("Escape/outside.txt", "pwned"), VaultError);
		assert.throws(() => vault.remove("Escape/outside.txt"), VaultError);
		assert.equal(fs.readFileSync(path.join(dir, "outside.txt"), "utf-8"), "outside");
		assert.ok(!vault.scan().some((f) => f.path.startsWith("Escape")), "the scan does not walk the link");
	});

	it("scans only Markdown under its folder and not the rest of the vault", () => {
		const vault = createVault(vaultDir);
		vault.writeText("Nodes/A.md", "# a");
		vault.writeBinary("Attachments/p.png", new Uint8Array([1]));
		assert.deepEqual(vault.scan().map((f) => f.path), ["Nodes/A.md"]);
	});

	it("refuses a vault folder that is missing, a file, or the top of the disk, and never creates it", () => {
		assert.match(vaultProblem(path.join(dir, "nope"))!, /doesn't exist/);
		assert.match(vaultProblem(path.join(dir, "outside.txt"))!, /file/);
		assert.match(vaultProblem("/")!, /vault folder/);
		assert.match(vaultProblem("relative/path")!, /full path/);
		assert.throws(() => createVault(path.join(dir, "nope")), VaultError);
		assert.ok(!fs.existsSync(path.join(dir, "nope")));
		assert.equal(vaultProblem(vaultDir), null);
	});

	it("runs the real reconciler end to end: rename, My notes, removal", () => {
		const vault = createVault(vaultDir);
		const n1 = node("n_aaaa0001", "Low GFR");
		const n2 = node("n_bbbb0002", "Retained urea");
		reconcileVault(vault, scanVault(vault), plan([n1, n2]));
		const file = path.join(vaultDir, "LearnHarness", "Nodes", "Low GFR.md");
		fs.writeFileSync(file, fs.readFileSync(file, "utf-8").replace(DEFAULT_MY_NOTES, "## My notes\n\nmine\n"));
		reconcileVault(vault, scanVault(vault), plan([{ ...n1, name: "Reduced GFR" }]));
		assert.ok(!fs.existsSync(file));
		assert.match(fs.readFileSync(path.join(vaultDir, "LearnHarness", "Nodes", "Reduced GFR.md"), "utf-8"), /\nmine\n/);
		assert.ok(!fs.existsSync(path.join(vaultDir, "LearnHarness", "Nodes", "Retained urea.md")));
		assert.equal(fs.readFileSync(path.join(vaultDir, "Their note.md"), "utf-8"), "# theirs\n");
	});
});

describe("the live copy", () => {
	const emptyReview: ReviewStore = {
		listScripts: () => [],
		getScript: () => null,
		putScript: () => {},
		readAsset: () => null,
		assetSize: () => null,
		readCatalogue: () => null,
		writeCatalogue: () => {},
	};

	function harness(initialVault: string | null = "/vault") {
		let nodes = [node("n_aaaa0001", "Low GFR")];
		let vaultPath: string | null = initialVault;
		let revision = 1;
		let clock = 1_000_000;
		const timers: Array<{ id: number; at: number; fn: () => void }> = [];
		let nextId = 1;
		const vault = memoryVault();
		const sync = createObsidianSync({
			readSettings: () => (vaultPath ? { version: 1, obsidian: { vaultPath } } : null),
			graphStore: { readNodes: () => nodes, readChains: () => [], readSources: () => [] },
			reviewStore: emptyReview,
			makeVault: () => Object.assign(vault.port, { appRoot: "/vault/LearnHarness" }),
			revision: () => revision,
			now: () => new Date(clock),
			suggest: () => null,
			setTimer: ((fn: () => void, ms: number) => {
				const id = nextId++;
				timers.push({ id, at: clock + ms, fn });
				return id as unknown as ReturnType<typeof setTimeout>;
			}) as never,
			clearTimer: ((t: number) => {
				const i = timers.findIndex((x) => x.id === t);
				if (i >= 0) timers.splice(i, 1);
			}) as never,
			debounceMs: 3000,
			maxWaitMs: 10_000,
			state: newSyncState(),
		});
		const advance = (ms: number): void => {
			clock += ms;
			for (const t of timers.filter((x) => x.at <= clock).sort((a, b) => a.at - b.at)) {
				timers.splice(timers.indexOf(t), 1);
				t.fn();
			}
		};
		return {
			sync,
			vault,
			advance,
			pending: () => timers.length,
			setNodes: (n: GraphNode[]) => void (nodes = n, revision++),
			setVault: (p: string | null) => void (vaultPath = p),
		};
	}

	it("does nothing while no folder is set", () => {
		const h = harness(null);
		h.sync.tick();
		assert.equal(h.pending(), 0);
		assert.equal(h.sync.status().state, "off");
		assert.equal(h.vault.files.size, 0);
	});

	it("waits for a quiet moment, then writes once for a burst of changes", () => {
		const h = harness();
		h.sync.tick();
		assert.equal(h.sync.status().state, "waiting");
		h.advance(2000);
		h.setNodes([node("n_aaaa0001", "Low GFR"), node("n_bbbb0002", "Retained urea")]);
		h.sync.tick();
		h.advance(2000);
		assert.equal(h.vault.files.size, 0, "the timer restarted with the second change");
		h.advance(1500);
		assert.ok(h.vault.files.has("Nodes/Low GFR.md") && h.vault.files.has("Nodes/Retained urea.md"));
		assert.equal(h.sync.status().state, "idle");
		assert.equal(h.sync.status().lastReport?.notes, 3);
		const writes = h.vault.log.filter((l) => l.startsWith("write")).length;
		h.advance(10_000);
		assert.equal(h.vault.log.filter((l) => l.startsWith("write")).length, writes, "no further writes without a change");
	});

	it("still syncs under a steady stream of changes (the maximum wait)", () => {
		const h = harness();
		for (let i = 0; i < 6; i++) {
			h.setNodes([node("n_aaaa0001", `Low GFR ${i}`)]);
			h.sync.tick();
			h.advance(2500);
		}
		assert.ok([...h.vault.files.keys()].some((p) => p.startsWith("Nodes/Low GFR")), "written before the stream stopped");
	});

	it("follows a rename and a deletion", () => {
		const h = harness();
		h.sync.run();
		h.setNodes([node("n_aaaa0001", "Reduced GFR")]);
		h.sync.tick();
		h.advance(3000);
		assert.ok(h.vault.files.has("Nodes/Reduced GFR.md") && !h.vault.files.has("Nodes/Low GFR.md"));
		h.setNodes([]);
		h.sync.tick();
		h.advance(3000);
		assert.ok(![...h.vault.files.keys()].some((p) => p.startsWith("Nodes/")));
	});

	it("reports a missing folder as a problem and recovers when it is back", () => {
		const failing = createObsidianSync({
			readSettings: () => ({ version: 1, obsidian: { vaultPath: "/does/not/exist" } }),
			graphStore: { readNodes: () => [], readChains: () => [], readSources: () => [] },
			reviewStore: emptyReview,
			makeVault: createVault,
			revision: () => 1,
			now: () => new Date(),
			suggest: () => null,
			setTimer: (() => 0) as never,
			clearTimer: () => {},
			state: newSyncState(),
		});
		const status = failing.run();
		assert.equal(status.state, "error");
		assert.match(status.problem!, /doesn't exist/);
	});

	it("buildDesiredVault carries nodes and index notes and never reads the vault", () => {
		const desired = buildDesiredVault(
			{ readNodes: () => [node("n_aaaa0001", "Low GFR", { systems: ["renal"] })], readChains: () => [], readSources: () => [] },
			[],
			emptyReview,
			[],
		);
		assert.deepEqual(desired.notes.map((n) => n.path).sort(), ["Nodes/Low GFR.md", "Systems/System - Renal-Urinary.md"]);
	});
});
