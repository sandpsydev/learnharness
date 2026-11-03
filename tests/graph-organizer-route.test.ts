/**
 * The organizer's HTTP routes: request validation and the status mapping of
 * the service's outcomes. The service itself is covered in
 * graph-organizer-agent.test.ts; here it is swapped for scripted outcomes.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { GET, POST } from "../app/api/graph/organizer/route.ts";
import { POST as APPLY } from "../app/api/graph/organizer/apply/route.ts";
import { POST as UNDO } from "../app/api/graph/organizer/undo/route.ts";
import { graphOrganizer } from "../src/server/index.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../src/core/settings.ts";

const original = { chat: graphOrganizer.chat, apply: graphOrganizer.apply, undo: graphOrganizer.undo, history: graphOrganizer.history };
after(() => Object.assign(graphOrganizer, original));

const post = (handler: (r: Request) => Promise<Response>, body: unknown) =>
	handler(new Request("http://localhost/api/graph/organizer", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));
const ask = { messages: [{ role: "user", text: "tag everything renal" }] };

describe("POST /api/graph/organizer", () => {
	it("answers with the reply and the proposal (or null)", async () => {
		graphOrganizer.chat = async () => ({ ok: true, reply: "Which node?" });
		const res = await post(POST, ask);
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { reply: "Which node?", proposal: null });
	});

	it("400s a bad body before the model is asked", async () => {
		let asked = false;
		graphOrganizer.chat = async () => {
			asked = true;
			return { ok: true, reply: "" };
		};
		assert.equal((await post(POST, "{not json")).status, 400);
		assert.equal((await post(POST, { messages: [] })).status, 400);
		assert.equal((await post(POST, { messages: [{ role: "assistant", text: "x" }] })).status, 400);
		assert.equal(asked, false);
	});

	it("maps the config refusals to the 503 envelopes, a busy organizer to 409, a crash to 500", async () => {
		graphOrganizer.chat = async () => {
			throw new ModelsNotConfiguredError(["strong"]);
		};
		let res = await post(POST, ask);
		assert.equal(res.status, 503);
		assert.equal(((await res.json()) as { code: string }).code, "models_not_configured");

		graphOrganizer.chat = async () => {
			throw new ProviderKeyMissingError("openai", ["strong"]);
		};
		res = await post(POST, ask);
		assert.equal(res.status, 503);
		assert.equal(((await res.json()) as { code: string }).code, "provider_key_missing");

		graphOrganizer.chat = async () => ({ ok: false, status: 409, code: "organizer_busy", error: "busy" });
		assert.equal((await post(POST, ask)).status, 409);

		graphOrganizer.chat = async () => {
			throw new Error("boom");
		};
		assert.equal((await post(POST, ask)).status, 500);
	});

	it("GET lists the applied sets", async () => {
		graphOrganizer.history = () => [{ id: "org_1", appliedAt: "t", summary: "s", changeCount: 1, undone: false, canUndo: true }];
		const body = (await (await GET()).json()) as { history: Array<{ id: string }> };
		assert.deepEqual(body.history.map((h) => h.id), ["org_1"]);
	});
});

describe("apply and undo", () => {
	it("apply needs a proposalId and answers with the revision and history", async () => {
		assert.equal((await post(APPLY, {})).status, 400);
		graphOrganizer.apply = (id) => ({ ok: true, entryId: `org_for_${id}`, summary: "s", graphRevision: 7, history: [] });
		const res = await post(APPLY, { proposalId: "prop_1" });
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { entryId: "org_for_prop_1", summary: "s", graphRevision: 7, history: [] });
	});

	it("apply maps an invalid set to 422 with the reasons, an expired proposal to 404", async () => {
		graphOrganizer.apply = () => ({ ok: false, status: 422, code: "invalid_changes", error: "no", problems: ["Change 1: bad"] });
		let res = await post(APPLY, { proposalId: "p" });
		assert.equal(res.status, 422);
		assert.deepEqual(((await res.json()) as { problems: string[] }).problems, ["Change 1: bad"]);
		graphOrganizer.apply = () => ({ ok: false, status: 404, code: "proposal_not_found", error: "gone" });
		res = await post(APPLY, { proposalId: "p" });
		assert.equal(res.status, 404);
	});

	it("undo needs an entryId and maps conflicts to 409", async () => {
		assert.equal((await post(UNDO, {})).status, 400);
		graphOrganizer.undo = () => ({ ok: false, status: 409, code: "conflict", error: "changed since" });
		const res = await post(UNDO, { entryId: "org_1" });
		assert.equal(res.status, 409);
		assert.equal(((await res.json()) as { code: string }).code, "conflict");
		graphOrganizer.undo = (id) => ({ ok: true, entryId: id, graphRevision: 9, history: [] });
		assert.equal((await post(UNDO, { entryId: "org_1" })).status, 200);
	});
});
