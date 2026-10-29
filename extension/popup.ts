import { formatVerifyReference } from "../src/core/contracts/verify";
import type { VerifyReference } from "../src/core/contracts/verify";
import { element, referenceLines, request } from "./ui";
import { errorMessage } from "./types";
import type { ActiveQuestion, Answer, QueueItem, SessionState } from "./types";
let active: ActiveQuestion | undefined;
let busy = false;
let restoredReferences: VerifyReference[] = [];
const value = (id: string) => element<HTMLInputElement | HTMLTextAreaElement>(id).value;
function say(text: string) { element("notice").textContent = text; }
function stateView(state: SessionState, restoreDraft = false) {
  active = state.active;
  element("active").hidden = !active;
  element("phase").textContent = active ? `Status: ${active.phase}. ${active.item.chatTitle}` : "";
  element("prompt").textContent = active?.item.prompt ?? "";
  if (state.notice) say(state.notice);
  if (restoreDraft && state.recovery?.kind === "answer") {
    const { answer } = state.recovery;
    element<HTMLTextAreaElement>("answer").value = answer.text;
    element<HTMLInputElement>("source").value = answer.sourceUrl ?? "";
    restoredReferences = answer.references;
    element<HTMLTextAreaElement>("references").value = answer.references.map(formatVerifyReference).join("\n");
  }
  if (restoreDraft && state.recovery?.kind === "highlight") {
    const { highlight } = state.recovery;
    element<HTMLDetailsElement>("highlight-details").open = true;
    element<HTMLTextAreaElement>("highlight").value = highlight.text;
    element<HTMLInputElement>("highlight-url").value = highlight.url;
    element<HTMLInputElement>("highlight-title").value = highlight.title ?? "";
  }
}
async function refresh() {
  stateView(await request<SessionState>({ type: "state" }));
  await request({ type: "ping" });
  element("connection").textContent = "App paired";
  const items = await request<QueueItem[]>({ type: "queue" });
  const queue = element("queue");
  queue.replaceChildren();
  if (!items.length) queue.textContent = "No questions waiting. Your teacher adds questions here.";
  for (const item of items) {
    const card = document.createElement("article");
    card.dataset.itemId = item.id;
    const title = document.createElement("strong"); title.textContent = `${item.chatTitle} · ${item.status}`;
    const prompt = document.createElement("p"); prompt.textContent = item.prompt; prompt.className = "prompt";
    const ask = document.createElement("button"); ask.textContent = "Ask in Expert AI";
    ask.disabled = Boolean(active && !(active.phase === "manual" && active.item.id === item.id));
    ask.addEventListener("click", () => void run(async () => { await request({ type: "ask", id: item.id }); }));
    const copy = document.createElement("button"); copy.textContent = "Copy prompt / manual return";
    copy.disabled = Boolean(active && active.item.id !== item.id);
    copy.addEventListener("click", () => void run(async () => { await request({ type: "manual", id: item.id }); }));
    card.append(title, prompt, ask, copy); queue.append(card);
  }
}
async function run(action: () => Promise<void>) {
  if (busy) return;
  busy = true;
  document.querySelectorAll<HTMLButtonElement>("button").forEach((b) => { b.disabled = true; });
  let failure: string | undefined;
  try { await action(); } catch (error) { failure = errorMessage(error); }
  try { await refresh(); } catch (error) { element("connection").textContent = "App unavailable or unpaired"; failure ??= errorMessage(error); }
  if (failure) say(failure);
  busy = false;
  // Restore queue-specific disabled states without discarding current draft text.
  document.querySelectorAll<HTMLButtonElement>("button").forEach((b) => { b.disabled = false; });
  element("queue").querySelectorAll<HTMLButtonElement>("button").forEach((b, index) => {
    const card = b.closest("article");
    const itemId = card?.dataset.itemId;
    b.disabled = Boolean(active && (active.item.id !== itemId || (index % 2 === 0 && active.phase !== "manual")));
  });
}
function answer(): Answer {
  return { text: value("answer"), references: referenceLines(value("references"), restoredReferences), ...(value("source").trim() ? { sourceUrl: value("source").trim() } : {}) };
}
async function sendAnswer(next: boolean) {
  if (!element<HTMLFormElement>("answer-form").reportValidity()) return;
  const payload = answer();
  await request({ type: "answer", answer: payload, next });
  element<HTMLFormElement>("answer-form").reset();
}
element("refresh").addEventListener("click", () => void run(async () => {}));
element("settings").addEventListener("click", () => void chrome.runtime.openOptionsPage());
element("copy-prompt").addEventListener("click", () => { if (active) void request({ type: "copy", text: active.item.prompt }).then(() => say("Prompt copied."), (error) => say(errorMessage(error))); });
element("release").addEventListener("click", () => void run(async () => { await request({ type: "release" }); element<HTMLFormElement>("answer-form").reset(); }));
element("answer-form").addEventListener("submit", (event) => { event.preventDefault(); void run(() => sendAnswer(false)); });
element("send-next").addEventListener("click", () => void run(() => sendAnswer(true)));
element("highlight-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void run(async () => {
    await request({ type: "highlight", highlight: { text: value("highlight"), url: value("highlight-url"), title: value("highlight-title") } });
    element<HTMLFormElement>("highlight-form").reset();
  });
});
void (async () => { stateView(await request<SessionState>({ type: "state" }), true); await run(async () => {}); })().catch((error) => say(errorMessage(error)));
