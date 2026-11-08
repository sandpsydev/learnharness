import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { parseHTML } from "linkedom";
import { DEFAULT_CONFIG } from "../extension/config";
import type { Config, QueueItem, Reply, SessionState } from "../extension/types";

// The worker and the page script run together against a small model of Chrome's windows and
// tabs and a generic reconstructed Expert AI page. As on the real site, the page only enables
// Send while document.visibilityState is "visible". A tab that is not the selected tab of its
// window (a background tab) or a minimized window is hidden; a window that merely lacks focus
// is still visible. `coverUnfocused` models macOS occlusion: a managed window that is not the
// focused one is completely covered, so its page is hidden until the window is brought forward.
// No browser, account or live site is involved.
const fixture = readFileSync(new URL("./fixtures/extension/expert-ai.html", import.meta.url), "utf8");
const entry = (name: string) => build({ entryPoints: [new URL(`../extension/${name}.ts`, import.meta.url).pathname], bundle: true, write: false, format: "iife", platform: "browser" });
const workerBundle = entry("worker");
const contentBundle = entry("content");
type Listener = (message: unknown, sender: unknown, respond: (reply: unknown) => void) => boolean;
interface Win { id: number; focused: boolean; state: "normal" | "minimized"; tabs: number[]; active: number }
interface Options { automatic?: boolean; focusOnlyEditor?: boolean; coverUnfocused?: boolean; neverVisible?: boolean; collectNeedsVisible?: boolean }
interface Tab { id: number; windowId: number; active: boolean; url: string }
interface Page { document: Document; log: string[]; listener: Listener }

async function harness(options: Options = {}) {
  const id = "local-fixture";
  const base = `chrome-extension://${id}/`;
  const local: { config: Config; attempt?: unknown } = { config: { ...DEFAULT_CONFIG, token: "private-fixture-token", automatic: options.automatic !== false } };
  const session: { state?: SessionState } = {};
  const queue: QueueItem[] = ["a", "b"].map((key) => ({ id: key, chatId: "chat", chatTitle: "Generic lesson", prompt: `Explain the management approach for generic condition ${key}.`, status: "queued", createdAt: "2026-10-30T00:00:00Z" }));
  // The learner's own window 1 with their Expert AI tab selected and focused.
  const windows = new Map<number, Win>([[1, { id: 1, focused: true, state: "normal", tabs: [7], active: 7 }]]);
  const tabs = new Map<number, Tab>([[7, { id: 7, windowId: 1, active: true, url: DEFAULT_CONFIG.expertUrl }]]);
  const pages = new Map<number, Page>();
  const sent: Array<{ tabId: number; prompt: string }> = [];
  const created: Array<{ api: string; options: Record<string, unknown> }> = [];
  const visible = (tabId: number) => {
    const tab = tabs.get(tabId); const win = tab && windows.get(tab.windowId);
    if (!tab?.active || !win || win.state === "minimized") return false;
    if (options.neverVisible && tabId !== 7) return false;
    return !(options.coverUnfocused && win.id !== 1 && !win.focused);
  };
  let nextTab = 98, nextWindow = 1;
  const focusLog: number[] = [];
  const collects: string[] = [];
  const stateLog: string[] = [];
  let workerListener!: Listener;

  async function openPage(tabId: number): Promise<Page> {
    const { document, Event: FixtureEvent } = parseHTML(fixture);
    // The real site only enables Send when it can render, which needs a visible page.
    Object.defineProperty(document, "visibilityState", { get: () => (visible(tabId) ? "visible" : "hidden") });
    document.hasFocus = () => Boolean(windows.get(tabs.get(tabId)!.windowId)?.focused);
    document.querySelectorAll<HTMLElement>(".ec-modal").forEach((shell) => { shell.getClientRects = () => [{ width: 948, height: 0 }] as unknown as DOMRectList; });
    const log: string[] = [];
    const box = document.querySelector<HTMLElement>('[contenteditable="true"]')!;
    const send = box.closest("form")!.querySelector("button[type=submit]")!;
    // Like the real editor: when focusOnlyEditor is set, only its editing command updates its own
    // state, the command does nothing while the document lacks focus, and bare input events are ignored.
    let modelUpdated = false;
    box.addEventListener("input", () => {
      if (options.focusOnlyEditor && !modelUpdated) return;
      box.setAttribute("data-empty", "false");
      if (document.visibilityState === "visible") send.removeAttribute("disabled");
    });
    if (options.focusOnlyEditor) {
      const doc = document as unknown as Record<string, unknown>;
      doc.getSelection = () => ({ removeAllRanges() {}, addRange() {} });
      doc.createRange = () => ({ selectNodeContents() {} });
      doc.execCommand = (_command: string, _ui: boolean, text: string) => {
        if (!document.hasFocus()) return true; // Reports success, changes nothing.
        modelUpdated = true; box.textContent = text; box.dispatchEvent(new FixtureEvent("input", { bubbles: true })); modelUpdated = false;
        return true;
      };
    }
    send.addEventListener("click", () => { log.push(`submit:${box.textContent}`); sent.push({ tabId, prompt: box.textContent ?? "" }); });
    // A fresh conversation empties the composer again.
    document.querySelector('button[data-e2e="header-new-conversation"]')!.addEventListener("click", () => {
      box.textContent = ""; box.setAttribute("data-empty", "true"); send.setAttribute("disabled", "");
    });
    let listener!: Listener;
    let now = 0;
    const compiled = await contentBundle;
    runInNewContext(compiled.outputFiles[0]!.text, {
      document, location: { href: "https://example.org/generic-fixture" }, InputEvent: FixtureEvent, Date: { now: () => now },
      MutationObserver: class { constructor(_: () => void) {} observe() {} disconnect() {} },
      // A fake clock lets the page's ten-second waits finish at once.
      setTimeout(callback: () => void, ms: number) { if (ms === 120_000) return 1; now += ms; setImmediate(callback); return 2; },
      clearTimeout() {},
      chrome: { runtime: { id, onMessage: { addListener(callback: Listener) { listener = callback; } },
        sendMessage: (request: unknown) => new Promise((resolve) => workerListener(request, { id, frameId: 0, url: DEFAULT_CONFIG.expertUrl, tab: { id: tabId } }, resolve)) } },
    });
    // A page whose answer can only be read while it is visible.
    const guarded: Listener = options.collectNeedsVisible
      ? (message, sender, respond) => (message as { type?: string }).type === "lh-collect" && document.visibilityState !== "visible"
        ? (collects.push("hidden"), respond({ ok: false, error: "The answer could not be read." }), false)
        : (message as { type?: string }).type === "lh-collect" ? (collects.push("visible"), respond({ ok: true }), false) : listener(message, sender, respond)
      : listener;
    const page = { document, log, listener: guarded };
    pages.set(tabId, page);
    return page;
  }
  const addTab = (windowId: number, active: boolean): Tab => {
    const win = windows.get(windowId)!;
    const tab = { id: nextTab++, windowId, active, url: DEFAULT_CONFIG.expertUrl };
    if (active) for (const other of win.tabs) tabs.get(other)!.active = false;
    tabs.set(tab.id, tab); win.tabs.push(tab.id); if (active) win.active = tab.id;
    void openPage(tab.id);
    return tab;
  };
  const area = (data: object) => ({
    async setAccessLevel() {},
    async get(key: string) { return structuredClone({ [key]: (data as Record<string, unknown>)[key] }); },
    async set(values: object) { Object.assign(data, structuredClone(values)); },
  });
  const chrome = {
    storage: { local: area(local), session: area(session) },
    runtime: { id, getURL: (file: string) => base + file,
      onMessage: { addListener(fn: Listener) { workerListener = fn; } }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
    alarms: { async get() { return {}; }, async create() {}, onAlarm: { addListener(fn: (alarm: { name: string }) => void) { (chrome as { fire?: typeof fn }).fire = fn; } } },
    action: { async setBadgeText() {}, async setTitle() {} },
    contextMenus: { removeAll(fn: () => void) { fn(); }, create() {}, onClicked: { addListener() {} } },
    commands: { onCommand: { addListener() {} } },
    tabs: {
      async create(value: { url: string; active?: boolean; windowId?: number }) {
        created.push({ api: "tabs.create", options: value });
        const tab = addTab(value.windowId ?? 1, value.active !== false);
        return structuredClone(tab);
      },
      async get(tabId: number) { if (!tabs.has(tabId)) throw new Error("No tab with that id"); return structuredClone(tabs.get(tabId)!); },
      async query() { assert.fail("automatic work must not choose a learner tab"); },
      async update() { assert.fail("automatic work must not activate a tab"); },
      async sendMessage(tabId: number, message: unknown) {
        const page = pages.get(tabId);
        if (!page) throw new Error("Receiving end does not exist.");
        return new Promise((resolve) => { if (!page.listener(message, { id }, resolve)) resolve(undefined); });
      },
    },
    windows: {
      async create(value: { url?: string; tabId?: number; focused?: boolean; type?: string; width?: number; height?: number; state?: string }) {
        created.push({ api: "windows.create", options: value });
        const win: Win = { id: 100 + nextWindow++, focused: value.focused !== false, state: "normal", tabs: [], active: 0 };
        if (win.focused) for (const other of windows.values()) other.focused = false;
        windows.set(win.id, win);
        let tab: Tab;
        if (value.tabId !== undefined) {
          // Moving an existing tab into its own window.
          tab = tabs.get(value.tabId)!;
          const old = windows.get(tab.windowId)!;
          old.tabs = old.tabs.filter((other) => other !== tab.id);
          if (old.active === tab.id) { old.active = old.tabs[0] ?? 0; if (old.active) tabs.get(old.active)!.active = true; }
          tab.windowId = win.id; tab.active = true; win.tabs = [tab.id]; win.active = tab.id;
        } else tab = addTab(win.id, true);
        return structuredClone({ ...win, tabs: [tab] });
      },
      async get(windowId: number) { const win = windows.get(windowId); if (!win) throw new Error("No window with that id"); return structuredClone(win); },
      async getLastFocused() { return structuredClone([...windows.values()].find((win) => win.focused)!); },
      async update(windowId: number, value: { focused?: boolean; state?: "normal" | "minimized" }) {
        const win = windows.get(windowId);
        if (!win) throw new Error("No window with that id");
        if (value.state) { stateLog.push(`${windowId}:${value.state}`); win.state = value.state; }
        if (value.focused) { focusLog.push(windowId); for (const other of windows.values()) other.focused = other.id === windowId; }
        return structuredClone(win);
      },
    },
    scripting: { async executeScript() { throw new Error("unexpected injection"); } },
  };
  runInNewContext((await workerBundle).outputFiles[0]!.text, {
    chrome, URL, AbortSignal, crypto, console,
    // The worker's polling waits finish at once; the order of events is what is under test.
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, Math.min(ms, 1)),
    fetch: async (url: string, init: RequestInit) => {
      assert.ok(url.startsWith("http://127.0.0.1:47615/v1/"), "all fetches must target the paired loopback API");
      const path = url.split("/v1/")[1]!;
      if (path === "ping") return Response.json({ ok: true, app: "learnharness", apiVersion: 1, authenticated: true });
      if (path === "queue") return Response.json({ ok: true, items: queue });
      const key = path.split("/")[1];
      if (path.endsWith("/asked")) queue.find((q) => q.id === key)!.status = "asked";
      void init;
      return Response.json({ ok: true });
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await openPage(7);
  const send = (message: unknown) => new Promise<Reply>((resolve) => workerListener(message, { id, url: base + "popup.html" }, resolve as (reply: unknown) => void));
  async function until(check: () => boolean) {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.fail(`fixture did not settle: ${JSON.stringify(session.state)}`);
  }
  const submits = () => sent;
  return {
    session, focusLog, stateLog, collects, queue, windows, tabs, addBackgroundTab: () => addTab(1, false), pages, created, visible, send, until, submits, local,
    tick: () => (chrome as unknown as { fire: (alarm: { name: string }) => void }).fire({ name: "expert-ai-queue" }),
    settle: async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 2)); },
    release: () => send({ type: "release" }),
  };
}

test("a queued question is typed and sent from its own unfocused window, leaving the learner's tab alone", async () => {
  const h = await harness();
  h.tick();
  await h.until(() => h.session.state?.active?.phase === "asked");
  assert.deepEqual(h.submits().map((s) => s.prompt), [h.queue[0]!.prompt], "typed and sent exactly once");
  assert.equal(h.session.state!.automaticPaused, undefined);
  const managed = h.tabs.get(h.session.state!.managedTabId!)!;
  assert.notEqual(managed.windowId, 1, "the managed page does not live in the learner's window");
  assert.equal(h.visible(managed.id), true, "the page can see itself, so Expert AI enables Send");
  assert.equal(h.windows.get(managed.windowId)!.focused, false, "it never took focus");
  assert.equal(h.windows.get(1)!.focused, true);
  assert.equal(h.tabs.get(7)!.active, true, "the learner's tab is still the selected one");
  assert.deepEqual(h.focusLog, [], "a visible managed page needs no focus at all");
  const windowCalls = h.created.filter((call) => call.api === "windows.create");
  assert.equal(windowCalls.length, 1);
  assert.equal(windowCalls[0]!.options.focused, false);
  assert.notEqual(windowCalls[0]!.options.state, "minimized");
  assert.equal(h.created.some((call) => call.api === "tabs.create" && call.options.active === false), false, "no hidden background tab");
});

test("the same window is reused for the next question and recreated when the learner closes it", async () => {
  const h = await harness();
  h.tick();
  await h.until(() => h.session.state?.active?.phase === "asked");
  const first = h.session.state!.managedTabId!;
  await h.release(); h.tick();
  await h.until(() => h.session.state?.active?.phase === "asked" && h.submits().length === 2);
  assert.equal(h.session.state!.managedTabId, first, "reuses the managed page");
  assert.equal(h.created.filter((call) => call.api === "windows.create").length, 1, "no second window");
  // The learner closes the managed window.
  const gone = h.tabs.get(first)!.windowId;
  h.windows.delete(gone); h.tabs.delete(first); h.pages.delete(first);
  await h.release(); h.queue.forEach((q) => { q.status = "queued"; }); h.tick();
  await h.until(() => h.submits().length === 3 && h.session.state?.active?.phase === "asked");
  assert.notEqual(h.session.state!.managedTabId, first);
  assert.equal(h.created.filter((call) => call.api === "windows.create").length, 2, "a new window replaced the closed one");
  assert.equal(h.session.state!.automaticPaused, undefined);
  assert.equal(h.tabs.get(7)!.active, true);
});

test("an older managed page left as a background tab is moved into its own window", async () => {
  const h = await harness();
  // The old version opened the managed page as a hidden background tab in the learner's window.
  const old = h.addBackgroundTab();
  await h.settle();
  assert.equal(h.visible(old.id), false);
  h.session.state = { managedTabId: old.id };
  h.tick();
  await h.until(() => h.submits().length === 1);
  assert.deepEqual(h.submits().map((s) => s.tabId), [old.id], "the same page is reused");
  assert.equal(h.visible(old.id), true, "it was moved to a window of its own");
  assert.notEqual(h.tabs.get(old.id)!.windowId, 1);
  assert.equal(h.tabs.get(7)!.active, true);
  assert.equal(h.windows.get(1)!.focused, true);
  assert.equal(h.session.state!.automaticPaused, undefined);
});

/** After the first question the managed window is hidden somehow, then the next question is queued. */
async function hiddenSecondQuestion(h: Awaited<ReturnType<typeof harness>>, hide: (windowId: number) => void) {
  h.tick();
  await h.until(() => h.session.state?.active?.phase === "asked");
  const id = h.session.state!.managedTabId!;
  const windowId = h.tabs.get(id)!.windowId;
  await h.release();
  h.queue[0]!.status = "asked";
  h.focusLog.length = 0;
  hide(windowId);
  h.tick();
  return { id, windowId };
}

test("a minimized managed window is restored, brought forward for the fill and Send, and focus goes back", async () => {
  const h = await harness({ coverUnfocused: true });
  const { id, windowId } = await hiddenSecondQuestion(h, (windowId) => { h.windows.get(windowId)!.state = "minimized"; });
  await h.until(() => h.submits().length === 2 && h.session.state?.active?.phase === "asked");
  assert.deepEqual(h.submits().map((s) => s.prompt), [h.queue[0]!.prompt, h.queue[1]!.prompt], "the second question was typed and sent once");
  assert.deepEqual(h.stateLog, [`${windowId}:normal`], "the window was un-minimized");
  assert.deepEqual(h.focusLog, [windowId, 1], "focus was borrowed once and handed straight back");
  assert.equal(h.windows.get(1)!.focused, true);
  assert.equal(h.windows.get(windowId)!.state, "normal");
  assert.equal(h.session.state!.automaticPaused, undefined);
  assert.equal(h.session.state!.managedTabId, id);
});

test("a completely covered managed window is brought forward for the fill and Send, then focus goes straight back", async () => {
  const h = await harness({ coverUnfocused: true });
  const { id, windowId } = await hiddenSecondQuestion(h, () => {});
  assert.equal(h.visible(id), false, "the unfocused managed window is covered, so its page is hidden");
  await h.until(() => h.submits().length === 2 && h.session.state?.active?.phase === "asked");
  assert.deepEqual(h.submits().map((s) => s.prompt), [h.queue[0]!.prompt, h.queue[1]!.prompt]);
  assert.deepEqual(h.stateLog, [], "it was not minimized, so its state is left alone");
  assert.deepEqual(h.focusLog, [windowId, 1], "one borrow held through Send, then handed back");
  assert.equal(h.windows.get(1)!.focused, true);
  assert.equal(h.session.state!.automaticPaused, undefined);
});

test("an editor that needs focus and a covered window share one borrow, kept until Send is pressed", async () => {
  const h = await harness({ coverUnfocused: true, focusOnlyEditor: true });
  const { windowId } = await hiddenSecondQuestion(h, () => {});
  await h.until(() => h.submits().length === 2 && h.session.state?.active?.phase === "asked");
  assert.deepEqual(h.focusLog, [windowId, 1], "not borrowed again for the fill, and not given back before Send");
  assert.equal(h.windows.get(1)!.focused, true);
  assert.equal(h.session.state!.automaticPaused, undefined);
});

test("a managed page that never becomes visible still pauses with the hidden message and sends nothing", async () => {
  const h = await harness({ coverUnfocused: true, neverVisible: true });
  h.tick();
  await h.until(() => Boolean(h.session.state?.automaticPaused));
  const reason = h.session.state!.automaticPaused!;
  assert.match(reason, /hidden.*minimized or completely covered/i);
  assert.doesNotMatch(reason + h.session.state!.notice, /sign in|university network/i, "a hidden page is not a sign-in problem");
  assert.equal(h.submits().length, 0, "nothing was sent");
  assert.equal(h.session.state!.active, undefined, "no stuck binding");
  assert.equal(h.queue[0]!.status, "queued");
  assert.equal(h.local.attempt, null);
  assert.equal(h.windows.get(1)!.focused, true, "focus was handed back after the failed attempt");
});

test("answer collection that fails in a hidden window borrows focus once for the read, then gives it back", async () => {
  const h = await harness({ coverUnfocused: true, collectNeedsVisible: true });
  h.tick();
  await h.until(() => h.session.state?.active?.phase === "asked");
  assert.deepEqual(h.focusLog, [h.tabs.get(h.session.state!.managedTabId!)!.windowId, 1], "the fill and Send were done with the window forward");
  h.focusLog.length = 0;
  // The answer is due: the page is covered again and its read needs it visible.
  h.tick();
  await h.until(() => h.collects.includes("visible"));
  await h.settle();
  assert.deepEqual(h.collects, ["hidden", "visible"], "tried first without disturbing anyone, then once with the window forward");
  assert.deepEqual(h.focusLog, [h.tabs.get(h.session.state!.managedTabId!)!.windowId, 1]);
  assert.equal(h.windows.get(1)!.focused, true);
  assert.equal(h.session.state!.automaticPaused, undefined, "hidden window during collection does not pause");
});

// The owner's live failure: the managed window is opened unfocused, and the real editor ignores
// its editing command in a document without focus, so Send never came alive.
test("an editor that ignores text while its window is unfocused still gets the question, and focus goes straight back", async () => {
  const h = await harness({ focusOnlyEditor: true });
  h.tick();
  await h.until(() => h.session.state?.active?.phase === "asked");
  assert.deepEqual(h.submits().map((s) => s.prompt), [h.queue[0]!.prompt], "typed and sent exactly once");
  const managed = h.tabs.get(h.session.state!.managedTabId!)!;
  assert.deepEqual(h.focusLog, [managed.windowId, 1], "focus was borrowed for the fill, then handed back to the learner's window");
  assert.equal(h.windows.get(1)!.focused, true);
  assert.equal(h.windows.get(managed.windowId)!.focused, false);
  assert.equal(h.session.state!.automaticPaused, undefined);
});
