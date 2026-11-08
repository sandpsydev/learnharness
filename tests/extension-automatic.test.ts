import assert from "node:assert/strict";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../extension/config";
import type { Answer, Config, QueueItem, Reply, Request, SessionState } from "../extension/types";

// Browser API reconstruction only. Every fetch is intercepted, including any
// accidental external request; no live page or browser is used by this suite.
const bundle = build({ entryPoints: [new URL("../extension/worker.ts", import.meta.url).pathname], bundle: true, write: false, format: "iife", platform: "browser" });
const answer: Answer = { text: "Generic completed guidance", references: [{ title: "Generic topic", section: "Management" }], sourceUrl: "https://example.org/fixture" };
async function fixture(options: { automatic?: boolean; signedOut?: boolean; uncertain?: boolean; returnFails?: boolean; appOffline?: boolean } = {}) {
  const id = "local-fixture";
  const base = `chrome-extension://${id}/`;
  const local: { config: Config; attempt?: unknown } = { config: { ...DEFAULT_CONFIG, token: "private-fixture-token", automatic: options.automatic !== false } };
  const session: { state?: SessionState } = {};
  const queue: QueueItem[] = ["a", "b"].map((key) => ({ id: key, chatId: "chat", chatTitle: "Generic lesson", prompt: `Explain the management approach for generic condition ${key}.`, status: "queued", createdAt: "2026-10-30T00:00:00Z" }));
  const calls: string[] = [];
  const tabs = new Map([[7, { id: 7, windowId: 1, active: true, url: DEFAULT_CONFIG.expertUrl }]]);
  const submissions: Array<{ tabId: number; prompt: string; requestId: string; automatic: boolean }> = [];
  let listeners: Record<string, (...args: any[]) => any> = {};
  let alarm: unknown;
  let badge = "";
  let completed = false;
  let returnFails = options.returnFails;
  let appOffline = options.appOffline;
  let signedOut = options.signedOut;
  let bound: string | undefined;
  // What the managed tab's page shows about the prompt, and whether it needs injecting first.
  let probeVerdict: "sent" | "not-sent" | "unknown" | "busy" = "unknown";
  let needsInjection = false;
  let injected = 0;
  const probes: string[] = [];
  let askFails: string | undefined;
  const returns: Answer[] = [];
  const area = (data: object) => ({
    async setAccessLevel() {},
    async get(key: string) { return structuredClone({ [key]: (data as Record<string, unknown>)[key] }); },
    async set(values: object) { Object.assign(data, structuredClone(values)); },
  });
  const send = (message: Request, sender: unknown = { id, url: base + "popup.html" }) => new Promise<Reply>((resolve) => listeners.message!(message, sender, resolve));
  const chrome = {
    storage: { local: area(local), session: area(session) },
    runtime: {
      id, getURL: (file: string) => base + file,
      onMessage: { addListener(fn: (...args: any[]) => any) { listeners.message = fn; } },
      onStartup: { addListener(fn: () => void) { listeners.startup = fn; } },
      onInstalled: { addListener(fn: () => void) { listeners.installed = fn; } },
    },
    alarms: {
      async get() { return alarm; },
      async create(name: string, settings: unknown) { alarm = { name, settings }; },
      onAlarm: { addListener(fn: (...args: any[]) => any) { listeners.alarm = fn; } },
    },
    action: { async setBadgeText(value: { text: string }) { badge = value.text; }, async setTitle() {} },
    contextMenus: { removeAll(fn: () => void) { fn(); }, create() {}, onClicked: { addListener() {} } },
    commands: { onCommand: { addListener() {} } },
    tabs: {
      async create() { assert.fail("automatic work opens a window of its own, never a background tab"); },
      async get(tabId: number) { if (!tabs.has(tabId)) throw new Error("Tab closed"); return tabs.get(tabId); },
      async query() { assert.fail("automatic work must not choose any existing learner tab"); },
      async update() { assert.fail("automatic work must not activate a tab"); },
      async sendMessage(tabId: number, message: { type: string; prompt: string; requestId: string; automatic: boolean }) {
        assert.equal(tabId, 99);
        if (message.type === "lh-probe") {
          if (needsInjection && !injected) throw new Error("Receiving end does not exist.");
          probes.push(probeVerdict);
          if (probeVerdict === "sent") bound = message.requestId; // The page adopts a sent prompt.
          return { ok: true, verdict: probeVerdict, why: `fixture says ${probeVerdict}` };
        }
        if (message.type === "lh-ready") return { ok: true };
        if (message.type === "lh-returned") { bound = undefined; return { ok: true }; }
        if (message.type === "lh-collect") {
          if (bound !== message.requestId) return { ok: false, error: "Binding lost; use manual return, do not resubmit." };
          if (signedOut) return { ok: false, error: "Sign in to Expert AI yourself." };
          return { ok: true, ...(completed ? { answer } : {}) };
        }
        assert.equal(message.type, "lh-ask");
        if (askFails) {
          // The page began filling, then failed before pressing Send, as Chrome did in the background.
          const granted = await send({ type: "begin", requestId: message.requestId }, { id, frameId: 0, url: DEFAULT_CONFIG.expertUrl, tab: { id: tabId } });
          assert.equal(granted.ok, true);
          return { ok: false, submitted: false, untouched: false, error: askFails };
        }
        if (signedOut) return { ok: false, submitted: false, untouched: true, error: "Sign in to Expert AI yourself." };
        const granted = await send({ type: "begin", requestId: message.requestId }, { id, frameId: 0, url: DEFAULT_CONFIG.expertUrl, tab: { id: tabId } });
        assert.equal(granted.ok, true);
        submissions.push({ tabId, prompt: message.prompt, requestId: message.requestId, automatic: message.automatic });
        bound = message.requestId;
        if (options.uncertain) throw new Error("Lost submit acknowledgement");
        return { ok: true, submitted: true };
      },
    },
    scripting: {
      async executeScript(value: { target: { tabId: number }; files: string[] }) {
        assert.equal(JSON.stringify(value), JSON.stringify({ target: { tabId: 99, frameIds: [0] }, files: ["content.js"] }));
        injected++;
      },
    },
    windows: {
      async create(value: { url: string; focused: boolean; type: string }) {
        assert.equal(value.focused, false, "automatic work must not take focus");
        assert.equal(value.type, "normal");
        const tab = { id: 99, windowId: 2, active: true, url: value.url };
        tabs.set(99, tab); return { id: 2, focused: false, state: "normal", tabs: [tab] };
      },
      async get() { return { id: 2, focused: false, state: "normal" }; },
      async getLastFocused() { assert.fail("automatic runs must not consult learner focus"); },
      async update() { assert.fail("automatic runs must not focus any window"); },
    },
  };
  async function boot() {
    listeners = {};
    runInNewContext((await bundle).outputFiles[0]!.text, {
      chrome, URL, AbortSignal, crypto, setTimeout, console,
      fetch: async (url: string, init: RequestInit) => {
        assert.ok(url.startsWith("http://127.0.0.1:47615/v1/"), "all fetches must target the paired loopback API");
        assert.equal(new Headers(init.headers).get("Authorization"), "Bearer private-fixture-token");
        const path = url.split("/v1/")[1]!;
        calls.push(path);
        if (appOffline) throw new Error("App not running yet");
        if (path === "ping") return Response.json({ ok: true, app: "learnharness", apiVersion: 1, authenticated: true });
        if (path === "queue") return Response.json({ ok: true, items: queue });
        const key = path.split("/")[1];
        if (path.endsWith("/asked")) queue.find((q) => q.id === key)!.status = "asked";
        if (path.endsWith("/answer")) {
          if (returnFails) throw new Error("Local app offline");
          returns.push(JSON.parse(String(init.body)));
          queue.splice(queue.findIndex((q) => q.id === key), 1);
          return Response.json({ ok: true, next: queue.find((q) => q.status === "queued") ?? null });
        }
        return Response.json({ ok: true });
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
  }
  async function until(check: () => boolean) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.fail(`fixture did not settle: ${JSON.stringify(session.state)}`);
  }
  await boot();
  return {
    session, local, queue, calls, submissions, returns, tabs, boot, until, send,
    tick: () => listeners.alarm!({ name: "expert-ai-queue" }),
    ready: () => { completed = true; },
    badge: () => badge,
    alarm: () => alarm,
    signIn: () => { signedOut = false; },
    fixReturn: () => { returnFails = false; },
    startApp: () => { appOffline = false; },
    loseBinding: () => { bound = undefined; },
    probes, injected: () => injected,
    probeSays: (verdict: typeof probeVerdict) => { probeVerdict = verdict; },
    needInjection: () => { needsInjection = true; },
    pageFails: (error: string | undefined) => { askFails = error; },
    /** The state an extension reload leaves: local storage keeps the guard, session storage is gone. */
    leftBehind: (phase: "starting" | "manual" | "uncertain" | "asked", cause?: string) => {
      tabs.set(99, { id: 99, windowId: 2, active: true, url: DEFAULT_CONFIG.expertUrl });
      local.attempt = { item: queue[0], requestId: "old-request", tabId: 99, automatic: true, startedAt: Date.now() - 600_000, phase, ...(cause ? { cause } : {}) };
      session.state = undefined;
    },
  };
}

test("alarm discovers queue with popup closed; sleeping worker resumes automatic return and processes one at a time", async () => {
  const h = await fixture();
  assert.deepEqual(JSON.parse(JSON.stringify(h.alarm())), { name: "expert-ai-queue", settings: { periodInMinutes: 1 } });
  h.tick(); h.tick();
  await h.until(() => h.session.state?.active?.phase === "asked" && Boolean(h.session.state.notice));
  assert.equal(h.submissions.length, 1);
  assert.equal(h.submissions[0]!.automatic, true);
  assert.equal(h.submissions[0]!.prompt, h.queue[0]!.prompt);
  assert.equal(h.tabs.get(7)!.active, true, "learner tab is untouched");
  assert.equal(h.session.state!.managedTabId, 99);
  await h.boot(); // storage and content-script binding survive; worker memory does not
  const requestId = h.session.state!.active!.requestId;
  const sender = { id: "local-fixture", frameId: 0, url: DEFAULT_CONFIG.expertUrl, tab: { id: 99 } };
  assert.equal((await h.send({ type: "auto-ready", requestId: "old-request" }, sender)).ok, false);
  assert.equal((await h.send({ type: "auto-ready", requestId }, { ...sender, tab: { id: 7 } })).ok, false);
  h.ready();
  assert.equal((await h.send({ type: "auto-ready", requestId }, sender)).ok, true);
  await h.until(() => !h.session.state?.active);
  assert.deepEqual(h.returns, [answer]);
  assert.equal(h.submissions.length, 1, "return never resubmits");
  h.tick();
  await h.until(() => h.session.state?.active?.item.id === "b" && h.session.state.active.phase === "asked");
  assert.equal(h.submissions.length, 2);
  assert.equal(h.submissions[1]!.tabId, 99, "reuses only extension-managed tab");
});

test("signed-out automatic run pauses with badge, remains queued, and resumes only after settings save", async () => {
  const h = await fixture({ signedOut: true });
  h.tick();
  await h.until(() => Boolean(h.session.state?.automaticPaused));
  assert.equal(h.badge(), "!");
  assert.match(h.session.state!.notice!, /Automatic Expert AI paused.*Sign in/);
  assert.equal(h.session.state!.active, undefined);
  assert.equal(h.queue[0]!.status, "queued");
  assert.equal(h.submissions.length, 0);
  const calls = h.calls.length;
  h.signIn(); h.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.length, calls, "pause does not repeatedly try the page");
  assert.equal((await h.send({ type: "save-config", config: h.local.config })).ok, true);
  await h.until(() => h.session.state?.active?.phase === "asked");
  assert.equal(h.submissions.length, 1);
});

test("off switch blocks discovery and return; enabling resumes without resubmission", async () => {
  const h = await fixture({ automatic: false });
  h.tick(); await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.length, 0);
  await h.send({ type: "save-config", config: { ...h.local.config, automatic: true } });
  await h.until(() => h.session.state?.active?.phase === "asked");
  await h.send({ type: "save-config", config: { ...h.local.config, automatic: false } });
  h.ready(); h.tick(); await new Promise((r) => setImmediate(r));
  assert.equal(h.returns.length, 0);
  assert.equal(h.submissions.length, 1);
  await h.send({ type: "save-config", config: { ...h.local.config, automatic: true } });
  await h.until(() => h.returns.length === 1);
  assert.equal(h.submissions.length, 1);
});

test("uncertain automatic submission is never retried, even after worker restart and resume", async () => {
  const h = await fixture({ uncertain: true });
  h.tick(); await h.until(() => Boolean(h.session.state?.automaticPaused));
  assert.equal(h.session.state!.active!.phase, "uncertain");
  assert.equal(h.queue[0]!.status, "queued");
  await h.boot();
  await h.send({ type: "save-config", config: h.local.config });
  await h.until(() => Boolean(h.session.state?.automaticPaused));
  h.tick(); await new Promise((r) => setImmediate(r));
  assert.equal(h.submissions.length, 1);
});

test("automatic return failure retains answer and sources across worker sleep for safe delivery retry", async () => {
  const h = await fixture({ returnFails: true });
  h.tick(); await h.until(() => h.session.state?.active?.phase === "asked");
  h.ready(); h.tick(); await h.until(() => Boolean(h.session.state?.automaticPaused));
  assert.deepEqual(h.session.state!.recovery, { kind: "answer", answer });
  h.fixReturn(); await h.boot();
  await h.send({ type: "save-config", config: h.local.config });
  await h.until(() => h.returns.length === 1 && !h.session.state?.active);
  assert.equal(h.submissions.length, 1);
  assert.deepEqual(h.returns, [answer]);
});

test("lost page binding and interrupted starting state pause rather than submit again", async () => {
  for (const starting of [false, true]) {
    const h = await fixture();
    h.tick(); await h.until(() => h.session.state?.active?.phase === "asked");
    if (starting) h.session.state!.active!.phase = "starting";
    else h.loseBinding();
    await h.boot(); h.tick();
    await h.until(() => Boolean(h.session.state?.automaticPaused));
    assert.equal(h.submissions.length, 1);
    assert.match(h.session.state!.notice!, /manual|uncertain/);
  }
});

test("automatic mode screens queue prompts again and never fills identifier-bearing text", async () => {
  const h = await fixture();
  h.queue[0]!.prompt = "Manage patient HN 123456789 with fever";
  h.tick(); await h.until(() => Boolean(h.session.state?.automaticPaused));
  assert.equal(h.submissions.length, 0);
  assert.equal(h.tabs.has(99), false);
  assert.match(h.session.state!.notice!, /identifier check/);
});


test("a browser restart that clears session storage preserves the no-resubmit guard", async () => {
  const h = await fixture({ uncertain: true });
  h.tick(); await h.until(() => Boolean(h.session.state?.automaticPaused));
  h.session.state = undefined; // Chrome clears storage.session on browser restart.
  await h.boot(); h.tick();
  await h.until(() => Boolean(h.session.state?.automaticPaused));
  const restored = await h.send({ type: "state" });
  assert.equal(restored.ok, true);
  const state = (restored as { ok: true; data: SessionState }).data;
  assert.equal(state.active!.phase, "uncertain");
  assert.match(state.automaticPaused!, /could not prove whether it was sent.*did not confirm submission/s, "the first reason survives the restart");
  await h.send({ type: "save-config", config: h.local.config });
  await h.until(() => Boolean(h.session.state?.automaticPaused));
  assert.match(h.session.state!.automaticPaused!, /did not confirm submission/, "saving settings does not replace the first reason with a generic one");
  assert.equal(h.submissions.length, 1);
});

test("a fill that never reaches Send stops cleanly with its specific reason and leaves nothing to release", async () => {
  const h = await fixture();
  h.pageFails("Expert AI did not show the expected fresh conversation or submit control. (The Expert AI page is hidden from the browser.)");
  h.tick(); await h.until(() => Boolean(h.session.state?.automaticPaused));
  assert.equal(h.session.state!.active, undefined, "no stuck binding for the learner to release");
  assert.equal(h.local.attempt, null, "the durable guard is cleared because nothing was sent");
  assert.equal(h.queue[0]!.status, "queued");
  assert.match(h.session.state!.automaticPaused!, /filled in but never submitted.*hidden/s);
  assert.equal(h.calls.some((c) => c.endsWith("/asked")), false);
  // Once the page can send, saving settings is all it takes.
  h.pageFails(undefined);
  await h.send({ type: "save-config", config: h.local.config });
  await h.until(() => h.session.state?.active?.phase === "asked");
  assert.equal(h.submissions.length, 1);
});

test("after a reload, an attempt the page proves was never sent goes back to the queue and is asked again", async () => {
  for (const phase of ["manual", "uncertain", "starting"] as const) {
    const h = await fixture();
    h.leftBehind(phase, "Expert AI did not show the expected fresh conversation or submit control.");
    h.probeSays("not-sent");
    await h.boot();
    h.tick();
    await h.until(() => h.session.state?.active?.requestId !== undefined && h.session.state.active.requestId !== "old-request" && h.session.state.active.phase === "asked");
    assert.equal(h.session.state!.automaticPaused, undefined, `no stuck pause from ${phase}`);
    assert.equal(h.submissions.length, 1, "asked once, by the new attempt");
    assert.equal(h.submissions[0]!.prompt, h.queue[0]!.prompt);
    assert.equal(h.session.state!.managedTabId, 99, "the same managed tab is reused");
    assert.deepEqual(h.probes, ["not-sent"]);
  }
});

test("after a reload, an attempt the page proves was sent is collected and returned without a second submit", async () => {
  for (const phase of ["asked", "starting", "uncertain"] as const) {
    const h = await fixture();
    h.leftBehind(phase, "The tab did not confirm submission.");
    h.probeSays("sent");
    h.ready();
    await h.boot();
    h.tick();
    await h.until(() => h.returns.length === 1 && !h.session.state?.active);
    assert.equal(h.submissions.length, 0, `${phase}: never submitted again`);
    assert.equal(h.session.state!.automaticPaused, undefined);
    assert.ok(h.calls.some((c) => c === "queue/a/asked"), "the app is told it was asked");
  }
});

test("when the tab cannot prove it, the pause names what went wrong first and survives saving settings", async () => {
  const h = await fixture();
  h.leftBehind("manual", "Switch Expert AI to Standard, then retry.");
  h.probeSays("unknown");
  await h.boot();
  h.tick(); await h.until(() => Boolean(h.session.state?.automaticPaused));
  assert.match(h.session.state!.automaticPaused!, /fixture says unknown.*Switch Expert AI to Standard/s);
  assert.equal(h.session.state!.active!.phase, "uncertain", "after a restart nothing is assumed");
  assert.equal(h.submissions.length, 0);
  await h.send({ type: "save-config", config: h.local.config });
  await h.until(() => Boolean(h.session.state?.automaticPaused));
  assert.match(h.session.state!.automaticPaused!, /Switch Expert AI to Standard/);
  assert.match(h.session.state!.notice!, /Automatic Expert AI paused.*Switch Expert AI to Standard/s);
  assert.equal(h.submissions.length, 0);
});

test("a missing or foreign tab is never trusted, and a tab without the script is injected then inspected", async () => {
  const closed = await fixture();
  closed.leftBehind("uncertain", "x"); closed.tabs.delete(99);
  await closed.boot(); closed.tick(); await closed.until(() => Boolean(closed.session.state?.automaticPaused));
  assert.match(closed.session.state!.automaticPaused!, /tab was closed/);
  assert.equal(closed.submissions.length, 0);
  const foreign = await fixture();
  foreign.leftBehind("uncertain", "x"); foreign.tabs.get(99)!.url = "https://example.org/";
  await foreign.boot(); foreign.tick(); await foreign.until(() => Boolean(foreign.session.state?.automaticPaused));
  assert.match(foreign.session.state!.automaticPaused!, /no longer on Expert AI/);
  const loaded = await fixture();
  loaded.leftBehind("manual", "x"); loaded.needInjection(); loaded.probeSays("not-sent");
  await loaded.boot(); loaded.tick();
  await loaded.until(() => loaded.submissions.length === 1);
  assert.equal(loaded.injected(), 1, "the page script was added once to inspect the old tab");
});

test("a page that is still working on the question is left alone until it finishes", async () => {
  const h = await fixture();
  h.leftBehind("starting", "x"); (h.local.attempt as { startedAt: number }).startedAt = Date.now();
  h.probeSays("busy");
  await h.boot(); h.tick(); await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.session.state?.automaticPaused, undefined);
  assert.equal(h.submissions.length, 0);
});

test("manual Copy prompt takes over the current question until return or release", async () => {
  const h = await fixture();
  h.tick(); await h.until(() => h.session.state?.active?.phase === "asked");
  // Clipboard API is deliberately absent: the manual path must still work and
  // report that the prompt can be copied from the popup.
  const reply = await h.send({ type: "manual", id: "a" });
  assert.equal(reply.ok, true);
  h.ready(); h.tick(); await new Promise((r) => setImmediate(r));
  assert.equal(h.session.state!.active!.automatic, false);
  assert.equal(h.returns.length, 0);
});


test("completion timeout pauses with the current question intact and never resubmits", async () => {
  const h = await fixture();
  h.tick(); await h.until(() => h.session.state?.active?.phase === "asked");
  h.session.state!.active!.startedAt = Date.now() - 121_000;
  h.tick(); await h.until(() => Boolean(h.session.state?.automaticPaused));
  assert.equal(h.session.state!.active!.phase, "asked");
  assert.match(h.session.state!.notice!, /Completion was not detected/);
  h.tick(); await new Promise((r) => setImmediate(r));
  assert.equal(h.submissions.length, 1);
});


test("starting the app after Chrome requires no popup click to discover its queue", async () => {
  const h = await fixture({ appOffline: true });
  h.tick(); await h.until(() => Boolean(h.session.state?.notice?.includes("waiting for LearnHarness")));
  assert.equal(h.session.state!.automaticPaused, undefined);
  assert.equal(h.submissions.length, 0);
  h.startApp(); h.tick(); await h.until(() => h.session.state?.active?.phase === "asked");
  assert.equal(h.submissions.length, 1);
});

test("a manual question left behind by a restart still pauses automation and trusts no old tab ID", async () => {
  const h = await fixture();
  h.leftBehind("manual", "Sign in first.");
  (h.local.attempt as { automatic: boolean }).automatic = false;
  await h.boot();
  const reply = await h.send({ type: "state" });
  const state = (reply as { ok: true; data: SessionState }).data;
  assert.equal(state.active!.phase, "uncertain");
  assert.equal(state.active!.tabId, undefined);
  assert.match(state.automaticPaused!, /browser restarted.*Sign in first/);
  h.tick(); await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.probes, [], "a learner's manual question is never probed or released automatically");
  assert.equal(h.submissions.length, 0);
});
