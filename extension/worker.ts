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
  if (!state.active) await chrome.storage.local.set({ attempt: null });
  await chrome.action.setBadgeText({ text: state.automaticPaused ? "!" : state.notice ? "•" : "" });
  await chrome.action.setTitle({ title: state.automaticPaused ? `Automatic Expert AI paused: ${state.automaticPaused}` : state.notice ?? "LearnHarness Medical" });
}
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
      if (!isExpertUrl(tab.url ?? "")) throw new Error("The managed Expert AI tab is on a sign-in or different page. Sign in there, then retry.");
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
async function submit(tabId: number, item: QueueItem, requestId: string, automatic = false): Promise<PageResult> {
  // Wait for the tab's content script. Never retry a submit.
  attempts.open(requestId, tabId);
  let connected = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const tab = await chrome.tabs.get(tabId);
    const win = await chrome.windows.get(tab.windowId);
    // Expert AI will not enable Send in a hidden page. Say so rather than blaming the sign-in.
    if (automatic && win.state === "minimized") return { ok: false, submitted: false, untouched: true, hidden: true, error: HIDDEN_HELP };
    if (!automatic && (!tab.active || !win.focused)) return { ok: false, submitted: false, untouched: true, error: "Keep the Expert AI tab visible and its window focused, then retry." };
    // A tab that is still opening has no committed URL yet; keep waiting for it.
    if (tab.url && !isExpertUrl(tab.url)) return { ok: false, submitted: false, untouched: true, error: "The tab is not on Expert AI, which can happen at a sign-in screen." };
    try { connected = (await chrome.tabs.sendMessage(tabId, { type: "lh-ready" }, { frameId: 0 }))?.ok === true; } catch { /* Page still loading. */ }
    if (connected) break;
    await delay(400);
  }
  if (!connected) return { ok: false, submitted: false, untouched: true, error: "The Expert AI tab is not ready. If it asks you to sign in, sign in there. Otherwise reload it or use manual paste-back." };
  return await chrome.tabs.sendMessage(tabId, { type: "lh-ask", prompt: item.prompt, requestId, automatic }, { frameId: 0 });
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
const controller = new ExtensionController({ probe, api: async () => new VerifyApi(await config()), read, write, focusExpert, submit, clipboard,
  completed: async (active) => {
    if (active.tabId !== undefined) await chrome.tabs.sendMessage(active.tabId, { type: "lh-returned", requestId: active.requestId }, { frameId: 0 });
  },
  collect: async (active) => {
    if (active.tabId === undefined || (await read()).managedTabId !== active.tabId) throw new Error("The automatic question has no managed tab. Use manual return.");
    const tab = await chrome.tabs.get(active.tabId);
    if (!isExpertUrl(tab.url ?? "")) throw new Error("Sign in to Expert AI in its managed tab, then retry. The extension never signs in.");
    const reply = await chrome.tabs.sendMessage(active.tabId, { type: "lh-collect", requestId: active.requestId }, { frameId: 0 });
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
