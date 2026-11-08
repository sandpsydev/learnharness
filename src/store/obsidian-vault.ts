/**
 * The Obsidian vault adapter (medical fork): the real filesystem behind
 * core/obsidian.ts's `VaultPort`, CONFINED to one app-owned folder.
 *
 * The confinement is the point of this file. Whatever path the planner hands
 * over — a node name with slashes in it, a `..`, an absolute path, a symlink
 * the learner placed inside the folder — the adapter either resolves it to a
 * location inside `<vault>/LearnHarness/` or refuses it. Nothing outside that
 * folder is ever created, changed or deleted. The vault folder itself must
 * already exist (the app never creates a vault); only the app folder is
 * created on first write.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { OBSIDIAN_APP_FOLDER, type VaultPort } from "../core/obsidian.ts";

export class VaultError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VaultError";
	}
}

/** Check a configured vault folder without touching it. Returns the reason it can't be used, or null. */
export function vaultProblem(vaultPath: string): string | null {
	if (!path.isAbsolute(vaultPath)) return "Use the full path of the folder (it should start with / or ~).";
	const resolved = path.resolve(vaultPath);
	if (resolved === path.parse(resolved).root) return "Choose your vault folder, not the top of the disk.";
	let stat: fs.Stats;
	try {
		stat = fs.statSync(resolved);
	} catch {
		return "That folder doesn't exist. LearnHarness won't create a vault — make it in Obsidian first.";
	}
	if (!stat.isDirectory()) return "That path is a file, not a folder.";
	return null;
}

const MAX_SCAN_DEPTH = 6;

export function createVault(vaultPath: string): VaultPort & { appRoot: string } {
	const problem = vaultProblem(vaultPath);
	if (problem) throw new VaultError(problem);
	const vaultRoot = path.resolve(vaultPath);
	const appRoot = path.join(vaultRoot, OBSIDIAN_APP_FOLDER);

	/** The real path of the app folder, once it exists (so a symlinked folder can't redirect writes). */
	const realAppRoot = (): string | null => {
		try {
			return fs.realpathSync(appRoot);
		} catch {
			return null;
		}
	};

	/** Resolve a relative path inside the app folder, or throw. */
	function inside(rel: string): string {
		if (typeof rel !== "string" || rel === "" || path.isAbsolute(rel) || rel.includes("\\") || rel.includes("\0")) {
			throw new VaultError(`Refusing a path outside the app folder: ${JSON.stringify(rel)}`);
		}
		const parts = rel.split("/");
		if (parts.some((p) => p === "" || p === "." || p === "..")) {
			throw new VaultError(`Refusing a path outside the app folder: ${JSON.stringify(rel)}`);
		}
		const target = path.join(appRoot, ...parts);
		if (target !== appRoot && !target.startsWith(appRoot + path.sep)) {
			throw new VaultError(`Refusing a path outside the app folder: ${JSON.stringify(rel)}`);
		}
		// A symlink inside the folder must not lead out of it: check the deepest part that exists.
		const real = realAppRoot();
		if (real) {
			let probe = target;
			while (probe !== appRoot) {
				try {
					const realProbe = fs.realpathSync(probe);
					if (realProbe !== real && !realProbe.startsWith(real + path.sep)) {
						throw new VaultError(`Refusing a path that leaves the app folder: ${JSON.stringify(rel)}`);
					}
					break;
				} catch (err) {
					if (err instanceof VaultError) throw err;
					probe = path.dirname(probe);
				}
			}
		}
		return target;
	}

	function scan(): Array<{ path: string; text: string }> {
		const out: Array<{ path: string; text: string }> = [];
		const walk = (dir: string, rel: string, depth: number): void => {
			if (depth > MAX_SCAN_DEPTH) return;
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				if (entry.name.startsWith(".")) continue;
				if (entry.isSymbolicLink()) continue; // never follow a link out of the folder
				const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
				if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel, depth + 1);
				else if (entry.isFile() && /\.md$/i.test(entry.name)) {
					try {
						out.push({ path: childRel, text: fs.readFileSync(path.join(dir, entry.name), "utf-8") });
					} catch {
						/* unreadable right now — skip, never guess */
					}
				}
			}
		};
		walk(appRoot, "", 0);
		return out;
	}

	function atomicWrite(target: string, data: string | Uint8Array): void {
		fs.mkdirSync(path.dirname(target), { recursive: true });
		const tmp = `${target}.${process.pid}.lh-tmp`;
		try {
			fs.writeFileSync(tmp, data);
			fs.renameSync(tmp, target);
		} catch (err) {
			try {
				fs.rmSync(tmp, { force: true });
			} catch {
				/* the rename either happened or the temp file never existed */
			}
			throw err;
		}
	}

	return {
		appRoot,
		scan,
		writeText(rel, text) {
			atomicWrite(inside(rel), text);
		},
		remove(rel) {
			const target = inside(rel);
			fs.rmSync(target, { force: true });
			// A note that moved out of a topic folder leaves it empty: tidy up. rmdir only
			// removes an EMPTY folder, so anything the learner put there keeps it alive,
			// and the walk stops at the app folder.
			let dir = path.dirname(target);
			while (dir !== appRoot && dir.startsWith(appRoot + path.sep)) {
				try {
					fs.rmdirSync(dir);
				} catch {
					break;
				}
				dir = path.dirname(dir);
			}
		},
		exists(rel) {
			return fs.existsSync(inside(rel));
		},
		sizeOf(rel) {
			try {
				return fs.statSync(inside(rel)).size;
			} catch (err) {
				if (err instanceof VaultError) throw err;
				return null;
			}
		},
		writeBinary(rel, bytes) {
			atomicWrite(inside(rel), bytes);
		},
	};
}
