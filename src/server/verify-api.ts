/**
 * THE LOCAL API THE BROWSER EXTENSION TALKS TO (medical fork, spec
 * "UpToDate Expert AI loop"). The contract lives in docs/verify-api.md —
 * keep the two in step.
 *
 * WHY A SEPARATE LISTENER: the app's own HTTP server takes a random port in
 * the desktop build and is walled off by a per-launch secret (proxy.ts), so
 * an extension could neither find it nor be trusted by it. This is a tiny
 * second server, started at boot (instrumentation.ts), on a FIXED loopback
 * port the extension can be configured with.
 *
 * THE GUARD (every request, in this order) — the point is that a web page
 * the learner happens to have open cannot talk to it:
 *   1. bound to 127.0.0.1 only — never reachable from the network;
 *   2. Host header must be 127.0.0.1:<port> or localhost:<port> — blocks
 *      DNS-rebinding (a hostile site resolving its own name to 127.0.0.1);
 *   3. Origin, when the browser sends one, must be a browser-extension
 *      origin (chrome-extension://…; pinnable to ONE extension id with
 *      LH_EXTENSION_ORIGIN) — a normal web page's origin is refused outright;
 *   4. a pairing token in `Authorization: Bearer …` on every call except
 *      ping — a web page cannot learn it, and cannot send the header
 *      cross-origin without a preflight this server answers only for
 *      extension origins;
 *   5. JSON bodies only (Content-Type: application/json), size-capped.
 *
 * The request logic is a pure function (handleVerifyRequest) so tests drive
 * it without sockets; startVerifyApi wraps it in node:http.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import {
	deliverAnswer,
	deliverHighlight,
	dismissItem,
	markAsked,
	nextQueued,
	noteExtensionContact,
	queueSnapshot,
	receiveAnswer,
	receiveHighlight,
	redeliverPending,
	type VerifyDeps,
	type VerifyOutcome,
} from "./verify.ts";

export const VERIFY_API_VERSION = 1;
export const DEFAULT_VERIFY_PORT = 47615;
const MAX_BODY_BYTES = 256 * 1024;

// ─── the pairing token ──────────────────────────────────────────────────────

const PAIRING_FILE = path.join(PATHS.data, "verify", "pairing.json");

/** The pairing secret: made once, kept in the data dir (0600), shown to the
 *  learner in Settings to paste into the extension. LH_VERIFY_TOKEN
 *  overrides it (dev and tests). */
export function pairingToken(): string {
	const fromEnv = process.env.LH_VERIFY_TOKEN;
	if (fromEnv && fromEnv.length >= 16) return fromEnv;
	try {
		const saved = (JSON.parse(fs.readFileSync(PAIRING_FILE, "utf-8")) as { token?: unknown }).token;
		if (typeof saved === "string" && saved.length >= 32) return saved;
	} catch {
		/* first run (or unreadable) — mint below */
	}
	const token = randomBytes(24).toString("hex");
	fs.mkdirSync(path.dirname(PAIRING_FILE), { recursive: true });
	fs.writeFileSync(PAIRING_FILE, JSON.stringify({ token }), { encoding: "utf-8", mode: 0o600 });
	return token;
}

function tokenMatches(supplied: string | undefined, expected: string): boolean {
	if (!supplied) return false;
	const a = Buffer.from(supplied);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

// ─── the pure handler ───────────────────────────────────────────────────────

export interface ApiRequest {
	method: string;
	/** Path without query string, e.g. "/v1/queue/vq_abc/answer". */
	path: string;
	query?: URLSearchParams;
	/** Lower-cased header names. */
	headers: Record<string, string | undefined>;
	body?: string;
}

export interface ApiResponse {
	status: number;
	headers: Record<string, string>;
	body: string;
	/** Work continuing after the reply (delivery to the session). Tests
	 *  await it; the server ignores it (errors are caught inside). */
	background?: Promise<unknown>;
}

export interface ApiContext {
	/** The port actually bound (for the Host check). */
	port: number;
	token: string;
	/** When set, the ONLY extension origin accepted. */
	pinnedOrigin?: string;
	deps?: VerifyDeps;
	now?: () => Date;
}

const EXTENSION_ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}$/;

function originAllowed(origin: string, ctx: ApiContext): boolean {
	if (ctx.pinnedOrigin) return origin === ctx.pinnedOrigin;
	return EXTENSION_ORIGIN_RE.test(origin);
}

function reply(status: number, payload: unknown, origin?: string, background?: Promise<unknown>): ApiResponse {
	return {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			...(origin
				? {
						"access-control-allow-origin": origin,
						vary: "Origin",
					}
				: {}),
		},
		body: payload === undefined ? "" : JSON.stringify(payload),
		...(background ? { background } : {}),
	};
}

function fail(status: number, code: string, message: string, origin?: string): ApiResponse {
	return reply(status, { ok: false, error: { code, message } }, origin);
}

const OUTCOME_STATUS = { not_found: 404, invalid: 400, conflict: 409 } as const;

function fromOutcome<T>(outcome: VerifyOutcome<T>, origin: string | undefined, ok: (value: T) => unknown, background?: (value: T) => Promise<unknown>): ApiResponse {
	if (!outcome.ok) return fail(OUTCOME_STATUS[outcome.code], outcome.code, outcome.message, origin);
	return reply(200, ok(outcome.value), origin, background?.(outcome.value));
}

function parseJson(body: string | undefined): { ok: true; value: unknown } | { ok: false } {
	if (!body) return { ok: true, value: {} };
	try {
		return { ok: true, value: JSON.parse(body) };
	} catch {
		return { ok: false };
	}
}

export async function handleVerifyRequest(req: ApiRequest, ctx: ApiContext): Promise<ApiResponse> {
	// 2. Host header (anti DNS-rebinding).
	const host = (req.headers.host ?? "").toLowerCase();
	if (host !== `127.0.0.1:${ctx.port}` && host !== `localhost:${ctx.port}`) {
		return fail(403, "bad_host", "Requests must address the app by its loopback address.");
	}
	// 3. Origin: absent (a non-browser client) is judged by the token below;
	// present means a browser, which must be an extension.
	const origin = req.headers.origin;
	if (origin !== undefined && !originAllowed(origin, ctx)) {
		return fail(403, "bad_origin", "Only the LearnHarness browser extension may call this API.");
	}
	const corsOrigin = origin;

	if (req.method === "OPTIONS") {
		if (!origin) return fail(403, "bad_origin", "Preflight needs an extension Origin.");
		return {
			status: 204,
			headers: {
				"access-control-allow-origin": origin,
				"access-control-allow-methods": "GET, POST, OPTIONS",
				"access-control-allow-headers": "authorization, content-type",
				"access-control-max-age": "600",
				vary: "Origin",
				"cache-control": "no-store",
			},
			body: "",
		};
	}

	const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "")?.[1];
	const authenticated = tokenMatches(bearer, ctx.token);

	// Ping is the one tokenless call: "is the app running, and am I paired?"
	if (req.method === "GET" && req.path === "/v1/ping") {
		if (authenticated) noteExtensionContact(ctx.now?.());
		return reply(200, { ok: true, app: "learnharness", apiVersion: VERIFY_API_VERSION, authenticated }, corsOrigin);
	}

	// 4. The pairing token.
	if (!authenticated) return fail(401, "unauthorized", "Missing or wrong pairing token. Copy it from LearnHarness → Settings.", corsOrigin);
	noteExtensionContact(ctx.now?.());

	// 5. JSON only.
	let body: unknown;
	if (req.method === "POST") {
		if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
			return fail(415, "unsupported_media_type", "POST bodies must be application/json.", corsOrigin);
		}
		const parsed = parseJson(req.body);
		if (!parsed.ok) return fail(400, "invalid", "Body is not valid JSON.", corsOrigin);
		body = parsed.value;
	}

	if (req.method === "GET" && req.path === "/v1/queue") {
		return reply(200, { ok: true, items: queueSnapshot() }, corsOrigin);
	}

	if (req.method === "POST" && req.path === "/v1/highlights") {
		return fromOutcome(
			receiveHighlight(body, ctx.now?.()),
			corsOrigin,
			(h) => ({ ok: true, id: h.id, chatId: h.chatId }),
			(h) => Promise.resolve().then(() => deliverHighlight(h.id, ctx.deps)),
		);
	}

	const itemRoute = /^\/v1\/queue\/([A-Za-z0-9_-]+)\/(asked|answer|dismiss)$/.exec(req.path);
	if (req.method === "POST" && itemRoute) {
		const [, id, action] = itemRoute as unknown as [string, string, string];
		if (action === "asked") return fromOutcome(markAsked(id), corsOrigin, (i) => ({ ok: true, id: i.id, status: i.status }));
		if (action === "dismiss") return fromOutcome(dismissItem(id), corsOrigin, (i) => ({ ok: true, id: i.id, status: i.status, next: nextQueued(i.id) }));
		return fromOutcome(
			receiveAnswer(id, body, ctx.now?.()),
			corsOrigin,
			(i) => ({ ok: true, id: i.id, status: i.status, next: nextQueued(i.id) }),
			(i) => deliverAnswer(i.id, ctx.deps),
		);
	}

	return fail(404, "not_found", `No such endpoint: ${req.method} ${req.path}`, corsOrigin);
}

// ─── the node:http listener ─────────────────────────────────────────────────

export interface VerifyApiHandle {
	port: number;
	close(): Promise<void>;
}

interface LhVerifyApiGlobal {
	__lhVerifyApi?: VerifyApiHandle | null;
}

function slot(): LhVerifyApiGlobal {
	return globalThis as typeof globalThis & LhVerifyApiGlobal;
}

/** The running listener, or null (not started, or the port was taken). */
export function verifyApiHandle(): VerifyApiHandle | null {
	return slot().__lhVerifyApi ?? null;
}

function configuredPort(): number {
	const raw = Number(process.env.LH_VERIFY_PORT);
	return Number.isInteger(raw) && raw >= 0 && raw <= 65535 ? raw : DEFAULT_VERIFY_PORT;
}

/** Start the loopback listener (idempotent per process). Resolves null —
 *  and the app carries on without the extension API — when the port is
 *  already taken (a second LearnHarness instance, say). */
export function startVerifyApi(opts: { port?: number; deps?: VerifyDeps; token?: string } = {}): Promise<VerifyApiHandle | null> {
	const existing = slot().__lhVerifyApi;
	if (existing) return Promise.resolve(existing);
	const token = opts.token ?? pairingToken();
	const pinnedOrigin = process.env.LH_EXTENSION_ORIGIN || undefined;
	let boundPort = 0;

	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let tooBig = false;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				tooBig = true;
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			const send = (r: ApiResponse) => {
				res.writeHead(r.status, r.headers);
				res.end(r.body);
			};
			if (tooBig) return send(fail(413, "too_large", `Body is over ${MAX_BODY_BYTES} bytes.`));
			const headers: Record<string, string | undefined> = {};
			for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(", ") : v;
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			handleVerifyRequest(
				{ method: req.method ?? "GET", path: url.pathname, query: url.searchParams, headers, body: Buffer.concat(chunks).toString("utf-8") },
				{ port: boundPort, token, pinnedOrigin, deps: opts.deps },
			).then(send, (err: unknown) => {
				console.error("[verify-api] request failed:", err);
				send(fail(500, "internal", "The app hit an error handling that request."));
			});
		});
	});
	server.headersTimeout = 10_000;
	server.requestTimeout = 15_000;

	return new Promise((resolve) => {
		server.once("error", (err: NodeJS.ErrnoException) => {
			console.warn(
				err.code === "EADDRINUSE"
					? `[verify-api] port ${opts.port ?? configuredPort()} is in use (another LearnHarness running?) — the browser-extension API is off for this instance.`
					: `[verify-api] could not start: ${err.message}`,
			);
			slot().__lhVerifyApi = null;
			resolve(null);
		});
		server.listen(opts.port ?? configuredPort(), "127.0.0.1", () => {
			boundPort = (server.address() as { port: number }).port;
			const handle: VerifyApiHandle = {
				port: boundPort,
				close: () =>
					new Promise((done) => {
						slot().__lhVerifyApi = null;
						server.close(() => done());
						server.closeAllConnections();
					}),
			};
			slot().__lhVerifyApi = handle;
			// After startup, an error is logged, never a crash or a second resolve.
			server.removeAllListeners("error");
			server.on("error", (err) => console.error("[verify-api] server error:", err));
			// Anything answered before a crash but never handed to a session.
			void redeliverPending(opts.deps);
			resolve(handle);
		});
	});
}
