/**
 * AnkiDraftStore — the fs JSON adapter for Anki card drafts (data/anki/, one
 * file per draft; docs/medical-spec.md Phase 5). A draft is the review
 * panel's working copy: it outlives closing the panel and a server restart,
 * and is deleted by the learner (or with "Discard"). Idioms as the chat
 * store: sync fs, id-guarded filenames, tab-indented JSON. Writes go through
 * a temp file + rename so a crash never leaves half a draft.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { AnkiDraft } from "../core/contracts.ts";

export interface AnkiDraftStore {
	get(id: string): AnkiDraft | null;
	/** Newest first. */
	list(): AnkiDraft[];
	/** Create or replace the whole draft. */
	save(draft: AnkiDraft): void;
	/** False when the id is unknown. */
	delete(id: string): boolean;
}

const ID_RE = /^[A-Za-z0-9_-]+$/;

export function isDraftId(id: string): boolean {
	return ID_RE.test(id);
}

export function newDraftId(): string {
	return `anki_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

export function createAnkiDraftStore(dir: string): AnkiDraftStore {
	const file = (id: string): string => {
		if (!ID_RE.test(id)) throw new Error(`Invalid draft id: ${id}`);
		return path.join(dir, `${id}.json`);
	};
	return {
		get(id) {
			if (!ID_RE.test(id)) return null;
			try {
				return JSON.parse(fs.readFileSync(file(id), "utf-8")) as AnkiDraft;
			} catch {
				return null;
			}
		},
		list() {
			let names: string[];
			try {
				names = fs.readdirSync(dir);
			} catch {
				return [];
			}
			const drafts: AnkiDraft[] = [];
			for (const name of names) {
				if (!name.endsWith(".json")) continue;
				try {
					drafts.push(JSON.parse(fs.readFileSync(path.join(dir, name), "utf-8")) as AnkiDraft);
				} catch {
					/* a torn or hand-edited file is skipped, never fatal */
				}
			}
			return drafts.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
		},
		save(draft) {
			fs.mkdirSync(dir, { recursive: true });
			const target = file(draft.id);
			const tmp = `${target}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(draft, null, "\t"), "utf-8");
			fs.renameSync(tmp, target);
		},
		delete(id) {
			if (!ID_RE.test(id)) return false;
			try {
				fs.unlinkSync(file(id));
				return true;
			} catch {
				return false;
			}
		},
	};
}

/** The live store: data/anki. */
export const ankiDraftStore: AnkiDraftStore = createAnkiDraftStore(path.join(PATHS.data, "anki"));
