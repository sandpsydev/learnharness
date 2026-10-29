import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { parseHTML } from "linkedom";

// Execute the bundled content script against local reconstructed DOM only.
// No browser, network, account, or live page is involved.
test("content script times out to manual return and still accepts a later completion signal", async () => {
  const fixture = readFileSync(new URL("./fixtures/extension/expert-ai.html", import.meta.url), "utf8");
  const answer = readFileSync(new URL("./fixtures/extension/expert-ai-answer.html", import.meta.url), "utf8");
  const { document, Event: FixtureEvent } = parseHTML(fixture);
  Object.defineProperty(document, "visibilityState", { value: "visible" });
  document.hasFocus = () => true;
  const box = document.querySelector<HTMLElement>('[contenteditable="true"]')!;
  box.addEventListener("input", () => {
    box.setAttribute("data-empty", "false");
    box.closest("form")!.querySelector("button[type=submit]")!.removeAttribute("disabled");
  });
  let submissions = 0;
  box.closest("form")!.querySelector("button[type=submit]")!.addEventListener("click", () => { submissions++; });
  let listener!: (message: unknown, sender: unknown, respond: (reply: unknown) => void) => boolean;
  let mutated!: () => void;
  const timers = new Map<number, () => void>();
  const compiled = await build({ entryPoints: [new URL("../extension/content.ts", import.meta.url).pathname], bundle: true, write: false, format: "iife", platform: "browser" });
  runInNewContext(compiled.outputFiles[0]!.text, {
    document, InputEvent: FixtureEvent,
    MutationObserver: class {
      constructor(callback: () => void) { mutated = callback; }
      observe() {} disconnect() {}
    },
    setTimeout(callback: () => void, ms: number) { assert.equal(ms, 120_000); timers.set(1, callback); return 1; },
    clearTimeout(id: number) { timers.delete(id); },
    chrome: { runtime: { id: "local-fixture", onMessage: { addListener(callback: typeof listener) { listener = callback; } }, sendMessage() { assert.fail("no automatic answer return"); } } },
  });
  const response = await new Promise<{ ok: boolean; submitted: boolean }>((resolve) => {
    assert.equal(listener({ type: "lh-ask", requestId: "fixture-request", prompt: "Generic question" }, { id: "local-fixture" }, (reply) => resolve(reply as { ok: boolean; submitted: boolean })), true);
  });
  assert.equal(response.ok, true); assert.equal(response.submitted, true);
  assert.equal(submissions, 1); assert.equal(timers.size, 1);
  timers.get(1)!();
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /manual paste-back.*Do not submit/);
  document.querySelector("#answers")!.innerHTML = answer;
  mutated();
  assert.equal(timers.size, 0);
  assert.equal(document.querySelector('[role="alert"]'), null);
  assert.equal(document.querySelector('[aria-label="LearnHarness answer actions"] button')!.textContent, "Send to LearnHarness");
  assert.equal(submissions, 1, "completion timeout never resubmits");
});
