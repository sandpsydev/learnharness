/**
 * ReviewStore — the fs adapter for Review mode (medical fork): the illness
 * scripts the app has written, the images they embed, and the illness list.
 *
 *   data/review/scripts/<slug>.json   one IllnessScript per file
 *   data/review/assets/<file>         page images and diagrams (names carry the slug)
 *   data/review/catalogue.json        the illnesses found in the graph
 *
 * This is LearnHarness's own copy; the Obsidian notes are rendered from it
 * (core/illness-script.ts), so a lost or moved vault never loses a script.
 * `createReviewStore(root)` exists so tests can use a temp directory.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { IllnessCatalogue, IllnessScript } from "../core/contracts.ts";
import { SCRIPT_SECTIONS } from "../core/contracts.ts";
import type { ReviewStore } from "../core/ports.ts";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** An asset name is a plain file name: no folders, no dots at the front. */
const ASSET_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,150}\.(png|svg)$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function isScript(v: unknown): v is IllnessScript {
	if (!isRecord(v)) return false;
	return (
		typeof v.slug === "string" &&
		SLUG_RE.test(v.slug) &&
		typeof v.title === "string" &&
		typeof v.generatedAt === "string" &&
		Array.isArray(v.sections) &&
		v.sections.length === SCRIPT_SECTIONS.length &&
		isRecord(v.basis) &&
		isRecord(v.basis.nodes) &&
		Array.isArray(v.aliases) &&
		Array.isArray(v.systems) &&
		isRecord(v.sources)
	);
}

function atomicWrite(file: string, data: string | Uint8Array): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, data);
	fs.renameSync(tmp, file);
}

export function createReviewStore(root: string): ReviewStore {
	const scriptFile = (slug: string): string => {
		if (!SLUG_RE.test(slug)) throw new Error(`Invalid script id: ${slug}`);
		return path.join(root, "scripts", `${slug}.json`);
	};
	const assetFile = (name: string): string => {
		if (!ASSET_RE.test(name) || name.includes("..")) throw new Error(`Invalid asset name: ${name}`);
		return path.join(root, "assets", name);
	};

	function getScript(slug: string): IllnessScript | null {
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(scriptFile(slug), "utf-8"));
			return isScript(parsed) && parsed.slug === slug ? parsed : null;
		} catch {
			return null;
		}
	}

	return {
		listScripts() {
			let names: string[];
			try {
				names = fs.readdirSync(path.join(root, "scripts"));
			} catch {
				return [];
			}
			const out: IllnessScript[] = [];
			for (const name of names) {
				if (!name.endsWith(".json")) continue;
				const script = getScript(name.slice(0, -5));
				if (script) out.push(script);
			}
			return out.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt) || a.slug.localeCompare(b.slug));
		},
		getScript,
		putScript(script, assets) {
			// Images first: a script never points at a file that isn't there yet.
			for (const a of assets) atomicWrite(assetFile(a.file), a.bytes);
			atomicWrite(scriptFile(script.slug), JSON.stringify(script, null, "\t"));
		},
		readAsset(file) {
			try {
				return new Uint8Array(fs.readFileSync(assetFile(file)));
			} catch {
				return null;
			}
		},
		assetSize(file) {
			try {
				return fs.statSync(assetFile(file)).size;
			} catch {
				return null;
			}
		},
		readCatalogue() {
			try {
				const parsed: unknown = JSON.parse(fs.readFileSync(path.join(root, "catalogue.json"), "utf-8"));
				if (!isRecord(parsed) || typeof parsed.builtAt !== "string" || typeof parsed.graphFp !== "string" || !Array.isArray(parsed.illnesses)) return null;
				return parsed as unknown as IllnessCatalogue;
			} catch {
				return null;
			}
		},
		writeCatalogue(catalogue) {
			atomicWrite(path.join(root, "catalogue.json"), JSON.stringify(catalogue, null, "\t"));
		},
	};
}

export const reviewStore: ReviewStore = createReviewStore(PATHS.review);
