/**
 * The drug back-fill's progress file (config.PHARMACOLOGY_BACKFILL_FILE): the
 * ids of facts already looked at and the time the pass finished. Sits in the
 * graph directory family, so it follows the graph format stamp (reads refuse a
 * newer-stamped data dir, the first write stamps it). Tmp + rename for writes.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PHARMACOLOGY_BACKFILL_FILE } from "../../config.ts";
import { assertGraphFormat, ensureGraphFormat } from "./graph-format.ts";

export interface PharmacologyBackfillState {
	/** Fact ids already looked at (a drug fact among them was upgraded). */
	checked: string[];
	/** Set once every fact has been looked at; the pass never runs again. */
	completedAt?: string;
}

export interface PharmacologyBackfillStore {
	read(): PharmacologyBackfillState;
	write(state: PharmacologyBackfillState): void;
}

export function createPharmacologyBackfillStore(file: string = PHARMACOLOGY_BACKFILL_FILE): PharmacologyBackfillStore {
	return {
		read() {
			assertGraphFormat();
			try {
				const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { checked?: unknown; completedAt?: unknown };
				const checked = Array.isArray(parsed.checked) ? parsed.checked.filter((v): v is string => typeof v === "string") : [];
				return { checked, ...(typeof parsed.completedAt === "string" ? { completedAt: parsed.completedAt } : {}) };
			} catch {
				return { checked: [] };
			}
		},
		write(state) {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			ensureGraphFormat();
			const tmp = `${file}.tmp-${crypto.randomUUID().slice(0, 8)}`;
			try {
				fs.writeFileSync(tmp, JSON.stringify(state), "utf-8");
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

export const pharmacologyBackfillStore: PharmacologyBackfillStore = createPharmacologyBackfillStore();
