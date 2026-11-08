import { VerifyApi } from "./api";
import { DEFAULT_CONFIG, isExpertUrl, validateConfig } from "./config";
import { Attempts } from "./attempts";
import { ExtensionController } from "./controller";
import { HIDDEN_HELP } from "./expert-page";
import { errorMessage } from "./types";
import type { ActiveQuestion, Config, QueueItem, Request, SessionState } from "./types";
import type { Evidence, PageResult } from "./controller";

const ready = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
  chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
]);
async function config(): Promise<Config> {
  await ready;
  return validateConfig({ ...DEFAULT_CONFIG, ...(await chrome.storage.local.get<{ config?: Config }>("config")).config });
}
async function read(): Promise<SessionState> {
  await ready;
  const state = (await chrome.storage.session.get<{ state?: SessionState }>("state")).state ?? {};
  const attempt = (await chrome.storage.local.get<{ attempt?: ActiveQuestion }>("attempt")).attempt;
  // Session data clears on browser restart/reload. A durable guard prevents an
  // interrupted fill from becoming a new automatic submission of the same item.
  if (attempt && state.active?.requestId !== attempt.requestId) {
    const cause = attempt.cause ?? "An earlier attempt was interrupted before it finished.";
    if (attempt.automatic) {
      // An extension reload or browser restart is not a reason to stay stuck: keep the tab
      // as a place to look and let the next automatic check settle it from the page itself.
      // A tab ID is only a lead; the page must show the prompt before anything is trusted.
      return { ...state, active: { ...attempt, phase: "uncertain", cause }, notice: "Checking an earlier question after the extension restarted…" };
    }
    const reason = `An earlier question was interrupted or the browser restarted (${cause}) Check Expert AI and return its answer manually, or deliberately release the question. It will not be submitted again.`;
    return { ...state, active: { ...attempt, phase: "uncertain", tabId: undefined, cause }, automaticPaused: reason, notice: reason };
  }
  return state;
}
async function write(state: SessionState) {
  await ready;
  // Persist the guard before starting; clear it only after clearing the session
  // binding. A crash between writes can pause unnecessarily, but cannot resend.
  if (state.active) await chrome.storage.local.set({ attempt: state.active });
  await chrome.storage.session.set({ state });
  if (!state.active) await chrome.storage.local.set({ attempt: null, sendMark: null });
  await chrome.action.setBadgeText({ text: state.automaticPaused ? "!" : state.notice ? "•" : "" });
  await chrome.action.setTitle({ title: state.automaticPaused ? `Automatic Expert AI paused: ${state.automaticPaused}` : state.notice ?? "LearnHarness Medical" });
}
/**
 * The durable "Send is about to be pressed" marker. The page asks for it just before it clicks
 * Send, and the click only happens if this answers yes. So an attempt with no marker provably
 * never pressed Send, however it was cut off (extension reload, page reload or redirect, worker
 * restart). `fenceUnsent` is the other half: it decides "never sent" and, in the same step,
 * refuses any marker for that request afterwards, so a page script that outlived the decision
 * can no longer press Send for a question that has already gone back to the queue.
 */
interface SendMark { requestId: string; state: "pressing" | "fenced" }
let marking: Promise<unknown> = Promise.resolve();
function serialized<T>(action: () => Promise<T>): Promise<T> {
  const run = marking.then(action, action);
  marking = run.catch(() => {});
  return run;
}
const currentMark = async () => (await chrome.storage.local.get<{ sendMark?: SendMark | null }>("sendMark")).sendMark ?? undefined;
const NO_LONGER_WAITING = "This question is no longer waiting for Expert AI, so Send was not pressed. Nothing was sent.";
function markSending(requestId: string, tabId: number) {
  return serialized(async () => {
    await ready;
    const attempt = (await chrome.storage.local.get<{ attempt?: ActiveQuestion | null }>("attempt")).attempt;
    const mark = await currentMark();
    if (!attempt || attempt.requestId !== requestId || attempt.tabId !== tabId || (mark?.requestId === requestId && mark.state === "fenced")) throw new Error(NO_LONGER_WAITING);
    await chrome.storage.local.set({ sendMark: { requestId, state: "pressing" } satisfies SendMark });
  });
}
function fenceUnsent(requestId: string) {
  return serialized(async () => {
    await ready;
    const mark = await currentMark();
    if (mark?.requestId === requestId && mark.state === "pressing") return false;
    await chrome.storage.local.set({ sendMark: { requestId, state: "fenced" } satisfies SendMark });
    return true;
  });
}
/** How many times each queued question was cut off before Send, so a repeating problem cannot loop. */
const interruptions = {
  async get(itemId: string) { return (await chrome.storage.local.get<{ interruptions?: Record<string, number> | null }>("interruptions")).interruptions?.[itemId] ?? 0; },
  async set(itemId: string, count: number) {
    const all = { ...(await chrome.storage.local.get<{ interruptions?: Record<string, number> | null }>("interruptions")).interruptions };
    if (count > 0) all[itemId] = count; else delete all[itemId];
    await chrome.storage.local.set({ interruptions: all });
  },
  async reset() { await chrome.storage.local.set({ interruptions: null }); },
};
let clipboardCreating: Promise<void> | undefined;
async function clipboard(text: string) {
  if (!(await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] })).length) {
    clipboardCreating ??= chrome.offscreen.createDocument({ url: "clipboard.html", reasons: [chrome.offscreen.Reason.CLIPBOARD], justification: "Copy the learner-requested prompt or unsent evidence for manual fallback." });
    try { await clipboardCreating; } finally { clipboardCreating = undefined; }
  }
  const response = await chrome.runtime.sendMessage({ target: "clipboard", text });
  if (!response?.ok) throw new Error("Clipboard is unavailable.");
}
/**
 * Expert AI only enables Send in a page the browser considers visible, so the managed page is
 * the selected tab of a normal window of its own. It is created unfocused, so it never takes
 * over what the learner is looking at, and it is not minimized.
 */
const MANAGED_WINDOW = { type: "normal", focused: false, width: 1100, height: 800 } as const;
async function focusExpert(automatic = false) {
  if (automatic) {
    const state = await read();
    let tab: chrome.tabs.Tab | undefined;
    if (state.managedTabId !== undefined) {
      try { tab = await chrome.tabs.get(state.managedTabId); } catch { /* Managed tab was closed. */ }
    }
    if (tab?.id !== undefined) {
      // A page that is mid-redirect may be passing through another address; submit() waits for it.
      if (!isExpertUrl(tab.url ?? "") && tab.status !== "loading") throw new Error("The managed Expert AI tab is on a sign-in or different page. Sign in there, then retry.");
      if (tab.windowId === state.managedWindowId) return tab.id;
      // A managed page from before it had its own window is a hidden background tab; give it one.
      const win = await chrome.windows.create({ tabId: tab.id, ...MANAGED_WINDOW });
      if (win?.id === undefined) throw new Error("Could not give the Expert AI page a window of its own.");
      await write({ ...state, managedWindowId: win.id });
      return tab.id;
    }
    // Never select a learner-owned conversation or take focus from the learner.
    const win = await chrome.windows.create({ url: (await config()).expertUrl, ...MANAGED_WINDOW });
    const created = win?.tabs?.[0];
    if (created?.id === undefined || win?.id === undefined) throw new Error("Could not open the separate Expert AI window.");
    await write({ ...state, managedTabId: created.id, managedWindowId: win.id });
    return created.id;
  }
  const current = await chrome.windows.getLastFocused();
  const tabs = await chrome.tabs.query({ url: "https://ai.uptodate.com/*" });
  const existing = tabs.find((tab) => tab.windowId === current.id && tab.active) ?? tabs.find((tab) => tab.windowId === current.id) ?? tabs[0];
  const tab = existing ?? await chrome.tabs.create({ url: (await config()).expertUrl, active: true });
  if (tab.id === undefined) throw new Error("Could not open Expert AI. Copy the prompt instead.");
  const state = await read();
  if (state.managedTabId === tab.id) await write({ ...state, managedTabId: undefined, managedWindowId: undefined });
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
  return tab.id;
}
const attempts = new Attempts();
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** How long a just-opened or redirecting managed page may take to reach Expert AI with its script running. */
const PAGE_READY_MS = 30_000;
const hostOf = (value: string) => { try { return new URL(value).host; } catch { return "another site"; } };
/**
 * Focus the managed window borrows, and who gets it back. `held` means the worker keeps it until
 * it is released explicitly (through Send); otherwise the page may hand it back after a fill.
 */
let borrow: { from?: number; held: boolean } | undefined;
/** Remember the learner's focused window the first time only, then focus the managed one. */
async function takeFocus(managedWindow: number, held: boolean, beforeFocus?: () => Promise<unknown>) {
  if (!borrow) {
    const before = await chrome.windows.getLastFocused();
    borrow = { from: before.id !== undefined && before.id !== managedWindow ? before.id : undefined, held };
  } else borrow.held ||= held;
  await beforeFocus?.();
  await chrome.windows.update(managedWindow, { focused: true });
}
/** Hand focus back to the window the learner was using. A held borrow is only released with `force`. */
async function giveBackFocus(force: boolean) {
  if (!borrow || (borrow.held && !force)) return;
  const previous = borrow.from;
  borrow = undefined;
  if (previous !== undefined) await chrome.windows.update(previous, { focused: true }).catch(() => {});
}
/** What the managed page says about itself; an older page script that does not say is taken as visible. */
async function pageHidden(tabId: number) {
  try { return (await chrome.tabs.sendMessage(tabId, { type: "lh-ready" }, { frameId: 0 }))?.visible === false; } catch { return false; }
}
/** How long a hidden managed page gets to show once its window is restored and focused. */
const VISIBLE_POLLS = 50;
const VISIBLE_POLL_MS = 100;
/**
 * Make a hidden managed page visible: restore a minimized window and borrow focus (a window that
 * is completely covered counts as hidden too). Returns false only if the page still is not
 * visible after that, and then hands focus straight back. Focus stays borrowed on success.
 */
async function revealManaged(tabId: number, held = true): Promise<boolean> {
  if (!(await pageHidden(tabId))) return true;
  const tab = await chrome.tabs.get(tabId);
  const win = await chrome.windows.get(tab.windowId);
  await takeFocus(tab.windowId, held, async () => { if (win.state === "minimized") await chrome.windows.update(tab.windowId, { state: "normal" }); });
  for (let poll = 0; poll < VISIBLE_POLLS; poll++) {
    if (!(await pageHidden(tabId))) return true;
    await delay(VISIBLE_POLL_MS);
  }
  await giveBackFocus(true);
  return false;
}
async function submit(tabId: number, item: QueueItem, requestId: string, automatic = false): Promise<PageResult> {
  // Wait for the tab's content script. Never retry a submit.
  attempts.open(requestId, tabId);
  let connected = false;
  let elsewhere: string | undefined;
  const deadline = Date.now() + PAGE_READY_MS;
  for (let attempt = 0; attempt === 0 || Date.now() < deadline; attempt++) {
    const tab = await chrome.tabs.get(tabId);
    const win = await chrome.windows.get(tab.windowId);
    // A hidden managed page (minimized or covered window) is brought forward below, once its script is up.
    if (!automatic && (!tab.active || !win.focused)) return { ok: false, submitted: false, untouched: true, error: "Keep the Expert AI tab visible and its window focused, then retry." };
    elsewhere = undefined;
    if (tab.url && !isExpertUrl(tab.url)) {
      // A learner's own tab is never waited on. A managed page can pass through other addresses
      // while it redirects, so it gets the same bounded wait as a page that is still loading.
      if (!automatic) return { ok: false, submitted: false, untouched: true, error: "The tab is not on Expert AI, which can happen at a sign-in screen." };
      elsewhere = hostOf(tab.url);
    } else {
      // A tab that is still opening has no committed URL yet; keep waiting for it.
      try { connected = (await chrome.tabs.sendMessage(tabId, { type: "lh-ready" }, { frameId: 0 }))?.ok === true; } catch { /* Page still loading. */ }
    }
    if (connected) break;
    await delay(400);
  }
  if (!connected && elsewhere) return { ok: false, submitted: false, untouched: true, signedOut: true, error: `The Expert AI window stayed on ${elsewhere}, which is a sign-in or other page, for ${PAGE_READY_MS / 1000} seconds.` };
  if (!connected) return { ok: false, submitted: false, untouched: true, error: `The Expert AI window did not become ready within ${PAGE_READY_MS / 1000} seconds. If it asks you to sign in, sign in there. Otherwise reload it or use manual paste-back.` };
  try {
    // Expert AI will not enable Send in a hidden page, and a covered or minimized window is hidden.
    // Bring the managed window forward and keep it there until Send has been pressed.
    if (automatic && !(await revealManaged(tabId))) return { ok: false, submitted: false, untouched: true, hidden: true, error: HIDDEN_HELP };
    return await chrome.tabs.sendMessage(tabId, { type: "lh-ask", prompt: item.prompt, requestId, automatic }, { frameId: 0 });
  } finally {
    if (automatic) await giveBackFocus(true);
  }
}
async function probe(active: ActiveQuestion): Promise<Evidence> {
  const tabId = active.tabId;
  if (tabId === undefined) return { verdict: "unknown", why: "No tab was recorded for it" };
  let tab: chrome.tabs.Tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return { verdict: "unknown", why: "Its tab was closed" }; }
  if (!isExpertUrl(tab.url ?? "")) return { verdict: "unknown", why: "Its tab is no longer on Expert AI" };
  const ask = () => chrome.tabs.sendMessage(tabId, { type: "lh-probe", requestId: active.requestId, prompt: active.item.prompt }, { frameId: 0 });
  let reply: { ok: boolean; verdict?: Evidence["verdict"]; why?: string; error?: string } | undefined;
  try { reply = await ask(); }
  catch {
    // The tab was loaded before this extension version started, so it has no live script.
    try {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["content.js"] });
      reply = await ask();
    } catch { return { verdict: "unknown", why: "Its tab could not be inspected" }; }
  }
  if (!reply?.ok || !reply.verdict) return { verdict: "unknown", why: reply?.error ?? "Its tab gave no answer" };
  return { verdict: reply.verdict, why: reply.why ?? "", tabId };
}
const controller = new ExtensionController({ probe, fenceUnsent, interruptions, api: async () => new VerifyApi(await config()), read, write, focusExpert, submit, clipboard,
  completed: async (active) => {
    if (active.tabId !== undefined) await chrome.tabs.sendMessage(active.tabId, { type: "lh-returned", requestId: active.requestId }, { frameId: 0 });
  },
  collect: async (active) => {
    if (active.tabId === undefined || (await read()).managedTabId !== active.tabId) throw new Error("The automatic question has no managed tab. Use manual return.");
    const tab = await chrome.tabs.get(active.tabId);
    if (!isExpertUrl(tab.url ?? "")) throw new Error("Sign in to Expert AI in its managed tab, then retry. The extension never signs in.");
    const ask = () => chrome.tabs.sendMessage(active.tabId!, { type: "lh-collect", requestId: active.requestId }, { frameId: 0 });
    let reply = await ask().catch(() => undefined);
    if (!reply?.ok && await pageHidden(active.tabId)) {
      // Reading the answer failed in a hidden window: bring it forward just for this read, then hand focus back.
      try { if (await revealManaged(active.tabId, false)) reply = await ask().catch(() => reply); }
      finally { await giveBackFocus(true); }
    }
    if (!reply?.ok) throw new Error(reply?.error ?? "The managed Expert AI page did not respond. Use manual return.");
    return reply.answer;
  }, closeAttempt: async (requestId) => attempts.close(requestId) });
const extensionPages = new Set([chrome.runtime.getURL("popup.html"), chrome.runtime.getURL("options.html")]);
async function handle(message: Request, sender: chrome.runtime.MessageSender) {
  if (sender.id !== chrome.runtime.id) throw new Error("Unknown sender.");
  const ownPage = extensionPages.has(sender.url ?? "");
  // Content scripts can bind/return their answer and signal automatic completion.
  if (!ownPage) {
    if (message.type === "auto-ready") {
      const state = await read();
      if (!sender.tab?.id || sender.frameId !== 0 || !isExpertUrl(sender.url ?? "") || !state.active?.automatic || state.active.requestId !== message.requestId || state.active.tabId !== sender.tab.id || state.managedTabId !== sender.tab.id) throw new Error("This is not the current automatic question.");
      void automaticTick().catch(notice);
      return null;
    }
    if (message.type === "sending") {
      if (!sender.tab?.id || sender.frameId !== 0 || !isExpertUrl(sender.url ?? "") || typeof message.requestId !== "string") throw new Error("This operation is only available in the extension popup.");
      await markSending(message.requestId, sender.tab.id);
      return null;
    }
    if (message.type === "focus-fill" || message.type === "restore-focus") {
      const state = await read();
      if (!sender.tab?.id || sender.frameId !== 0 || !isExpertUrl(sender.url ?? "") || !state.active?.automatic || state.active.requestId !== message.requestId || state.active.tabId !== sender.tab.id || state.managedTabId !== sender.tab.id) throw new Error("This is not the current automatic question.");
      if (message.type === "focus-fill") {
        // Remember who had focus so it can be handed back; never keep it.
        await takeFocus((await chrome.tabs.get(sender.tab.id)).windowId, false);
      } else await giveBackFocus(false);
      return null;
    }
    if (message.type === "begin") {
      if (!sender.tab?.id || sender.frameId !== 0 || !isExpertUrl(sender.url ?? "") || typeof message.requestId !== "string") throw new Error("This operation is only available in the extension popup.");
      const state = await read();
      if (state.active?.automatic && ((await config()).automatic === false || state.managedTabId !== sender.tab.id)) throw new Error("Automatic mode is off or the managed tab changed. Nothing was filled.");
      if (!attempts.begin(message.requestId, sender.tab.id)) throw new Error("This question is no longer waiting for Expert AI. Click Ask in Expert AI again.");
      return null;
    }
    if (message.type !== "answer" || !sender.tab?.id || sender.frameId !== 0 || !isExpertUrl(sender.url ?? "") || typeof message.requestId !== "string") throw new Error("This operation is only available in the extension popup.");
    const tab = await chrome.tabs.get(sender.tab.id);
    const win = await chrome.windows.get(tab.windowId);
    if (!tab.active || !win.focused) throw new Error("Keep the answer tab visible to send it.");
    return controller.answer(message.answer, message.next === true, { tabId: sender.tab.id, requestId: message.requestId });
  }
  switch (message.type) {
    case "config": return config();
    case "save-config": {
      await controller.settingsChanged(async (state) => {
        const previous = await config();
        const value = validateConfig(message.config);
        if (state.active && (previous.appUrl !== value.appUrl || previous.expertUrl !== value.expertUrl || previous.token !== value.token)) throw new Error("Release the current question before changing pairing settings.");
        await chrome.storage.local.set({ config: value });
        return value.automatic !== false;
      });
      void automaticTick().catch(notice);
      return null;
    }
    case "state": return read();
    case "ping": return (await controllerPortApi()).ping();
    case "queue": return (await controllerPortApi()).queue();
    case "ask": return controller.ask(message.id);
    case "manual": return controller.manual(message.id);
    case "release": return controller.release();
    case "answer": return controller.answer(message.answer, message.next === true);
    case "highlight": return controller.highlight(message.highlight);
    case "copy": return clipboard(message.text);
    default: throw new Error("Unknown extension operation.");
  }
}
async function controllerPortApi() { return new VerifyApi(await config()); }
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target === "clipboard") return false;
  void handle(message, sender).then((data) => respond({ ok: true, data }), (error) => respond({ ok: false, error: errorMessage(error) }));
  return true;
});
async function notice(error: unknown) { await write({ ...await read(), notice: errorMessage(error) }); }
const AUTOMATIC_ALARM = "expert-ai-queue";
async function automaticTick() {
  const settings = await config();
  if (settings.automatic !== false && settings.token) await controller.automaticTick();
}
async function ensureAlarm() {
  if (!(await chrome.alarms.get(AUTOMATIC_ALARM))) await chrome.alarms.create(AUTOMATIC_ALARM, { periodInMinutes: 1 });
}
// Chrome alarms wake sleeping MV3 workers. Recreate after a browser restart;
// a worker-local timer would miss queues as soon as Chrome suspended it.
void ensureAlarm().catch(notice);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTOMATIC_ALARM) void automaticTick().catch(notice);
});
chrome.runtime.onStartup.addListener(() => { void ensureAlarm().then(automaticTick).catch(notice); });
chrome.runtime.onInstalled.addListener(() => {
  void ensureAlarm().then(automaticTick).catch(notice);
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "send-highlight", title: "Send to LearnHarness", contexts: ["selection"], documentUrlPatterns: ["http://*/*", "https://*/*"] });
  });
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "send-highlight") return;
  void controller.highlight({ text: info.selectionText ?? "", url: info.frameUrl ?? info.pageUrl ?? tab?.url ?? "", title: tab?.title }).catch(notice);
});
chrome.commands.onCommand.addListener((command) => {
  if (command === "ask-next") void controller.ask().catch(notice);
});
