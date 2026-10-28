import assert from "node:assert/strict";
import { after, it } from "node:test";
import { POST } from "../app/api/graph/tags/backfill/route.ts";
import { extraction } from "../src/server/index.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../src/core/settings.ts";

const original = extraction.tagExistingNodes;
after(() => {
	extraction.tagExistingNodes = original;
});
const call = () => POST(new Request("http://localhost/api/graph/tags/backfill", { method: "POST" }));

it("answers with what the back-fill did plus the new graph revision", async () => {
	extraction.tagExistingNodes = async () => ({ untagged: 5, tagged: 4 });
	const res = await call();
	assert.equal(res.status, 200);
	const body = (await res.json()) as { untagged: number; tagged: number; graphRevision: number };
	assert.equal(body.untagged, 5);
	assert.equal(body.tagged, 4);
	assert.equal(typeof body.graphRevision, "number");
});

it("maps the config refusals to the 503 envelopes and a concurrent run to 409", async () => {
	extraction.tagExistingNodes = async () => {
		throw new ModelsNotConfiguredError(["cheap"]);
	};
	let res = await call();
	assert.equal(res.status, 503);
	assert.equal(((await res.json()) as { code: string }).code, "models_not_configured");

	extraction.tagExistingNodes = async () => {
		throw new ProviderKeyMissingError("openai", ["cheap"]);
	};
	res = await call();
	assert.equal(res.status, 503);
	assert.equal(((await res.json()) as { code: string }).code, "provider_key_missing");

	extraction.tagExistingNodes = async () => {
		throw new Error("Tagging is already running.");
	};
	res = await call();
	assert.equal(res.status, 409);

	extraction.tagExistingNodes = async () => {
		throw new Error("boom");
	};
	res = await call();
	assert.equal(res.status, 500);
});
