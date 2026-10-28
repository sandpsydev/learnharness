/**
 * The /api/anki routes (docs/medical-spec.md Phase 5): request validation and
 * status mapping on the wired service, under an isolated LH_DATA_DIR. Nothing
 * here can reach Anki: every case is refused before a push, and the AnkiConnect
 * client refuses to run under NODE_ENV=test without an injected fetch.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-anki-routes-"));
process.env.LH_DATA_DIR = TMP_DATA;
after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const drafts = await import("../app/api/anki/drafts/route.ts");
const one = await import("../app/api/anki/drafts/[id]/route.ts");
const push = await import("../app/api/anki/drafts/[id]/push/route.ts");
const stop = await import("../app/api/anki/drafts/[id]/stop/route.ts");

const post = (body: unknown) =>
	drafts.POST(new Request("http://localhost/api/anki/drafts", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("/api/anki routes", () => {
	it("rejects a body that is not JSON or not an origin", async () => {
		assert.equal((await post("{nope")).status, 400);
		assert.equal((await post({})).status, 400);
		assert.equal((await post({ origin: { kind: "nodes", nodeIds: [] } })).status, 400);
		const res = await post({ origin: { kind: "session" } });
		assert.equal(res.status, 400);
		assert.equal(((await res.json()) as { code: string }).code, "bad_request");
	});

	it("404s an unknown session or node", async () => {
		assert.equal((await post({ origin: { kind: "session", chatId: "chat_nope" } })).status, 404);
		assert.equal((await post({ origin: { kind: "nodes", nodeIds: ["n_nope"] } })).status, 404);
	});

	it("answers a library section with an honest message while the library has no books", async () => {
		const res = await post({ origin: { kind: "library", bookId: "book_nope", pages: "1-5" } });
		assert.equal(res.status, 404);
		assert.match(((await res.json()) as { error: string }).error, /no searchable books/);
		assert.equal((await post({ origin: { kind: "library", bookId: "b" } })).status, 400);
	});

	it("lists no drafts at first, and 404s every per-draft route for an unknown id", async () => {
		const list = await drafts.GET(new Request("http://localhost/api/anki/drafts"));
		assert.deepEqual(await list.json(), { drafts: [] });
		assert.equal((await one.GET(new Request("http://x"), ctx("anki_nope"))).status, 404);
		assert.equal((await one.PUT(new Request("http://x", { method: "PUT", body: JSON.stringify({ cards: [] }) }), ctx("anki_nope"))).status, 404);
		assert.equal((await one.DELETE(new Request("http://x", { method: "DELETE" }), ctx("anki_nope"))).status, 404);
		assert.equal((await push.POST(new Request("http://x", { method: "POST", body: "{}" }), ctx("anki_nope"))).status, 404);
		assert.equal((await stop.POST(new Request("http://x", { method: "POST" }), ctx("anki_nope"))).status, 409);
		assert.equal((await one.GET(new Request("http://x"), ctx("../etc/passwd"))).status, 404, "ids are guarded");
	});
});
