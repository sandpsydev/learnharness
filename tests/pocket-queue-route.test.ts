/**
 * The phone's Expert AI queue endpoint (Pocket mode): read only, and it lists
 * only what is still waiting. Isolated data dir; no network.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-queue-route-"));
process.env.LH_DATA_DIR = dataDir;

const { stores, createStampedChat } = await import("../src/server/index.ts");
const route = await import("../app/api/verify/queue/route.ts");

describe("GET /api/verify/queue", () => {
	after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

	it("lists queued and asked questions with their session, not answered or dismissed ones", async () => {
		const chat = createStampedChat("Furosemide and potassium");
		const [a, b, c, d] = stores.verifyStore.addItems(chat.id, [
			{ prompt: "Q queued" }, { prompt: "Q asked" }, { prompt: "Q dismissed" }, { prompt: "Q answered" },
		]);
		stores.verifyStore.updateItem(b!.id, { status: "asked" });
		stores.verifyStore.updateItem(c!.id, { status: "dismissed" });
		stores.verifyStore.updateItem(d!.id, { status: "answered" });
		const res = await route.GET();
		assert.equal(res.status, 200);
		const { queue } = await res.json() as { queue: Array<{ id: string; prompt: string; status: string; chatTitle: string }> };
		assert.deepEqual(queue.map((q) => [q.prompt, q.status]), [["Q queued", "queued"], ["Q asked", "asked"]]);
		assert.equal(queue[0]!.id, a!.id);
		assert.equal(queue[0]!.chatTitle, "Furosemide and potassium");
	});

	it("is read only: the route has no way to ask, answer or dismiss", () => {
		assert.deepEqual(Object.keys(route).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k)), ["GET"]);
	});
});
