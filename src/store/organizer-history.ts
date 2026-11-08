/**
 * The knowledge-organizer's undo journal (config.ORGANIZER_HISTORY_FILE): one
 * small JSON list of applied change sets, each with the line-level diff that
 * undoes it. Read-modify-write like sources.json, with the same tmp + rename
 * crash safety; a missing or unreadable file reads as "nothing applied yet".
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ORGANIZER_HISTORY_FILE } from "../../config.ts";
import type { OrganizerHistoryStore } from "../core/graph-organizer.ts";
import type { OrganizerHistoryEntry } from "../core/organizer-types.ts";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const isDiff = (v: unknown): boolean =>
	isRecord(v) &&
	Array.isArray(v.added) &&
	v.added.every((l) => typeof l === "string") &&
	Array.isArray(v.removed) &&
	v.removed.every((r) => isRecord(r) && typeof r.index === "number" && typeof r.line === "string");

const isEntry = (v: unknown): v is OrganizerHistoryEntry =>
	isRecord(v) &&
	typeof v.id === "string" &&
	typeof v.appliedAt === "string" &&
	typeof v.summary === "string" &&
	Array.isArray(v.previews) &&
	isDiff(v.nodes) &&
	isDiff(v.chains) &&
	(v.placements === undefined || isDiff(v.placements)) &&
	Array.isArray(v.createdNodeIds);

export function createOrganizerHistoryStore(file: string = ORGANIZER_HISTORY_FILE): OrganizerHistoryStore {
	return {
		read(): OrganizerHistoryEntry[] {
			try {
				const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
				return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
			} catch {
				return [];
			}
		},
		write(entries: OrganizerHistoryEntry[]): void {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const tmp = `${file}.tmp-${crypto.randomUUID().slice(0, 8)}`;
			try {
				fs.writeFileSync(tmp, JSON.stringify(entries), "utf-8");
				fs.renameSync(tmp, file);
			} catch (err) {
				try {
					fs.unlinkSync(tmp);
				} catch {
					/* the rename either already happened or the tmp never existed */
				}
				throw err;
			}
		},
	};
}

export const organizerHistoryStore: OrganizerHistoryStore = createOrganizerHistoryStore();
