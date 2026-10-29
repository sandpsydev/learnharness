import { VerifyApi } from "./api";
import { DEFAULT_CONFIG, isExpertUrl, validateConfig } from "./config";
import { Attempts } from "./attempts";
import { ExtensionController } from "./controller";
import { errorMessage } from "./types";
import type { ActiveQuestion, Config, QueueItem, Request, SessionState } from "./types";
import type { PageResult } from "./controller";

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
    const reason = "An earlier question was interrupted or the browser restarted. Check Expert AI and return its answer manually, or deliberately release the question. It will not be submitted again.";
    return { ...state, active: { ...attempt, phase: "uncertain", tabId: undefined }, automaticPaused: reason, notice: reason };
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
async function focusExpert(automatic = false) {
  if (automatic) {
    const state = await read();
    if (state.managedTabId !== undefined) {
      let tab: chrome.tabs.Tab | undefined;
      try { tab = await chrome.tabs.get(state.managedTabId); } catch { /* Managed tab was closed. */ }
      if (tab) {
        if (!isExpertUrl(tab.url ?? "")) throw new Error("The managed Expert AI tab is on a sign-in or different page. Sign in there, then retry.");
        return state.managedTabId;
      }
    }
    // Never select a learner-owned conversation or activate/focus this tab.
    const tab = await chrome.tabs.create({ url: (await config()).expertUrl, active: false });
    if (tab.id === undefined) throw new Error("Could not open the background Expert AI tab.");
    await write({ ...state, managedTabId: tab.id });
    return tab.id;
  }
  const current = await chrome.windows.getLastFocused();
  const tabs = await chrome.tabs.query({ url: "https://ai.uptodate.com/*" });
  const existing = tabs.find((tab) => tab.windowId === current.id && tab.active) ?? tabs.find((tab) => tab.windowId === current.id) ?? tabs[0];
  const tab = existing ?? await chrome.tabs.create({ url: (await config()).expertUrl, active: true });
  if (tab.id === undefined) throw new Error("Could not open Expert AI. Copy the prompt instead.");
  const state = await read();
  if (state.managedTabId === tab.id) await write({ ...state, managedTabId: undefined });
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
    const win = automatic ? undefined : await chrome.windows.get(tab.windowId);
    if (!automatic && (!tab.active || !win?.focused)) return { ok: false, submitted: false, untouched: true, error: "Keep the Expert AI tab visible and its window focused, then retry." };
    // A tab that is still opening has no committed URL yet; keep waiting for it.
    if (tab.url && !isExpertUrl(tab.url)) return { ok: false, submitted: false, untouched: true, error: "The tab is not on Expert AI, which can happen at a sign-in screen." };
    try { connected = (await chrome.tabs.sendMessage(tabId, { type: "lh-ready" }, { frameId: 0 }))?.ok === true; } catch { /* Page still loading. */ }
    if (connected) break;
    await delay(400);
  }
  if (!connected) return { ok: false, submitted: false, untouched: true, error: "The Expert AI tab is not ready. If it asks you to sign in, sign in there. Otherwise reload it or use manual paste-back." };
  return await chrome.tabs.sendMessage(tabId, { type: "lh-ask", prompt: item.prompt, requestId, automatic }, { frameId: 0 });
}
const controller = new ExtensionController({ api: async () => new VerifyApi(await config()), read, write, focusExpert, submit, clipboard,
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
