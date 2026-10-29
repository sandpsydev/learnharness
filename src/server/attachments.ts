/**
 * Pasted / dropped images (medical fork, Phase 7 — Explain my miss).
 *
 * A screenshot the learner pastes with Cmd+V has no file on disk, so it is
 * saved into the app's data dir and then attached exactly like a dropped
 * file: as a quoted path in the message (upstream's file-path chips). The
 * model sees the picture when it `read`s that path (the read tool turns
 * image files into model-visible image content). Nothing leaves the
 * machine here; the bytes stay in data/attachments.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { detectSupportedImageMimeType } from "../agent/image-processing/mime.mjs";

/** Largest image accepted. A full-screen retina screenshot is a few MB; the
 *  read tool shrinks it again before the model sees it. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const EXTENSION: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/bmp": "bmp",
};

export type AttachmentResult =
	| { ok: true; path: string }
	| { ok: false; status: 400 | 413 | 415; error: string };

/**
 * Save one image into the attachments folder. The file type comes from the
 * bytes themselves (not the name or the declared type), so a renamed file
 * cannot slip through. `dir` is a test seam; the app always uses the data dir.
 */
export function saveImageAttachment(bytes: Uint8Array, dir: string = PATHS.attachments): AttachmentResult {
	if (bytes.byteLength === 0) return { ok: false, status: 400, error: "The image was empty." };
	if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
		return {
			ok: false,
			status: 413,
			error: `That image is larger than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB. Crop the screenshot and try again.`,
		};
	}
	const mime = detectSupportedImageMimeType(bytes);
	const extension = mime ? EXTENSION[mime] : undefined;
	if (!extension) {
		return { ok: false, status: 415, error: "Only PNG, JPEG, GIF, WebP or BMP images can be attached this way." };
	}
	fs.mkdirSync(dir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
	const file = path.join(dir, `pasted-${stamp}-${crypto.randomUUID().slice(0, 8)}.${extension}`);
	fs.writeFileSync(file, bytes, { flag: "wx" });
	return { ok: true, path: file };
}
