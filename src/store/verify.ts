/**
 * VerifyStore — the fs JSON adapter for the Expert AI question queue and the
 * learner's highlights (data/verify/). Two small read-modify-write files:
 * items.json (the queue, oldest first) and highlights.json. Implements
 * core/ports.ts VerifyStore. Idioms follow the job store: sync fs, tab-
 * indented JSON; every read-modify-write section contains no awaits, so it
 * is atomic within the single-threaded event loop. Writes go through a temp
 * file + rename so a crash never leaves a half-written queue.
 *
 * The loopback API (src/server/verify-api.ts) and the agent's verify_queue
 * tool both reach this file; the API may run in a different module instance
 * than the routes (Next compiles instrumentation separately), which is fine
 * because the state is the file, never a module variable.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { NewVerifyItem, VerifyItemPatch, VerifyStore } from "../core/ports.ts";
import type { VerifyHighlight, VerifyItem, VerifyStatus } from "../core/contracts.ts";

/** Not in config.ts PATHS (same convention as data/jobs). */
const VERIFY_DIR = path.join(PATHS.data, "verify");
const ITEMS_FILE = path.join(VERIFY_DIR, "items.json");
const HIGHLIGHTS_FILE = path.join(VERIFY_DIR, "highlights.json");

function readList<T>(file: string): T[] {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
		return Array.isArray(parsed) ? (parsed as T[]) : [];
	} catch {
		return [];
	}
}

function writeList(file: string, list: readonly unknown[]): void {
	fs.mkdirSync(VERIFY_DIR, { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(list, null, "\t"), "utf-8");
	fs.renameSync(tmp, file);
}

function mintId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

function addItems(chatId: string, inits: readonly NewVerifyItem[]): VerifyItem[] {
	const items = readList<VerifyItem>(ITEMS_FILE);
	const out: VerifyItem[] = [];
	const now = new Date().toISOString();
	let changed = false;
	for (const init of inits) {
		const prompt = init.prompt.trim();
		const dup = items.find(
			(i) => i.chatId === chatId && i.prompt === prompt && (i.status === "queued" || i.status === "asked"),
		);
		if (dup) {
			out.push(dup);
			continue;
		}
		const item: VerifyItem = {
			id: mintId("vq"),
			chatId,
			prompt,
			...(init.provisionalClaim?.trim() ? { provisionalClaim: init.provisionalClaim.trim() } : {}),
			status: "queued",
			createdAt: now,
			updatedAt: now,
		};
		items.push(item);
		out.push(item);
		changed = true;
	}
	if (changed) writeList(ITEMS_FILE, items);
	return out;
}

function getItem(id: string): VerifyItem | null {
	return readList<VerifyItem>(ITEMS_FILE).find((i) => i.id === id) ?? null;
}

function listItems(filter?: { chatId?: string; status?: readonly VerifyStatus[] }): VerifyItem[] {
	return readList<VerifyItem>(ITEMS_FILE)
		.filter((i) => !filter?.chatId || i.chatId === filter.chatId)
		.filter((i) => !filter?.status || filter.status.includes(i.status))
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function updateItem(id: string, patch: VerifyItemPatch): VerifyItem | null {
	const items = readList<VerifyItem>(ITEMS_FILE);
	const index = items.findIndex((i) => i.id === id);
	if (index < 0) return null;
	const next: VerifyItem = { ...items[index]!, ...patch, updatedAt: new Date().toISOString() };
	items[index] = next;
	writeList(ITEMS_FILE, items);
	return next;
}

function addHighlight(h: Omit<VerifyHighlight, "id" | "receivedAt"> & { receivedAt?: string }): VerifyHighlight {
	const list = readList<VerifyHighlight>(HIGHLIGHTS_FILE);
	const record: VerifyHighlight = { ...h, id: mintId("vh"), receivedAt: h.receivedAt ?? new Date().toISOString() };
	list.push(record);
	writeList(HIGHLIGHTS_FILE, list);
	return record;
}

function getHighlight(id: string): VerifyHighlight | null {
	return readList<VerifyHighlight>(HIGHLIGHTS_FILE).find((h) => h.id === id) ?? null;
}

function updateHighlight(id: string, patch: Partial<Omit<VerifyHighlight, "id">>): VerifyHighlight | null {
	const list = readList<VerifyHighlight>(HIGHLIGHTS_FILE);
	const index = list.findIndex((h) => h.id === id);
	if (index < 0) return null;
	const next: VerifyHighlight = { ...list[index]!, ...patch };
	list[index] = next;
	writeList(HIGHLIGHTS_FILE, list);
	return next;
}

function deleteForChat(chatId: string): number {
	let removed = 0;
	const items = readList<VerifyItem>(ITEMS_FILE);
	const keptItems = items.filter((i) => i.chatId !== chatId);
	if (keptItems.length !== items.length) {
		removed += items.length - keptItems.length;
		writeList(ITEMS_FILE, keptItems);
	}
	const highlights = readList<VerifyHighlight>(HIGHLIGHTS_FILE);
	const keptHighlights = highlights.filter((h) => h.chatId !== chatId);
	if (keptHighlights.length !== highlights.length) {
		removed += highlights.length - keptHighlights.length;
		writeList(HIGHLIGHTS_FILE, keptHighlights);
	}
	return removed;
}

export const verifyStore: VerifyStore = {
	addItems,
	getItem,
	listItems,
	updateItem,
	addHighlight,
	getHighlight,
	updateHighlight,
	deleteForChat,
};
