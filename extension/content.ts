import { answerContainer, canSubmit, conversationIsFresh, fillQuestion, readAnswerWithSources, requireVisible, startConversation, submitQuestion } from "./expert-page";
import { errorMessage } from "./types";
import type { Reply } from "./types";

let pending: { requestId: string; prompt: string } | undefined;
let running = false;
let returning = false;
let controls: HTMLElement | undefined;
let answerNode: HTMLElement | undefined;
let completionTimer: ReturnType<typeof setTimeout> | undefined;
const seen = new Set<string>();
const observer = new MutationObserver(() => attachControls());
function reset() { clearTimeout(completionTimer); completionTimer = undefined; observer.disconnect(); controls?.remove(); controls = undefined; answerNode = undefined; pending = undefined; }
function attachControls() {
  if (!pending || document.visibilityState !== "visible") return;
  const answer = answerContainer(document);
  if (!answer || (answer === answerNode && controls?.isConnected)) return;
  clearTimeout(completionTimer); completionTimer = undefined;
  controls?.remove();
  answerNode = answer;
  controls = document.createElement("aside");
  controls.setAttribute("aria-label", "LearnHarness answer actions");
  controls.style.cssText = "padding:12px;margin:8px 0;border:1px solid #888;border-radius:8px;background:Canvas;color:CanvasText;font:14px system-ui";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.textContent = "Read the completed answer before sending it to LearnHarness.";
  const makeButton = (label: string, next: boolean) => {
    const button = document.createElement("button");
    button.textContent = label;
    button.style.cssText = "padding:8px;margin-right:8px;cursor:pointer";
    button.addEventListener("click", (event) => {
      // Page-generated clicks must never send evidence or chain another query.
      if (!event.isTrusted || returning || !pending) return;
      const binding = pending;
      const send = async () => {
        requireVisible(document);
        const current = answerContainer(document);
        if (!current || current !== answer) throw new Error("The answer changed. Read it again before sending.");
        returning = true;
        controls?.querySelectorAll("button").forEach((b) => { b.disabled = true; });
        status.textContent = "Reading sources…";
        const payload = await readAnswerWithSources(current, location.href);
        status.textContent = "Sending…";
        const reply: Reply = await chrome.runtime.sendMessage({ type: "answer", answer: payload, next, requestId: binding.requestId });
        if (!reply.ok) throw new Error(reply.error);
        // A chained request may already have installed a new binding.
        if (pending?.requestId === binding.requestId) reset();
      };
      void send().catch((error) => { status.textContent = `${errorMessage(error)} Answer retained in the extension; retry or use manual paste-back.`; }).finally(() => {
        returning = false;
        controls?.querySelectorAll("button").forEach((b) => { b.disabled = false; });
      });
    });
    return button;
  };
  controls.append(makeButton("Send to LearnHarness", false), makeButton("Send & ask next", true), status);
  answer.after(controls);
}
async function waitUntil(check: () => boolean, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    requireVisible(document);
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Expert AI did not show the expected fresh conversation or submit control. Use manual paste-back.");
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message?.type === "lh-ready") { respond({ ok: true }); return false; }
  if (message?.type !== "lh-ask") return false;
  if (running || seen.has(message.requestId) || typeof message.prompt !== "string" || typeof message.requestId !== "string") {
    respond({ ok: false, submitted: true, error: "A question is already running. Check the visible tab before retrying." }); return false;
  }
  running = true;
  seen.add(message.requestId);
  let submitted = false;
  let filling = false;
  void (async () => {
    requireVisible(document);
    reset();
    startConversation(document);
    await waitUntil(() => conversationIsFresh(document));
    // Ask the extension before writing anything. Without its yes, nothing is filled,
    // and the extension can tell that this tab never started.
    const granted: Reply | undefined = await chrome.runtime.sendMessage({ type: "begin", requestId: message.requestId });
    if (!granted?.ok) throw new Error("The extension is no longer waiting for this tab. Click Ask in Expert AI again.");
    filling = true;
    fillQuestion(document, message.prompt);
    await waitUntil(() => canSubmit(document));
    submitted = true; // A thrown click/closed port must not trigger an automatic retry.
    submitQuestion(document);
    pending = { requestId: message.requestId, prompt: message.prompt };
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    attachControls();
    if (!answerNode) completionTimer = setTimeout(() => {
      // The copy action bar is only the best available completion signal.
      // Never resubmit on timeout; leave the learner a manual return path.
      if (!pending || answerNode) return;
      controls = document.createElement("aside");
      controls.setAttribute("role", "alert");
      controls.textContent = "Expert AI completion was not detected within two minutes. Read the answer in this tab, then use manual paste-back in the LearnHarness toolbar. Do not submit the question again.";
      document.body.prepend(controls);
    }, 120_000);
    respond({ ok: true, submitted: true });
  })().catch((error) => {
    const message = errorMessage(error);
    controls = document.createElement("aside");
    controls.setAttribute("role", "alert");
    controls.style.cssText = "padding:12px;border:2px solid #888;background:Canvas;color:CanvasText;font:14px system-ui";
    controls.textContent = `${message} Open the LearnHarness toolbar for Copy prompt and manual paste-back.`;
    document.body.prepend(controls);
    respond({ ok: false, submitted, untouched: !filling, error: message });
  }).finally(() => { running = false; });
  return true;
});
document.addEventListener("visibilitychange", attachControls);
