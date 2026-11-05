/**
 * The Obsidian folder setting and the routes around the Obsidian copy and
 * Review mode: validation at the door, the status mapping, nothing started by
 * a bad request.
 */

import assert from "node:assert/strict";
import * as os from "node:os";
import { after, describe, it } from "node:test";
import { GET as obsidianGet, POST as obsidianPost } from "../app/api/obsidian/route.ts";
import { GET as reviewGet, POST as reviewPost } from "../app/api/review/route.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../src/core/settings.ts";
import { SETTINGS_SECTIONS, obsidianSync, reviewService } from "../src/server/index.ts";

describe("the vault folder setting", () => {
	const parse = SETTINGS_SECTIONS.obsidian;

	it("takes a full path, expands ~, drops a trailing slash, and an empty path turns the copy off", () => {
		assert.deepEqual(parse({ vaultPath: "/Users/me/Vault/" }), { ok: true, settings: { vaultPath: "/Users/me/Vault" } });
		assert.deepEqual(parse({ vaultPath: "  /Users/me/Vault  " }), { ok: true, settings: { vaultPath: "/Users/me/Vault" } });
		assert.deepEqual(parse({ vaultPath: "~/SlideScribe/vault" }), { ok: true, settings: { vaultPath: `${os.homedir()}/SlideScribe/vault` } });
		assert.deepEqual(parse({ vaultPath: "" }), { ok: true, settings: {} });
		assert.deepEqual(parse({}), { ok: true, settings: {} });
	});

	it("refuses a relative path or the wrong type", () => {
		for (const bad of [{ vaultPath: "Documents/Vault" }, { vaultPath: "../Vault" }, { vaultPath: 5 }, null, [], "x"]) {
			assert.equal(parse(bad as never).ok, false, JSON.stringify(bad));
		}
	});

	it("is kept in the settings record, and a stored value that isn't an absolute path reads as not set", () => {
		assert.deepEqual(sanitizeUserSettings({ version: 1, obsidian: { vaultPath: "/Users/me/Vault" } })?.obsidian, { vaultPath: "/Users/me/Vault" });
		assert.deepEqual(sanitizeUserSettings({ version: 1, obsidian: { vaultPath: "relative/x" } })?.obsidian, {});
		assert.deepEqual(sanitizeUserSettings({ version: 1, obsidian: { vaultPath: 3 } })?.obsidian, {});
		assert.equal(sanitizeUserSettings({ version: 1 })?.obsidian, undefined, "off by default");
	});
});

const original = { status: obsidianSync.status, run: obsidianSync.run };
const reviewOriginal = {
	status: reviewService.status,
	writeOne: reviewService.writeOne,
	writeAll: reviewService.writeAll,
	stop: reviewService.stop,
	clearResult: reviewService.clearResult,
};
after(() => {
	Object.assign(obsidianSync, original);
	Object.assign(reviewService, reviewOriginal);
});

const post = (handler: (r: Request) => Promise<Response>, body: unknown) =>
	handler(new Request("http://localhost/api/x", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));
const fakeStatus = { vault: { configured: true }, scripts: [], catalogue: null, run: null };

describe("/api/obsidian", () => {
	it("answers with the status, and sync runs the same sync the live copy does", async () => {
		const status = { vaultPath: "/v", appFolder: "/v/LearnHarness", suggested: null, state: "idle" as const };
		obsidianSync.status = () => status;
		let ran = 0;
		obsidianSync.run = () => (ran++, status);
		assert.deepEqual(await (await obsidianGet()).json(), { status });
		assert.equal((await post(obsidianPost, { action: "sync" })).status, 200);
		assert.equal(ran, 1);
		assert.equal((await post(obsidianPost, { action: "other" })).status, 400);
		assert.equal((await post(obsidianPost, "{nope")).status, 400);
		assert.equal(ran, 1);
	});
});

describe("/api/review", () => {
	it("starts one script or the whole graph, and stops or dismisses", async () => {
		const calls: string[] = [];
		reviewService.status = () => fakeStatus as never;
		reviewService.writeOne = (i) => (calls.push(`one:${String(i)}`), { ok: true, status: fakeStatus as never });
		reviewService.writeAll = () => (calls.push("all"), { ok: true, status: fakeStatus as never });
		reviewService.stop = () => (calls.push("stop"), { ok: true, status: fakeStatus as never });
		reviewService.clearResult = () => (calls.push("dismiss"), fakeStatus as never);
		assert.equal((await reviewGet()).status, 200);
		assert.equal((await post(reviewPost, { action: "write", illness: "acute pancreatitis" })).status, 200);
		assert.equal((await post(reviewPost, { action: "write-all" })).status, 200);
		assert.equal((await post(reviewPost, { action: "stop" })).status, 200);
		assert.equal((await post(reviewPost, { action: "dismiss" })).status, 200);
		assert.deepEqual(calls, ["one:acute pancreatitis", "all", "stop", "dismiss"]);
	});

	it("400s an unknown action or a bad body, and starts nothing", async () => {
		let started = 0;
		reviewService.writeOne = () => (started++, { ok: true, status: fakeStatus as never });
		reviewService.writeAll = () => (started++, { ok: true, status: fakeStatus as never });
		assert.equal((await post(reviewPost, { action: "explode" })).status, 400);
		assert.equal((await post(reviewPost, "{nope")).status, 400);
		assert.equal((await post(reviewPost, null)).status, 400);
		assert.equal(started, 0);
	});

	it("maps refusals: busy / no vault 409, bad name 400, config 503, crash 500", async () => {
		reviewService.writeOne = () => ({ ok: false, status: 409, code: "review_busy", error: "busy" });
		let res = await post(reviewPost, { action: "write", illness: "x" });
		assert.equal(res.status, 409);
		assert.equal(((await res.json()) as { code: string }).code, "review_busy");

		reviewService.writeAll = () => ({ ok: false, status: 409, code: "no_vault", error: "Set your Obsidian vault folder" });
		assert.equal((await post(reviewPost, { action: "write-all" })).status, 409);

		reviewService.writeOne = () => ({ ok: false, status: 400, code: "bad_request", error: "Say which illness" });
		assert.equal((await post(reviewPost, { action: "write", illness: "" })).status, 400);

		reviewService.writeAll = () => {
			throw new ModelsNotConfiguredError(["strong"]);
		};
		res = await post(reviewPost, { action: "write-all" });
		assert.equal(res.status, 503);
		assert.equal(((await res.json()) as { code: string }).code, "models_not_configured");

		reviewService.writeAll = () => {
			throw new ProviderKeyMissingError("openai-codex", ["strong"]);
		};
		assert.equal(((await (await post(reviewPost, { action: "write-all" })).json()) as { code: string }).code, "provider_key_missing");

		reviewService.writeAll = () => {
			throw new Error("boom");
		};
		assert.equal((await post(reviewPost, { action: "write-all" })).status, 500);
	});
});
