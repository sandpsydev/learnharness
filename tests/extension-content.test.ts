import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { Attempts } from "../extension/attempts";
import { ExtensionController } from "../extension/controller";
import type { VerifyApi } from "../extension/api";
import type { SessionState } from "../extension/types";
import { parseHTML } from "linkedom";

// Execute the bundled content script against local reconstructed DOM only.
// No browser, network, account, or live page is involved.
const fixture = readFileSync(new URL("./fixtures/extension/expert-ai.html", import.meta.url), "utf8");
const answerHtml = readFileSync(new URL("./fixtures/extension/expert-ai-answer.html", import.meta.url), "utf8");
type Listener = (message: unknown, sender: unknown, respond: (reply: unknown) => void) => boolean;
type PageReply = { ok: boolean; submitted: boolean; untouched?: boolean; error?: string };
const bundled = build({ entryPoints: [new URL("../extension/content.ts", import.meta.url).pathname], bundle: true, write: false, format: "iife", platform: "browser" });

async function load(options: { signedOut?: boolean; neverFresh?: boolean; neverSendable?: boolean; background?: boolean; automatic?: boolean; begin?: (request: unknown) => unknown } = {}) {
  const { document, Event: FixtureEvent } = parseHTML(fixture);
  Object.defineProperty(document, "visibilityState", { value: options.background ? "hidden" : "visible" });
  document.hasFocus = () => !options.background;
  // Closed shells still have a browser client rectangle, but no height.
  document.querySelectorAll<HTMLElement>(".ec-modal").forEach((shell) => {
    shell.getClientRects = () => [{ width: 948, height: 0 }] as unknown as DOMRectList;
  });
  const box = document.querySelector<HTMLElement>('[contenteditable="true"]')!;
  if (options.neverFresh) { box.textContent = "Old question"; box.setAttribute("data-empty", "false"); }
  box.addEventListener("input", () => {
    box.setAttribute("data-empty", "false");
    if (!options.neverSendable) box.closest("form")!.querySelector("button[type=submit]")!.removeAttribute("disabled");
  });
  const log: string[] = [];
  const messages: unknown[] = [];
  box.addEventListener("input", () => log.push("fill"));
  box.closest("form")!.querySelector("button[type=submit]")!.addEventListener("click", () => log.push("submit"));
  if (options.signedOut) document.querySelectorAll('[contenteditable="true"]').forEach((node) => node.remove());
  let listener!: Listener;
  let mutated!: () => void;
  const timers = new Map<number, () => void>();
  // Fake clock so the ten-second waits finish instantly.
  let now = 0;
  const compiled = await bundled;
  runInNewContext(compiled.outputFiles[0]!.text, {
    document, location: { href: "https://example.org/generic-fixture" }, InputEvent: FixtureEvent, Date: { now: () => now },
    MutationObserver: class {
      constructor(callback: () => void) { mutated = callback; }
      observe() {} disconnect() {}
    },
    setTimeout(callback: () => void, ms: number) {
      if (ms === 120_000) { timers.set(1, callback); return 1; }
      now += ms; setImmediate(callback); return 2;
    },
    clearTimeout(id: number) { timers.delete(id); },
    chrome: { runtime: { id: "local-fixture", onMessage: { addListener(callback: Listener) { listener = callback; } },
      sendMessage(request: { type: string }) {
        messages.push(request);
        if (request.type === "auto-ready") { log.push("ready"); return Promise.resolve({ ok: true }); }
        if (request.type !== "begin") assert.fail("unexpected message");
        log.push("begin");
        return Promise.resolve(options.begin ? options.begin(request) : { ok: true, data: null });
      } } },
  });
  const ask = (requestId = "fixture-request") => new Promise<PageReply>((resolve) => {
    assert.equal(listener({ type: "lh-ask", requestId, prompt: "Generic question", automatic: options.automatic }, { id: "local-fixture" }, (reply) => resolve(reply as PageReply)), true);
  });
  const collect = (requestId = "fixture-request") => new Promise<{ ok: boolean; answer?: { text: string; references: unknown[] }; error?: string }>((resolve) => {
    listener({ type: "lh-collect", requestId }, { id: "local-fixture" }, (reply) => resolve(reply as { ok: boolean }));
  });
  return { document, log, messages, collect, timers, mutated: () => mutated(), ask, listener: () => listener };
}

test("content script times out to manual return and still accepts a later completion signal", async () => {
  const { document, log, timers, mutated, ask } = await load();
  const response = await ask();
  assert.equal(response.ok, true); assert.equal(response.submitted, true);
  assert.deepEqual(log, ["begin", "fill", "submit"], "it asks the extension before it writes anything");
  assert.equal(timers.size, 1);
  timers.get(1)!();
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /manual paste-back.*Do not submit/);
  document.querySelector("#answers")!.innerHTML = answerHtml;
  mutated();
  assert.equal(timers.size, 0);
  assert.equal(document.querySelector('[role="alert"]'), null);
  assert.equal(document.querySelector('[aria-label="LearnHarness answer actions"] button')!.textContent, "Send to LearnHarness");
  assert.equal(log.filter((entry) => entry === "submit").length, 1, "completion timeout never resubmits");
});

test("content script reports an untouched page, without asking to fill, when no question box is shown", async () => {
  const { log, ask } = await load({ signedOut: true });
  const response = await ask();
  assert.equal(response.ok, false); assert.equal(response.submitted, false); assert.equal(response.untouched, true);
  assert.match(response.error!, /Sign in/);
  assert.deepEqual(log, []);
});

test("content script reports an untouched page when the fresh conversation never appears", async () => {
  const { log, ask } = await load({ neverFresh: true });
  const response = await ask();
  assert.equal(response.ok, false); assert.equal(response.untouched, true);
  assert.match(response.error!, /fresh conversation/);
  assert.deepEqual(log, [], "it never reached the fill step");
});

test("content script fills nothing when the extension refuses permission", async () => {
  const { log, ask } = await load({ begin: () => ({ ok: false, error: "closed" }) });
  const response = await ask();
  assert.equal(response.ok, false); assert.equal(response.untouched, true);
  assert.deepEqual(log, ["begin"]);
});

test("content script does not call the page untouched once it began filling", async () => {
  const { log, ask } = await load({ neverSendable: true });
  const response = await ask();
  assert.equal(response.ok, false); assert.equal(response.submitted, false);
  assert.equal(response.untouched, false, "text may be in the box");
  assert.deepEqual(log, ["begin", "fill"]);
});

// The whole path the owner hit: controller + worker permission + content script.
test("a sign-in screen ends the attempt cleanly and the next question can be asked", async () => {
  const page = await load({ signedOut: true });
  const attempts = new Attempts();
  const calls: string[] = [];
  let state: SessionState = {};
  const queue = ["a", "b"].map((id) => ({ id, chatId: "c", chatTitle: "Fixture lesson", prompt: `Generic question ${id}`, status: "queued" as const, createdAt: "2026-10-29T00:00:00.000Z" }));
  const controller = new ExtensionController({
    api: async () => ({ ping: async () => ({}), queue: async () => queue, asked: async (id: string) => { calls.push(`asked ${id}`); } }) as unknown as VerifyApi,
    read: async () => structuredClone(state),
    write: async (value) => { state = structuredClone(value); },
    focusExpert: async () => 7,
    submit: async (tabId, _item, requestId) => { attempts.open(requestId, tabId); return page.ask(requestId); },
    clipboard: async () => {},
    closeAttempt: async (requestId) => attempts.close(requestId),
  });
  await assert.rejects(controller.ask("a"), /sign in.*click Ask in Expert AI again/is);
  assert.equal(state.active, undefined);
  assert.deepEqual(calls, [], "the app is never told the question was asked");
  await assert.rejects(controller.ask("b"), /sign in/i, "the next question is allowed to try");
});


test("automatic content fills and collects answer plus sources in a hidden unfocused document", async () => {
  const h = await load({ automatic: true, background: true });
  assert.equal((await h.ask()).ok, true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.log, ["begin", "fill", "submit"]);
  assert.equal((await h.collect()).answer, undefined, "streaming is not a completed answer");
  await new Promise((r) => setImmediate(r));
  h.document.querySelector("#answers")!.innerHTML = answerHtml;
  const button = h.document.querySelector('[class*="sources-button_"]')!;
  button.addEventListener("click", () => {
    h.document.body.insertAdjacentHTML("beforeend", readFileSync(new URL("./fixtures/extension/expert-ai-sources.html", import.meta.url), "utf8"));
    button.setAttribute("aria-pressed", "true");
    h.document.querySelector('[data-e2e="drawer-close-btn"]')!.addEventListener("click", () => {
      h.document.querySelector('[data-e2e="fab-expy-sources-drawer"]')!.remove();
      button.setAttribute("aria-pressed", "false");
    });
  });
  h.mutated();
  assert.equal(h.log.at(-1), "ready", "completion wakes worker with no learner click");
  const result = await h.collect();
  assert.equal(result.ok, true);
  assert.match(result.answer!.text, /Example medicine/);
  assert.equal(result.answer!.references.length, 2);
  assert.equal(h.document.querySelector('[data-e2e="fab-expy-sources-drawer"]'), null, "drawer restored");
  assert.deepEqual(JSON.parse(JSON.stringify(h.messages)), [
    { type: "begin", requestId: "fixture-request" },
    { type: "auto-ready", requestId: "fixture-request" },
  ]);
  assert.equal((await h.collect("stale-request")).ok, false);
  assert.equal(h.log.filter((entry) => entry === "submit").length, 1);
});

test("automatic hidden sign-in failure leaves the page untouched", async () => {
  const h = await load({ automatic: true, background: true, signedOut: true });
  const result = await h.ask();
  assert.equal(result.untouched, true);
  assert.equal(result.submitted, false);
  assert.match(result.error!, /Sign in/);
  assert.deepEqual(h.log, []);
});

test("manual content still refuses hidden unfocused runs", async () => {
  const h = await load({ background: true });
  const result = await h.ask();
  assert.equal(result.untouched, true);
  assert.match(result.error!, /visible.*focused/);
  assert.deepEqual(h.log, []);
});
