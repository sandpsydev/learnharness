/**
 * The capture inbox (Phase 8 Pocket mode): the store, the API routes, the
 * text-only rule, and starting a teaching session from a capture. Runs in an
 * isolated data dir (LH_DATA_DIR is set BEFORE the app modules load);
 * nothing here touches the network or any account.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-captures-"));
process.env.LH_DATA_DIR = dataDir;

const { stores } = await import("../src/server/index.ts");
const { parseCaptureBody } = await import("../src/core/index.ts");
const listRoute = await import("../app/api/captures/route.ts");
const idRoute = await import("../app/api/captures/[id]/route.ts");
const startRoute = await import("../app/api/captures/[id]/start/route.ts");

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const jsonPost = (body: unknown) =>
	new Request("http://localhost/api/captures", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
const add = async (text: string) => (await (await listRoute.POST(jsonPost({ text }))).json()).capture;

describe("capture inbox", () => {
	after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

	it("adds a capture and lists it newest first", async () => {
		const first = await add("  Why does furosemide cause hypokalaemia?  ");
		await new Promise((r) => setTimeout(r, 5));
		const second = await add("Approach to hyponatraemia");
		assert.equal(first.text, "Why does furosemide cause hypokalaemia?", "text is trimmed");
		assert.equal(first.status, "open");
		assert.match(first.id, /^cp_[a-z0-9]+_[a-f0-9]{8}$/);
		const { captures } = await (await listRoute.GET(new Request("http://localhost/api/captures"))).json();
		assert.deepEqual(captures.map((c: { id: string }) => c.id), [second.id, first.id]);
		assert.ok(fs.existsSync(path.join(dataDir, "captures", "items.json")), "stored under the data dir");
	});

	it("marks a capture done and filters by status", async () => {
		const c = await add("Digoxin toxicity");
		const res = await idRoute.PATCH(
			new Request("http://localhost", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "done" }) }),
			params(c.id),
		);
		assert.equal((await res.json()).capture.status, "done");
		const open = await (await listRoute.GET(new Request("http://localhost/api/captures?status=open"))).json();
		const done = await (await listRoute.GET(new Request("http://localhost/api/captures?status=done"))).json();
		assert.ok(!open.captures.some((x: { id: string }) => x.id === c.id));
		assert.deepEqual(done.captures.map((x: { id: string }) => x.id), [c.id]);
		assert.equal((await listRoute.GET(new Request("http://localhost/api/captures?status=bogus"))).status, 400);
	});

	it("rejects a bad status and an unknown id on PATCH", async () => {
		const c = await add("Nephrotic vs nephritic");
		const patch = (id: string, body: unknown) =>
			idRoute.PATCH(new Request("http://localhost", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), params(id));
		assert.equal((await patch(c.id, { status: "archived" })).status, 400);
		assert.equal((await patch("cp_zzz_00000000", { status: "done" })).status, 404);
		assert.equal((await patch("../etc/passwd", { status: "done" })).status, 404);
	});

	it("deletes a capture", async () => {
		const c = await add("Delete me");
		assert.equal((await idRoute.DELETE(new Request("http://localhost"), params(c.id))).status, 200);
		assert.equal(stores.captureStore.get(c.id), null);
		assert.equal((await idRoute.DELETE(new Request("http://localhost"), params(c.id))).status, 404);
	});

	it("starts a teaching session from a capture: new session titled with it, capture done and linked", async () => {
		const c = await add("Explain the RAAS cascade");
		const res = await startRoute.POST(new Request("http://localhost", { method: "POST" }), params(c.id));
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.equal(body.text, "Explain the RAAS cascade");
		const chat = stores.chatStore.getChat(body.id);
		assert.ok(chat, "the session exists");
		assert.equal(chat.title, "Explain the RAAS cascade");
		assert.notEqual(chat.kind, "practice", "a teaching session, not practice");
		const after = stores.captureStore.get(c.id);
		assert.equal(after?.status, "done");
		assert.equal(after?.chatId, body.id);
		assert.equal((await startRoute.POST(new Request("http://localhost", { method: "POST" }), params("cp_zzz_00000000"))).status, 404);
	});

	it("is text only: attachments, extra fields and non-JSON bodies are refused", async () => {
		const before = stores.captureStore.list().length;
		for (const body of [
			{ text: "ok", image: "data:image/png;base64,AAAA" },
			{ text: "ok", file: "x.pdf" },
			{ text: "ok", attachments: [] },
			{ image: "data:image/png;base64,AAAA" },
			{ text: 42 },
			{ text: "   " },
			{ text: "x".repeat(2001) },
			["text"],
		]) {
			assert.equal((await listRoute.POST(jsonPost(body))).status, 400, JSON.stringify(body).slice(0, 60));
		}
		const form = new FormData();
		form.append("text", "a photo of a rash");
		form.append("file", new File([new Uint8Array([1, 2, 3])], "rash.jpg", { type: "image/jpeg" }));
		assert.equal((await listRoute.POST(new Request("http://localhost/api/captures", { method: "POST", body: form }))).status, 415);
		assert.equal(stores.captureStore.list().length, before, "nothing was stored");
	});

	it("parseCaptureBody trims and accepts plain text", () => {
		assert.deepEqual(parseCaptureBody({ text: " hi " }), { ok: true, text: "hi" });
		assert.equal(parseCaptureBody(null).ok, false);
	});
});
