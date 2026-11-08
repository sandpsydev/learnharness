/**
 * The placement stores (medical fork): the append-only placement ledger
 * (config.PLACEMENTS_FILE) and the placer's run journal
 * (config.PLACER_JOURNAL_FILE). Both sit in the graph directory family, so
 * they follow its format stamp: reads refuse a newer-stamped data dir, the
 * first write stamps it (store/graph-format.ts).
 *
 * Same idioms as store/graph.ts: sync fs, corrupt lines skipped (never
 * guessed at), tmp + rename for the rewrites.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PLACEMENTS_FILE, PLACER_JOURNAL_FILE } from "../../config.ts";
import { isOrganSystem } from "../core/contracts/graph.ts";
import { isPlacementAspect, type PlacementLine, type PlacerRun } from "../core/contracts/placement.ts";
import type { PlacementStore, PlacerJournalStore } from "../core/ports.ts";
import { assertGraphFormat, ensureGraphFormat } from "./graph-format.ts";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isString = (v: unknown): v is string => typeof v === "string";

export const isPlacementLine = (v: unknown): v is PlacementLine => {
	if (!isRecord(v)) return false;
	if (v.kind === "topic") return isString(v.id) && isString(v.name) && v.name.trim() !== "" && isOrganSystem(v.system) && isString(v.createdAt);
	if (v.kind === "place") {
		return (
			isString(v.nodeId) &&
			isString(v.topicId) &&
			isPlacementAspect(v.aspect) &&
			(v.source === "placer" || v.source === "learner") &&
			(v.confidence === "high" || v.confidence === "low") &&
			isString(v.at)
		);
	}
	if (v.kind === "clear") return isString(v.nodeId) && isString(v.at);
	return false;
};

function readLines(file: string): PlacementLine[] {
	assertGraphFormat();
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return [];
	}
	const out: PlacementLine[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (isPlacementLine(parsed)) out.push(parsed);
		} catch {
			/* a torn append must never take the outline down with it */
		}
	}
	return out;
}

function writeAtomic(file: string, body: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	ensureGraphFormat();
	const tmp = `${file}.tmp-${crypto.randomUUID().slice(0, 8)}`;
	try {
		fs.writeFileSync(tmp, body, "utf-8");
		fs.renameSync(tmp, file);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* the rename either already happened or the tmp never existed */
		}
		throw err;
	}
}

export function createPlacementStore(file: string = PLACEMENTS_FILE): PlacementStore {
	return {
		read: () => readLines(file),
		append(lines) {
			if (lines.length === 0) return;
			fs.mkdirSync(path.dirname(file), { recursive: true });
			ensureGraphFormat();
			fs.appendFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(""), "utf-8");
		},
		rewrite(lines) {
			writeAtomic(file, lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length > 0 ? "\n" : ""));
		},
	};
}

const isRun = (v: unknown): v is PlacerRun =>
	isRecord(v) &&
	isString(v.id) &&
	isString(v.startedAt) &&
	(v.kind === "backfill" || v.kind === "new") &&
	typeof v.placed === "number" &&
	typeof v.topicsCreated === "number";

export function createPlacerJournalStore(file: string = PLACER_JOURNAL_FILE): PlacerJournalStore {
	return {
		read() {
			try {
				const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
				return Array.isArray(parsed) ? parsed.filter(isRun) : [];
			} catch {
				return [];
			}
		},
		write(runs) {
			writeAtomic(file, JSON.stringify(runs));
		},
	};
}

export const placementStore: PlacementStore = createPlacementStore();
export const placerJournalStore: PlacerJournalStore = createPlacerJournalStore();
