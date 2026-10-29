/**
 * The text-only rule for the capture inbox, as one pure function the API
 * route and the tests share. A capture body is exactly `{ text: string }`:
 * anything else — an unknown field such as `image`, `file` or `attachments`,
 * a non-string text — is refused, so an attachment cannot slip in sideways.
 */

import { MAX_CAPTURE_CHARS } from "./contracts/captures.ts";

export type CaptureTextResult = { ok: true; text: string } | { ok: false; error: string };

export function parseCaptureBody(body: unknown): CaptureTextResult {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return { ok: false, error: "Send a JSON object like {\"text\": \"…\"}." };
	}
	const extra = Object.keys(body).filter((k) => k !== "text");
	if (extra.length > 0) {
		return { ok: false, error: "Captures are text only — photos and files are not accepted." };
	}
	const text = (body as { text?: unknown }).text;
	if (typeof text !== "string") return { ok: false, error: "Captures need a text field." };
	const trimmed = text.trim();
	if (!trimmed) return { ok: false, error: "Type a question or topic first." };
	if (trimmed.length > MAX_CAPTURE_CHARS) {
		return { ok: false, error: `Keep a capture under ${MAX_CAPTURE_CHARS} characters.` };
	}
	return { ok: true, text: trimmed };
}
