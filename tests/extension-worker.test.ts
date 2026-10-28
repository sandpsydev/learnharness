import assert from "node:assert/strict";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { it } from "node:test";
import type { Reply, Request } from "../extension/types";

it("worker keeps pairing data private and sends context-menu selections through its local API", async () => {
  const id = "a".repeat(32);
  const base = `chrome-extension://${id}/`;
  const local: Record<string, unknown> = { config: { appUrl: "http://127.0.0.1:47615", expertUrl: "https://ai.uptodate.com/?dpRedirect=false", token: "private-fixture-token" } };
  const session: Record<string, unknown> = {};
  const access: string[] = [];
  const calls: Array<{ url: string; auth: string | null; body: unknown }> = [];
  const listeners: Record<string, (...args: any[]) => any> = {};
  function area(name: string, data: Record<string, unknown>) {
    return {
      async setAccessLevel(options: { accessLevel: string }) { access.push(`${name}:${options.accessLevel}`); },
      async get(key: string) { return { [key]: data[key] }; },
      async set(value: Record<string, unknown>) { Object.assign(data, value); },
    };
  }
  const chrome = {
    storage: { local: area("local", local), session: area("session", session) },
    runtime: { id, getURL: (file: string) => base + file, onMessage: { addListener: (fn: (...args: any[]) => any) => { listeners.message = fn; } }, onInstalled: { addListener: (fn: () => void) => { listeners.installed = fn; } } },
    action: { async setBadgeText() {}, async setTitle() {} },
    contextMenus: { removeAll(fn: () => void) { fn(); }, create() {}, onClicked: { addListener: (fn: (...args: any[]) => any) => { listeners.selection = fn; } } },
    commands: { onCommand: { addListener() {} } },
  };
  const bundle = await build({ entryPoints: [new URL("../extension/worker.ts", import.meta.url).pathname], bundle: true, write: false, format: "iife", platform: "browser" });
  runInNewContext(bundle.outputFiles[0]!.text, {
    chrome, URL, AbortSignal, crypto, setTimeout, console,
    fetch: async (url: string, init: RequestInit) => {
      assert.ok(url.startsWith("http://127.0.0.1:47615/v1/"));
      calls.push({ url, auth: new Headers(init.headers).get("Authorization"), body: init.body ? JSON.parse(String(init.body)) : undefined });
      return Response.json({ ok: true });
    },
  });
  const send = (message: Request, sender: unknown) => new Promise<Reply>((resolve) => listeners.message!(message, sender, resolve));
  const page = { id, url: "https://ai.uptodate.com/fixture-string-only", frameId: 0, tab: { id: 7 } };
  const own = { id, url: base + "popup.html" };
  for (const type of ["config", "queue", "ping", "release"] as const) {
    const reply = await send({ type }, page);
    assert.equal(reply.ok, false, `content script cannot ${type}`);
    assert.doesNotMatch(JSON.stringify(reply), /private-fixture-token/);
  }
  const unknown = await send({ type: "config" }, { ...own, id: "other" });
  assert.equal(unknown.ok, false);
  const settings = await send({ type: "config" }, own);
  assert.equal(settings.ok, true);
  assert.match(JSON.stringify(settings), /private-fixture-token/);
  assert.deepEqual(access.sort(), ["local:TRUSTED_CONTEXTS", "session:TRUSTED_CONTEXTS"]);
  assert.equal(calls.length, 0, "no background fetch happens on worker startup or state reads");
  listeners.selection!({ menuItemId: "send-highlight", selectionText: "Selected PDF passage", pageUrl: "https://example.org/paper.pdf" }, { title: "Paper" });
  for (let attempt = 0; attempt < 30 && !calls.length; attempt++) await new Promise((r) => setTimeout(r, 2));
  assert.deepEqual(calls, [{ url: "http://127.0.0.1:47615/v1/highlights", auth: "Bearer private-fixture-token", body: { text: "Selected PDF passage", url: "https://example.org/paper.pdf", title: "Paper" } }]);
});
