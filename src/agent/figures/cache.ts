/**
 * THE SESSION FIGURE CACHE (medical fork): every picture the finder fetches or
 * renders is written once to `data/figures/<chatId>/<key>.<ext>` and reused for
 * the rest of the session, so a figure is never fetched twice. The lesson card
 * loads it from app/api/figures/<chatId>/<file>. Deleting the session deletes
 * its folder.
 *
 * The key is a hash of what was fetched (the image URL, or book + page + dpi for
 * a lecture slide), so the same picture always lands on the same file name. Only
 * names of the form `<24 hex>.<png|jpg|gif|webp>` under a `chat_…` folder are ever
 * read or written — nothing the model or a URL says can name another path.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	FIGURE_CHAT_PATTERN,
	FIGURE_FILE_PATTERN,
	FIGURE_IMAGE_EXTENSIONS,
	FIGURE_MIME_BY_EXTENSION,
	type FigureImageMime,
} from "../../core/figures.ts";

export function figureKey(...parts: (string | number)[]): string {
	return crypto.createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24);
}

function chatDir(root: string, chatId: string): string | null {
	return FIGURE_CHAT_PATTERN.test(chatId) ? path.join(root, chatId) : null;
}

export interface CachedFigure {
	file: string;
	mime: FigureImageMime;
	bytes: Uint8Array;
}

/** A picture already cached for this session, or null. */
export function readCachedFigure(root: string, chatId: string, file: string): CachedFigure | null {
	const dir = chatDir(root, chatId);
	if (!dir || !FIGURE_FILE_PATTERN.test(file)) return null;
	const mime = FIGURE_MIME_BY_EXTENSION[file.split(".").pop()!];
	if (!mime) return null;
	try {
		return { file, mime, bytes: new Uint8Array(fs.readFileSync(path.join(dir, file))) };
	} catch {
		return null;
	}
}

/** The cached picture for a key, whichever extension it was stored under. */
export function findCachedFigure(root: string, chatId: string, key: string): CachedFigure | null {
	for (const ext of Object.values(FIGURE_IMAGE_EXTENSIONS)) {
		const hit = readCachedFigure(root, chatId, `${key}.${ext}`);
		if (hit) return hit;
	}
	return null;
}

export function writeCachedFigure(root: string, chatId: string, key: string, mime: FigureImageMime, bytes: Uint8Array): CachedFigure {
	const dir = chatDir(root, chatId);
	if (!dir) throw new Error("Not a chat id");
	const file = `${key}.${FIGURE_IMAGE_EXTENSIONS[mime]}`;
	fs.mkdirSync(dir, { recursive: true });
	// Write beside, then rename: a half-written file is never served.
	const temp = path.join(dir, `.${file}.${crypto.randomUUID().slice(0, 8)}.tmp`);
	fs.writeFileSync(temp, bytes);
	fs.renameSync(temp, path.join(dir, file));
	return { file, mime, bytes };
}

/** Delete a session's pictures (the session itself was deleted). */
export function removeChatFigures(root: string, chatId: string): void {
	const dir = chatDir(root, chatId);
	if (dir) fs.rmSync(dir, { recursive: true, force: true });
}
