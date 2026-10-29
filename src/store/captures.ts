/**
 * CaptureStore — the fs JSON adapter for the capture inbox (data/captures/).
 * One small read-modify-write file, items.json, same idioms as the verify
 * store: sync fs, tab-indented JSON, temp file + rename so a crash never
 * leaves a half-written list. Implements core/ports.ts CaptureStore.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { CaptureStore } from "../core/ports.ts";
import type { CaptureItem } from "../core/contracts.ts";

/** Not in config.ts PATHS (same convention as data/verify and data/jobs). */
const CAPTURES_DIR = path.join(PATHS.data, "captures");
const ITEMS_FILE = path.join(CAPTURES_DIR, "items.json");

function readAll(): CaptureItem[] {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(ITEMS_FILE, "utf-8"));
		return Array.isArray(parsed) ? (parsed as CaptureItem[]) : [];
	} catch {
		return [];
	}
}

function writeAll(list: readonly CaptureItem[]): void {
	fs.mkdirSync(CAPTURES_DIR, { recursive: true });
	const tmp = `${ITEMS_FILE}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(list, null, "\t"), "utf-8");
	fs.renameSync(tmp, ITEMS_FILE);
}

export const captureStore: CaptureStore = {
	add(text) {
		const now = new Date().toISOString();
		const item: CaptureItem = {
			id: `cp_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
			text,
			status: "open",
			createdAt: now,
			updatedAt: now,
		};
		writeAll([...readAll(), item]);
		return item;
	},
	get: (id) => readAll().find((c) => c.id === id) ?? null,
	list: (status) =>
		readAll()
			.filter((c) => !status || c.status === status)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
	update(id, patch) {
		const list = readAll();
		const index = list.findIndex((c) => c.id === id);
		if (index < 0) return null;
		const next: CaptureItem = { ...list[index]!, ...patch, updatedAt: new Date().toISOString() };
		list[index] = next;
		writeAll(list);
		return next;
	},
	remove(id) {
		const list = readAll();
		const kept = list.filter((c) => c.id !== id);
		if (kept.length === list.length) return false;
		writeAll(kept);
		return true;
	},
};
