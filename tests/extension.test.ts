import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildExtension } from "../scripts/build-extension.mjs";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { VerifyApi } from "../extension/api";
import { DEFAULT_CONFIG, isExpertUrl, validateConfig } from "../extension/config";
import { ExtensionController } from "../extension/controller";
import type { ControllerPorts, PageResult } from "../extension/controller";
import { EXPERT_PAGE, answerContainer, canSubmit, questionBox, conversationIsFresh, fillQuestion, readAnswer, startConversation, submitQuestion } from "../extension/expert-page";
import type { Answer, QueueItem, SessionState } from "../extension/types";
import { referenceLines } from "../extension/ui";

const fixture = readFileSync(new URL("./fixtures/extension/expert-ai.html", import.meta.url), "utf8");
function page() {
  const { document, Event: FixtureEvent } = parseHTML(fixture);
  // linkedom has no rendering/window focus; supply only those browser signals.
  Object.defineProperty(document, "defaultView", { configurable: true, value: { Event: FixtureEvent } });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  document.hasFocus = () => true;
  class FixtureInputEvent extends FixtureEvent {
    inputType: string; data: string | null;
    constructor(type: string, init: InputEventInit) { super(type, init); this.inputType = init.inputType ?? ""; this.data = init.data ?? null; }
  }
  Object.defineProperty(document, "defaultView", { configurable: true, value: { Event: FixtureEvent, InputEvent: FixtureInputEvent } });
  const box = document.querySelector<HTMLElement>(EXPERT_PAGE.question)!;
  for (const editor of document.querySelectorAll<HTMLElement>(EXPERT_PAGE.question)) {
    editor.addEventListener("input", () => {
      editor.setAttribute("data-empty", String(!editor.textContent));
      editor.closest("form")!.querySelector("button[type=submit]")!.toggleAttribute("disabled", !editor.textContent);
    });
  }
  return { document, box };
}
const items: QueueItem[] = ["a", "b"].map((id) => ({ id, chatId: "chat_1", chatTitle: "Fixture lesson", prompt: `Generic question ${id}: explain the guideline basis.`, status: "queued", createdAt: "2026-10-29T00:00:00.000Z" }));
const answer: Answer = { text: "Fixture answer.", references: [{ title: "Fixture reference", url: "https://example.org/guideline" }], sourceUrl: "https://example.org/local-fixture" };
function harness(options: { pageResult?: PageResult; fail?: string; delaySubmit?: Promise<void> } = {}) {
  let state: SessionState = {};
  const calls: Array<{ path: string; body?: unknown; auth: string | null; method: string }> = [];
  const submissions: Array<{ id: string; requestId: string }> = [];
  const copies: string[] = [];
  const waiting = structuredClone(items);
  const api = new VerifyApi({ ...DEFAULT_CONFIG, token: "fixture-token" }, (async (url, init) => {
    assert.ok(String(url).startsWith("http://127.0.0.1:47615/v1/"), "no external request is possible in this fixture");
    const path = String(url).split("/v1/")[1]!;
    const headers = new Headers(init?.headers);
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.get("Authorization"), method: init?.method ?? "GET" });
    if (init?.body) assert.equal(headers.get("Content-Type"), "application/json");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, "omit");
    if (options.fail === path) throw new Error("fixture offline");
    let data: unknown = { ok: true };
    if (path === "ping") data = { ok: true, app: "learnharness", apiVersion: 1, authenticated: true };
    if (path === "queue") data = { ok: true, items: waiting };
    if (path.endsWith("/asked")) waiting.find((q) => path.includes(q.id))!.status = "asked";
    if (path.endsWith("/answer")) {
      const index = waiting.findIndex((q) => path === `queue/${q.id}/answer`);
      waiting.splice(index, 1);
      data = { ok: true, next: waiting.find((q) => q.status === "queued") ?? null };
    }
    return Response.json(data);
  }) as typeof fetch);
  const ports: ControllerPorts = {
    api: async () => api,
    read: async () => structuredClone(state),
    write: async (value) => { state = structuredClone(value); },
    focusExpert: async () => 7,
    submit: async (_tabId, item, requestId) => { submissions.push({ id: item.id, requestId }); await options.delaySubmit; return options.pageResult ?? { ok: true, submitted: true }; },
    clipboard: async (text) => { copies.push(text); },
  };
  return { controller: new ExtensionController(ports), ports, api, calls, submissions, copies, state: () => state };
}

const answerFixture = readFileSync(new URL("./fixtures/extension/expert-ai-answer.html", import.meta.url), "utf8");
describe("extension page adapter (local fixture only)", () => {
  it("starts fresh, registers rich-text input, waits for enabled send, and leaves Standard untouched", () => {
    const { document, box } = page();
    box.textContent = "Old question"; box.setAttribute("data-empty", "false");
    const order: string[] = [];
    document.querySelector(EXPERT_PAGE.newConversation)!.addEventListener("click", () => {
      order.push("new"); box.textContent = ""; box.setAttribute("data-empty", "true");
    });
    box.addEventListener("input", (event) => {
      assert.equal((event as InputEvent).inputType, "insertText");
      assert.equal((event as InputEvent).data, items[0]!.prompt);
      order.push("input");
    });
    box.closest("form")!.querySelector(EXPERT_PAGE.submit)!.addEventListener("click", () => {
      order.push("submit"); assert.equal(box.textContent, items[0]!.prompt);
    });
    document.querySelectorAll('[data-e2e="output-mode-menu-trigger"]').forEach((button) => button.addEventListener("click", () => assert.fail("mode must stay untouched")));
    assert.equal(canSubmit(document), false);
    assert.throws(() => submitQuestion(document), /unavailable/);
    startConversation(document);
    assert.equal(conversationIsFresh(document), true);
    fillQuestion(document, items[0]!.prompt);
    assert.equal(canSubmit(document), true);
    submitQuestion(document);
    assert.deepEqual(order, ["new", "input", "submit"]);
  });
  it("selects the visible desktop or mobile editor and its own send button", () => {
    const { document, box } = page();
    box.closest('[data-e2e="desktop-initial-screen-input-wrapper"]')!.setAttribute("hidden", "");
    const mobile = document.querySelector('[data-e2e="desktop-initial-screen-mobile-input"]')!;
    mobile.removeAttribute("hidden");
    const editor = mobile.querySelector<HTMLElement>(EXPERT_PAGE.question)!;
    assert.equal(questionBox(document), editor);
    let sent = false;
    mobile.querySelector(EXPERT_PAGE.submit)!.addEventListener("click", () => { sent = true; });
    fillQuestion(document, "Generic mobile question"); submitQuestion(document);
    assert.equal(sent, true); assert.equal(box.textContent, "");
  });
  it("uses native insertText when supported", () => {
    const { document, box } = page();
    const selection = { removeAllRanges() {}, addRange() {} };
    document.getSelection = () => selection as unknown as Selection;
    document.createRange = () => ({ selectNodeContents(node: Node) { assert.equal(node, box); } }) as Range;
    document.execCommand = (command, _ui, text) => {
      assert.equal(command, "insertText"); box.textContent = text!; return true;
    };
    fillQuestion(document, "Generic native edit");
    assert.equal(box.textContent, "Generic native edit");
  });
  it("requires an initial screen and an empty editor after starting a conversation", () => {
    const { document, box } = page();
    box.closest(EXPERT_PAGE.initialScreen)!.removeAttribute("data-e2e");
    box.setAttribute("aria-label", "Continue conversation...");
    assert.equal(conversationIsFresh(document), false);
    assert.throws(() => fillQuestion(document, "question"), /empty new conversation/);
  });
  it("stops for visible access modals, missing controls, and invisible tabs before a click", () => {
    for (const scenario of ["sign-in", "missing-submit", "missing-new", "hidden", "unfocused", ...EXPERT_PAGE.access.split(", ")]) {
      const { document } = page(); let clicks = 0;
      document.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => clicks++));
      if (scenario === "sign-in") document.querySelectorAll(EXPERT_PAGE.question).forEach((node) => node.remove());
      if (scenario.startsWith(".")) { const modal = document.createElement("div"); modal.className = scenario.slice(1); document.body.append(modal); }
      if (scenario === "missing-submit") document.querySelector(EXPERT_PAGE.submit)!.remove();
      if (scenario === "missing-new") document.querySelectorAll(`${EXPERT_PAGE.newConversation}, ${EXPERT_PAGE.sidebarNewConversation}`).forEach((node) => node.remove());
      if (scenario === "hidden") Object.defineProperty(document, "visibilityState", { value: "hidden" });
      if (scenario === "unfocused") document.hasFocus = () => false;
      assert.throws(() => startConversation(document), /Sign in|unavailable|visible/);
      assert.equal(clicks, 0, scenario);
    }
  });
  it("falls back to a visible sidebar new-conversation control", () => {
    const { document } = page(); let clicked = false;
    document.querySelector(EXPERT_PAGE.newConversation)!.setAttribute("hidden", "");
    document.querySelector(EXPERT_PAGE.sidebarNewConversation)!.addEventListener("click", () => { clicked = true; });
    startConversation(document); assert.equal(clicked, true);
  });
  it("uses only the last answer and waits for its copy action bar", () => {
    const { document } = page(); const answers = document.querySelector("#answers")!;
    answers.innerHTML = answerFixture;
    assert.ok(answerContainer(document));
    answers.innerHTML += answerFixture;
    const last = answers.lastElementChild!;
    last.querySelector(EXPERT_PAGE.complete)!.remove();
    assert.equal(answerContainer(document), null, "older completed answer must not be returned");
  });
  it("keeps drug names and citation IDs, drops nudges and chrome, and leaves references pending inspection", () => {
    const { document } = page(); document.querySelector("#answers")!.innerHTML = answerFixture;
    const container = answerContainer(document)!;
    const result = readAnswer(container, "https://example.org/local-fixture");
    assert.match(result.text, /Example medicine/);
    assert.match(result.text, /\[sources: 101\]/);
    assert.match(result.text, /\[sources: 102,103\]/);
    assert.doesNotMatch(result.text, /Thinking|disclaimer|Suggested follow-up|Copy|Sources/);
    assert.deepEqual(result.references, []);
    assert.ok(container.querySelector('[data-e2e="nudge"]'), "reading must not mutate the page");
  });
});

describe("extension learner-action controller", () => {
  it("pairs, reads the queue, submits once, and only then marks asked; a second ask is refused", async () => {
    const h = harness();
    assert.equal(h.calls.length, 0, "construction never starts a query");
    await h.controller.ask("a");
    assert.deepEqual(h.calls.map((c) => c.path), ["ping", "queue", "queue/a/asked"]);
    assert.equal(h.submissions.length, 1);
    assert.equal(h.state().active?.phase, "asked");
    assert.ok(h.calls.every((c) => c.auth === "Bearer fixture-token"));
    await assert.rejects(h.controller.ask("b"), /current answer first/);
    assert.equal(h.submissions.length, 1);
  });
  it("keeps access failures queued, copies the prompt, and permits a learner retry of that item", async () => {
    const h = harness({ pageResult: { ok: false, submitted: false, error: "Sign in and use the university network." } });
    await assert.rejects(h.controller.ask("a"), /Sign in/);
    assert.equal(h.state().active?.phase, "manual");
    assert.equal(h.calls.some((c) => c.path.endsWith("/asked")), false);
    assert.deepEqual(h.copies, [items[0]!.prompt]);
    await assert.rejects(h.controller.ask("a"), /Sign in/);
    assert.equal(h.submissions.length, 2, "only a second explicit action retries");
  });
  it("never retries an uncertain submission and survives service worker restart", async () => {
    const h = harness();
    h.ports.submit = async () => { throw new Error("port closed after click"); };
    await assert.rejects(h.controller.ask("a"), /did not confirm/);
    const restarted = new ExtensionController(h.ports);
    assert.equal(h.state().active?.phase, "uncertain");
    await assert.rejects(restarted.ask("a"), /current answer first/);
    await restarted.answer(answer, false);
    assert.equal(h.state().active, undefined);
  });
  it("blocks overlapping actions, including while a page submit is pending", async () => {
    let resolve!: () => void;
    const h = harness({ delaySubmit: new Promise<void>((r) => { resolve = r; }) });
    const first = h.controller.ask("a");
    await assert.rejects(h.controller.ask("b"), /already in progress/);
    await assert.rejects(h.controller.release(), /already in progress/);
    resolve(); await first;
    assert.equal(h.submissions.length, 1);
  });
  it("returns text and reference links; only Send & ask next starts the next queued item", async () => {
    for (const next of [false, true]) {
      const h = harness();
      await h.controller.ask("a");
      const binding = h.state().active!;
      await h.controller.answer(answer, next, { tabId: 7, requestId: binding.requestId });
      assert.deepEqual(h.calls.find((c) => c.path === "queue/a/answer")?.body, answer);
      assert.deepEqual(h.submissions.map((q) => q.id), next ? ["a", "b"] : ["a"]);
      assert.equal(h.state().active?.item.id, next ? "b" : undefined);
    }
  });
  it("does not turn a successful answer return into a retry when opening the next question fails", async () => {
    const h = harness(); await h.controller.ask("a");
    h.ports.submit = async () => ({ ok: false, submitted: false, error: "unverified page" });
    const result = await h.controller.answer(answer, true);
    assert.match(result.nextError!, /unverified page/);
    assert.equal(h.state().active?.item.id, "b");
    assert.equal(h.state().recovery, undefined);
    assert.equal(h.calls.filter((c) => c.path === "queue/a/answer").length, 1);
  });
  it("rejects stale tab/question bindings before sending an answer or chaining", async () => {
    const h = harness(); await h.controller.ask("a");
    await assert.rejects(h.controller.answer(answer, true, { tabId: 8, requestId: h.state().active!.requestId }), /older question/);
    await assert.rejects(h.controller.answer(answer, true, { tabId: 7, requestId: "old" }), /older question/);
    assert.equal(h.calls.some((c) => c.path.endsWith("/answer")), false);
  });
  it("retains an offline answer and copies it; no next question runs until a successful return", async () => {
    const options = { fail: "queue/a/answer" };
    const h = harness(options); await h.controller.ask("a");
    await assert.rejects(h.controller.answer(answer, true), /not running/);
    assert.equal(h.state().recovery?.kind, "answer");
    assert.match(h.copies[0]!, /Fixture answer[\s\S]*https:\/\/example.org\/guideline/);
    assert.equal(h.submissions.length, 1);
    options.fail = "";
    await h.controller.answer(answer, false);
    assert.equal(h.state().recovery, undefined);
  });
  it("accepts manual copy/paste-back without submitting to any page", async () => {
    const h = harness(); await h.controller.manual("a");
    assert.equal(h.state().active?.phase, "manual");
    assert.equal(h.submissions.length, 0);
    assert.equal(h.copies[0], items[0]!.prompt);
    await h.controller.answer(answer, false);
    assert.equal(h.calls.some((c) => c.path === "queue/a/answer"), true);
  });
  it("sends highlights with page metadata and retains them when the app is offline", async () => {
    const options = { fail: "highlights" };
    const h = harness(options);
    const highlight = { text: "A selected guideline passage", title: "Guideline", url: "https://example.org/guideline.pdf" };
    await assert.rejects(h.controller.highlight(highlight), /not running/);
    assert.deepEqual(h.state().recovery, { kind: "highlight", highlight });
    options.fail = ""; await h.controller.highlight(highlight);
    assert.deepEqual(h.calls.at(-1)?.body, highlight);
    assert.equal(h.submissions.length, 0);
    assert.equal(h.state().recovery, undefined);
    await assert.rejects(h.controller.highlight({ text: "x", url: "file:///private/a.pdf" }), /HTTP/);
    await assert.rejects(h.controller.highlight({ text: "x".repeat(20001), url: "https://example.org" }), /20,000/);
  });
  it("release only clears local binding; app entries are never automatically dismissed", async () => {
    const h = harness(); await h.controller.manual("a"); await h.controller.release();
    assert.equal(h.state().active, undefined);
    assert.deepEqual(h.calls.map((c) => c.path), ["queue"]);
  });
});

describe("extension config and transport boundaries", () => {
  it("accepts only HTTP loopback app addresses and the exact Expert AI HTTPS origin", () => {
    assert.equal(validateConfig({ ...DEFAULT_CONFIG, appUrl: "http://localhost:9999/" }).appUrl, "http://localhost:9999");
    for (const appUrl of ["https://127.0.0.1:47615", "http://example.org", "http://127.0.0.1:47615/api", "http://user:secret@localhost", "http://localhost/?token=x"]) {
      assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, appUrl }));
    }
    for (const expertUrl of ["http://ai.uptodate.com", "https://ai.uptodate.com.evil.org", "https://example.org"]) {
      assert.equal(isExpertUrl(expertUrl), false); assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, expertUrl }));
    }
  });
  it("surfaces API guard errors and incompatible or unpaired ping replies", async () => {
    for (const data of [{ ok: false, error: { message: "bad pairing token" } }, { ok: true, app: "learnharness", apiVersion: 2, authenticated: true }, { ok: true, app: "learnharness", apiVersion: 1, authenticated: false }]) {
      const api = new VerifyApi(DEFAULT_CONFIG, (async () => Response.json(data)) as typeof fetch);
      await assert.rejects(api.ping(), /pairing|version 1|token/i);
    }
    assert.deepEqual(referenceLines("https://example.org/a\n\n https://example.org/b "), [{ url: "https://example.org/a" }, { url: "https://example.org/b" }]);
  });
  it("manifest keeps content scripts exclusive to Expert AI; other pages use selection context menus", () => {
    const manifest = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(manifest.content_scripts[0].matches, ["https://ai.uptodate.com/*"]);
    assert.equal(manifest.content_scripts[0].all_frames, false);
    assert.equal(manifest.permissions.includes("scripting"), false);
    assert.equal(manifest.permissions.includes("tabs"), false);
    assert.equal(manifest.externally_connectable, undefined);
    assert.equal(manifest.web_accessible_resources, undefined);
  });
});


it("builds a self-contained unpacked extension in a temporary folder", async () => {
  const out = mkdtempSync(path.join(tmpdir(), "lh-extension-build-"));
  try {
    await buildExtension(out);
    const manifest = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8"));
    for (const file of [manifest.background.service_worker, manifest.action.default_popup, manifest.options_ui.page, ...manifest.content_scripts[0].js, "popup.js", "options.js", "clipboard.html", "clipboard.js", "style.css"]) {
      assert.equal(existsSync(path.join(out, file)), true, file);
    }
    for (const name of ["worker", "content", "popup", "options", "clipboard"]) {
      const code = readFileSync(path.join(out, `${name}.js`), "utf8");
      assert.doesNotMatch(code, /import\s.*from|require\(/, "bundles must not rely on Node or remote imports");
    }
    assert.doesNotMatch(readFileSync(path.join(out, "content.js"), "utf8"), /Bearer|fetch\(/, "content script cannot call the local API or access the pairing token");
  } finally { rmSync(out, { recursive: true, force: true }); }
});
