/**
 * THE GUARDED FETCH for real figures (medical fork). Every network read the
 * figure finder makes goes through here, so the rules live in one place:
 *
 *  - https only, no credentials in the URL, and the host must pass the caller's
 *    allow check — on EVERY redirect hop, not just the first request;
 *  - no cookies, no auth headers, no browser disguise: an honest user agent;
 *  - a hard time limit and a hard byte limit (the body is read as a stream and
 *    cut off, so a lying Content-Length cannot get past it);
 *  - an image is accepted by what its BYTES are (png, jpeg, gif, webp), never by
 *    the header the server sent;
 *  - a site that refuses automated reads (403, 406, 429, a challenge page) comes
 *    back as `blocked` — the caller then falls back to a link, never works around it.
 */

import { detectSupportedImageMimeType } from "../image-processing/index.ts";
import { httpsUrl, type FigureImageMime } from "../../core/figures.ts";

export const FIGURE_USER_AGENT = "LearnHarness/1.0 (personal study app; figure lookup; https://github.com/sandpsydev/learnharness)";
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const PAGE_MAX_BYTES = 2 * 1024 * 1024;
/** Each limit is below the 30 s a tool call is allowed (agent/tool-execute.ts). */
export const IMAGE_TIMEOUT_MS = 15_000;
export const PAGE_TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 4;

export type FetchFailure = {
	ok: false;
	/** blocked = the site refuses automated reads; the rest are plain failures. */
	reason: "blocked" | "disallowed" | "bad-url" | "too-large" | "not-an-image" | "timeout" | "http" | "network" | "aborted";
	message: string;
	status?: number;
};

export interface FetchOptions {
	/** Whether this https URL may be read. Called for the first URL and every redirect target. */
	allow: (url: URL) => boolean;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	maxBytes?: number;
	signal?: AbortSignal;
	accept?: string;
}

export type BytesResult = { ok: true; bytes: Uint8Array; contentType: string; finalUrl: string } | FetchFailure;

const BLOCKED_STATUSES = new Set([401, 403, 406, 429, 451, 503]);

const fail = (reason: FetchFailure["reason"], message: string, status?: number): FetchFailure => ({
	ok: false,
	reason,
	message,
	...(status !== undefined ? { status } : {}),
});

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array | "too-large"> {
	const declared = Number(response.headers.get("content-length") ?? 0);
	if (declared > maxBytes) return "too-large";
	if (!response.body) {
		const whole = new Uint8Array(await response.arrayBuffer());
		return whole.byteLength > maxBytes ? "too-large" : whole;
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			void reader.cancel().catch(() => {}); // not awaited: closing the stream must never hold the answer up
			return "too-large";
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.byteLength;
	}
	return out;
}

export async function fetchGuarded(rawUrl: string, opts: FetchOptions): Promise<BytesResult> {
	const doFetch = opts.fetchImpl ?? fetch;
	const maxBytes = opts.maxBytes ?? PAGE_MAX_BYTES;
	const timeoutMs = opts.timeoutMs ?? PAGE_TIMEOUT_MS;
	const first = httpsUrl(rawUrl);
	if (!first) return fail("bad-url", `Only plain https URLs can be fetched: ${rawUrl}`);
	let current: URL = first;
	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
	try {
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			if (!opts.allow(current)) return fail("disallowed", `${current.hostname} is not on the list of figure sources.`);
			const response: Response = await doFetch(current.toString(), {
				redirect: "manual",
				credentials: "omit",
				signal,
				headers: { "User-Agent": FIGURE_USER_AGENT, Accept: opts.accept ?? "*/*" },
			});
			if (response.status >= 300 && response.status < 400) {
				const location: string | null = response.headers.get("location");
				void response.body?.cancel().catch(() => {});
				const next: URL | null = location ? httpsUrl(new URL(location, current).toString()) : null;
				if (!next) return fail("bad-url", "The site redirected somewhere that is not a plain https URL.", response.status);
				current = next;
				continue;
			}
			if (BLOCKED_STATUSES.has(response.status)) {
				void response.body?.cancel().catch(() => {});
				return fail("blocked", `${current.hostname} refused the request (HTTP ${response.status}); it does not allow automated downloads.`, response.status);
			}
			if (!response.ok) {
				void response.body?.cancel().catch(() => {});
				return fail("http", `${current.hostname} answered HTTP ${response.status}.`, response.status);
			}
			const body = await readCapped(response, maxBytes);
			if (body === "too-large") return fail("too-large", `The file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.`);
			return { ok: true, bytes: body, contentType: response.headers.get("content-type") ?? "", finalUrl: current.toString() };
		}
		return fail("bad-url", "Too many redirects.");
	} catch (err) {
		if (opts.signal?.aborted) return fail("aborted", "Aborted.");
		if (timeout.aborted) return fail("timeout", `No answer within ${Math.round(timeoutMs / 1000)} seconds.`);
		return fail("network", err instanceof Error ? err.message : String(err));
	}
}

export type ImageResult = { ok: true; bytes: Uint8Array; mime: FigureImageMime; finalUrl: string } | FetchFailure;

/** Fetch one picture; it must be a png, jpeg, gif or webp by its own bytes. */
export async function fetchFigureImage(rawUrl: string, opts: Omit<FetchOptions, "maxBytes" | "timeoutMs" | "accept">): Promise<ImageResult> {
	const result = await fetchGuarded(rawUrl, { ...opts, maxBytes: IMAGE_MAX_BYTES, timeoutMs: IMAGE_TIMEOUT_MS, accept: "image/png,image/jpeg,image/webp,image/gif" });
	if (!result.ok) return result;
	const mime = detectSupportedImageMimeType(result.bytes);
	if (mime !== "image/png" && mime !== "image/jpeg" && mime !== "image/gif" && mime !== "image/webp") {
		return fail("not-an-image", "That URL did not return a PNG, JPEG, GIF or WebP picture.");
	}
	return { ok: true, bytes: result.bytes, mime, finalUrl: result.finalUrl };
}

export type TextResult = { ok: true; text: string; finalUrl: string; contentType: string } | FetchFailure;

/** Fetch a page or an API answer as text. */
export async function fetchFigureText(rawUrl: string, opts: Omit<FetchOptions, "maxBytes" | "timeoutMs">): Promise<TextResult> {
	const result = await fetchGuarded(rawUrl, { ...opts, maxBytes: PAGE_MAX_BYTES, timeoutMs: PAGE_TIMEOUT_MS, accept: opts.accept ?? "text/html,application/xhtml+xml,application/json,application/xml;q=0.9" });
	if (!result.ok) return result;
	return { ok: true, text: new TextDecoder("utf-8").decode(result.bytes), finalUrl: result.finalUrl, contentType: result.contentType };
}
