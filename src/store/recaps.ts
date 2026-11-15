/**
 * RecapStore — the fs adapter for session recaps (medical fork): the recap the
 * app wrote for each teaching session and the pictures it embeds.
 *
 *   data/recaps/sessions/<chatId>.json   one SessionRecap per session
 *   data/recaps/assets/<file>            figures and drawn diagrams (names carry the session)
 *
 * This is LearnHarness's own copy; the Obsidian notes are rendered from it
 * (core/session-recap.ts), so a lost or moved vault never loses a recap and
 * rebuilding one costs nothing. `createRecapStore(root)` exists so tests can
 * use a temp directory.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { SessionRecap } from "../core/contracts.ts";
import type { RecapStore } from "../core/ports.ts";

const CHAT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;
/** An asset name is a plain file name: no folders, no dots at the front. */
const ASSET_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,170}\.(png|jpg|jpeg|gif|webp|svg)$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function isRecap(v: unknown): v is SessionRecap {
	if (!isRecord(v)) return false;
	return (
		typeof v.chatId === "string" &&
		CHAT_ID_RE.test(v.chatId) &&
		typeof v.title === "string" &&
		typeof v.sessionDate === "string" &&
		typeof v.generatedAt === "string" &&
		typeof v.summary === "string" &&
		Array.isArray(v.topics) &&
		Array.isArray(v.misses) &&
		Array.isArray(v.selfTest)
	);
}

function atomicWrite(file: string, data: string | Uint8Array): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, data);
	fs.renameSync(tmp, file);
}

export function createRecapStore(root: string): RecapStore {
	const recapFile = (chatId: string): string => {
		if (!CHAT_ID_RE.test(chatId)) throw new Error(`Invalid session id: ${chatId}`);
		return path.join(root, "sessions", `${chatId}.json`);
	};
	const assetFile = (name: string): string => {
		if (!ASSET_RE.test(name) || name.includes("..")) throw new Error(`Invalid asset name: ${name}`);
		return path.join(root, "assets", name);
	};

	function get(chatId: string): SessionRecap | null {
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(recapFile(chatId), "utf-8"));
			return isRecap(parsed) && parsed.chatId === chatId ? parsed : null;
		} catch {
			return null;
		}
	}

	return {
		list() {
			let names: string[];
			try {
				names = fs.readdirSync(path.join(root, "sessions"));
			} catch {
				return [];
			}
			const out: SessionRecap[] = [];
			for (const name of names) {
				if (!name.endsWith(".json")) continue;
				const recap = get(name.slice(0, -5));
				if (recap) out.push(recap);
			}
			return out.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt) || a.chatId.localeCompare(b.chatId));
		},
		get,
		put(recap, assets) {
			// Images first: a recap never points at a file that isn't there yet.
			for (const a of assets) atomicWrite(assetFile(a.file), a.bytes);
			atomicWrite(recapFile(recap.chatId), JSON.stringify(recap, null, "\t"));
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
	};
}

export const recapStore: RecapStore = createRecapStore(PATHS.recaps);
