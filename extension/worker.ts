import { VerifyApi } from "./api";
import { DEFAULT_CONFIG, isExpertUrl, validateConfig } from "./config";
import { Attempts } from "./attempts";
import { ExtensionController } from "./controller";
import { errorMessage } from "./types";
import type { Config, QueueItem, Request, SessionState } from "./types";
import type { PageResult } from "./controller";

const ready = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
  chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
]);
async function config(): Promise<Config> {
  await ready;
  return validateConfig({ ...DEFAULT_CONFIG, ...(await chrome.storage.local.get<{ config?: Config }>("config")).config });
}
async function read(): Promise<SessionState> { await ready; return (await chrome.storage.session.get<{ state?: SessionState }>("state")).state ?? {}; }
async function write(state: SessionState) {
  await ready;
  await chrome.storage.session.set({ state });
  await chrome.action.setBadgeText({ text: state.notice ? "•" : "" });
  await chrome.action.setTitle({ title: state.notice ?? "LearnHarness Medical" });
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
async function focusExpert() {
  const current = await chrome.windows.getLastFocused();
  const tabs = await chrome.tabs.query({ url: "https://ai.uptodate.com/*" });
  const existing = tabs.find((tab) => tab.windowId === current.id && tab.active) ?? tabs.find((tab) => tab.windowId === current.id) ?? tabs[0];
  const tab = existing ?? await chrome.tabs.create({ url: (await config()).expertUrl, active: true });
  if (tab.id === undefined) throw new Error("Could not open Expert AI. Copy the prompt instead.");
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
  return tab.id;
}
const attempts = new Attempts();
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function submit(tabId: number, item: QueueItem, requestId: string): Promise<PageResult> {
  // Wait for a newly opened visible tab's content script. Never retry a submit.
  attempts.open(requestId, tabId);
  let connected = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const tab = await chrome.tabs.get(tabId);
    const win = await chrome.windows.get(tab.windowId);
    if (!tab.active || !win.focused) return { ok: false, submitted: false, untouched: true, error: "Keep the Expert AI tab visible and its window focused, then retry." };
    // A tab that is still opening has no committed URL yet; keep waiting for it.
    if (tab.url && !isExpertUrl(tab.url)) return { ok: false, submitted: false, untouched: true, error: "The tab is not on Expert AI, which can happen at a sign-in screen." };
    try { connected = (await chrome.tabs.sendMessage(tabId, { type: "lh-ready" }, { frameId: 0 }))?.ok === true; } catch { /* Page still loading. */ }
    if (connected) break;
    await delay(400);
  }
  if (!connected) return { ok: false, submitted: false, untouched: true, error: "The Expert AI tab is not ready. If it asks you to sign in, sign in there. Otherwise reload it or use manual paste-back." };
  return await chrome.tabs.sendMessage(tabId, { type: "lh-ask", prompt: item.prompt, requestId }, { frameId: 0 });
}
const controller = new ExtensionController({ api: async () => new VerifyApi(await config()), read, write, focusExpert, submit, clipboard, closeAttempt: async (requestId) => attempts.close(requestId) });
const extensionPages = new Set([chrome.runtime.getURL("popup.html"), chrome.runtime.getURL("options.html")]);
async function handle(message: Request, sender: chrome.runtime.MessageSender) {
  if (sender.id !== chrome.runtime.id) throw new Error("Unknown sender.");
  const ownPage = extensionPages.has(sender.url ?? "");
  // Content script has one narrowly scoped operation: return its bound answer.
  if (!ownPage) {
    if (message.type === "begin") {
      if (!sender.tab?.id || sender.frameId !== 0 || !isExpertUrl(sender.url ?? "") || typeof message.requestId !== "string") throw new Error("This operation is only available in the extension popup.");
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
      if ((await read()).active) throw new Error("Release the current question before changing pairing settings.");
      const value = validateConfig(message.config);
      await chrome.storage.local.set({ config: value }); return null;
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
chrome.runtime.onInstalled.addListener(() => {
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
