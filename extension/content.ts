import { FocusNeededError, HIDDEN_HELP, LOADING_HELP, SignedOutError, answerContainer, canSubmit, clearDraft, conversationIsFresh, fillQuestion, promptEvidence, readAnswerWithSources, requireVisible, questionBox, startConversation, startScreen, submitQuestion } from "./expert-page";
import { errorMessage } from "./types";
import type { Reply } from "./types";

let pending: { requestId: string; prompt: string; automatic: boolean } | undefined;
let running = false;
let returning = false;
let controls: HTMLElement | undefined;
let answerNode: HTMLElement | undefined;
let completionTimer: ReturnType<typeof setTimeout> | undefined;
const seen = new Set<string>();
const observer = new MutationObserver(() => attachControls());
function reset() { clearTimeout(completionTimer); completionTimer = undefined; observer.disconnect(); controls?.remove(); controls = undefined; answerNode = undefined; pending = undefined; }
function attachControls() {
  if (!pending || (!pending.automatic && document.visibilityState !== "visible")) return;
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
  status.textContent = pending.automatic ? "Completed answer ready for automatic return." : "Read the completed answer before sending it to LearnHarness.";
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
  if (pending.automatic) {
    // Wake the worker; it collects under the same lock as all manual actions.
    void chrome.runtime.sendMessage({ type: "auto-ready", requestId: pending.requestId }).catch(() => {});
  }
}
async function waitUntil(check: () => boolean, ms = 10_000, automatic = false, failure = () => "Expert AI did not show the expected fresh conversation or submit control. Use manual paste-back.") {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!automatic) requireVisible(document);
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(failure());
}
/**
 * The editor takes text only while its document has focus, and the managed window is opened
 * unfocused so it never takes over the learner's screen. If the plain fill is ignored for that
 * reason, borrow focus for the fill alone and give it straight back. The worker checks that this
 * is the managed automatic question and puts focus back on the window the learner was using.
 */
async function fillWithBorrowedFocus(requestId: string, prompt: string) {
  const granted: Reply | undefined = await chrome.runtime.sendMessage({ type: "focus-fill", requestId });
  if (!granted?.ok) throw new Error("Step failed: inserting the question text. The composer ignored it because this window is not focused, and focus could not be borrowed for the fill.");
  try {
    await waitUntil(() => document.hasFocus(), 3_000, true, () => "Step failed: inserting the question text. This window did not take focus for the fill.");
    fillQuestion(document, prompt, true);
  } finally {
    await chrome.runtime.sendMessage({ type: "restore-focus", requestId }).catch(() => {});
  }
}
/** Expert AI only enables Send in a visible page. Give a just-opened window a moment, then stop without touching anything. */
async function waitUntilVisible(ms = 10_000) {
  const deadline = Date.now() + ms;
  while (document.visibilityState !== "visible") {
    if (Date.now() >= deadline) throw new Error(HIDDEN_HELP);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
/**
 * A page that was just opened (or is redirecting) may not show its composer yet. Wait, bounded,
 * for the real start screen rather than failing on a half-loaded page. A page that stays on a
 * sign-in screen is reported as such; a pop-up or access notice is left to questionBox to name.
 */
async function waitForStartScreen(ms = 30_000) {
  const start = Date.now();
  let signedOutSince: number | undefined;
  while (Date.now() - start < ms) {
    const screen = startScreen(document);
    if (screen === "ready" || screen === "blocked") return;
    if (screen === "signed-out") {
      // Sign-in links can show for a moment while the page is still starting.
      signedOutSince ??= Date.now();
      if (Date.now() - signedOutSince >= 3_000) throw new SignedOutError();
    } else signedOutSince = undefined;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (document.readyState && document.readyState !== "complete") throw new Error(LOADING_HELP);
}
/** Bind an already-sent automatic question found on the page, so its answer can be collected. */
function adopt(requestId: string, prompt: string) {
  if (pending?.requestId === requestId) return;
  reset();
  pending = { requestId, prompt, automatic: true };
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
  attachControls();
}
function install() { chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message?.type === "lh-ready") { respond({ ok: true, visible: document.visibilityState === "visible" }); return false; }
  if (message?.type === "lh-probe") {
    // The worker may inject this script into a tab it did not load with. Report what the
    // page shows; an already-sent prompt is adopted so its answer can be collected.
    if (running || typeof message.prompt !== "string" || typeof message.requestId !== "string") { respond({ ok: true, verdict: "busy", why: "The page is still working on this question." }); return false; }
    try {
      const evidence = promptEvidence(document, message.prompt);
      if (evidence.verdict === "sent") adopt(message.requestId, message.prompt);
      if (evidence.verdict === "not-sent") clearDraft(document);
      respond({ ok: true, ...evidence });
    } catch (error) { respond({ ok: false, error: errorMessage(error) }); }
    return false;
  }
  if (message?.type === "lh-returned") {
    if (pending?.requestId === message.requestId) reset();
    respond({ ok: true });
    return false;
  }
  if (message?.type === "lh-collect") {
    if (!pending?.automatic || pending.requestId !== message.requestId || running || returning) {
      respond({ ok: false, error: "The automatic question binding was lost or is busy. Check the tab and use manual return; do not resubmit." });
      return false;
    }
    returning = true;
    void (async () => {
      questionBox(document); // Pause for sign-in/pop-ups even while awaiting completion.
      const current = answerContainer(document);
      if (!current) return { ok: true };
      const answer = await readAnswerWithSources(current, location.href, true);
      return { ok: true, answer };
    })().then(respond, (error) => respond({ ok: false, error: errorMessage(error) })).finally(() => {
      returning = false;
      // Keep the binding for safe collection retry if local API delivery fails.
    });
    return true;
  }
  if (message?.type !== "lh-ask") return false;
  if (running || seen.has(message.requestId) || typeof message.prompt !== "string" || typeof message.requestId !== "string") {
    respond({ ok: false, submitted: true, error: "A question is already running. Check the visible tab before retrying." }); return false;
  }
  const automatic = message.automatic === true;
  running = true;
  seen.add(message.requestId);
  let submitted = false;
  let filling = false;
  void (async () => {
    if (!automatic) requireVisible(document);
    else await waitUntilVisible();
    reset();
    if (automatic) await waitForStartScreen();
    startConversation(document, automatic);
    await waitUntil(() => conversationIsFresh(document), 10_000, automatic, () => "Step failed: starting a new conversation. Expert AI did not show an empty start screen within 10 seconds. Use manual paste-back.");
    // Ask the extension before writing anything. Without its yes, nothing is filled,
    // and the extension can tell that this tab never started.
    const granted: Reply | undefined = await chrome.runtime.sendMessage({ type: "begin", requestId: message.requestId });
    if (!granted?.ok) throw new Error("The extension is no longer waiting for this tab. Click Ask in Expert AI again.");
    filling = true;
    try { fillQuestion(document, message.prompt, automatic); }
    catch (error) {
      if (!automatic || !(error instanceof FocusNeededError)) throw error;
      await fillWithBorrowedFocus(message.requestId, message.prompt);
    }
    await waitUntil(() => canSubmit(document), 10_000, automatic, () => `Step failed: enabling Send. Send stayed disabled ten seconds after the text was inserted (the composer holds ${(questionBox(document).textContent ?? "").trim().length} characters).`);
    // Record durably that Send is about to be pressed, and press it only if that was accepted.
    // Without this record the extension can prove, after any interruption, that nothing was sent.
    const marked: Reply | undefined = await chrome.runtime.sendMessage({ type: "sending", requestId: message.requestId });
    if (!marked?.ok) throw new Error("The extension is no longer waiting for this tab, so Send was not pressed.");
    submitted = true; // A thrown click/closed port must not trigger an automatic retry.
    submitQuestion(document, automatic);
    pending = { requestId: message.requestId, prompt: message.prompt, automatic };
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
    // Nothing was clicked (`submitted` is set only just before the click), so a filled
    // draft is only text in the composer. In the managed tab, remove it so a later attempt
    // starts clean; a learner's own tab keeps it for them to finish by hand.
    if (automatic && filling && !submitted) { try { clearDraft(document); } catch { /* Best effort. */ } }
    // A page that went hidden explains every later failure; do not blame sign-in or the layout.
    const hidden = automatic && document.visibilityState !== "visible";
    const message = hidden ? HIDDEN_HELP : errorMessage(error);
    controls = document.createElement("aside");
    controls.setAttribute("role", "alert");
    controls.style.cssText = "padding:12px;border:2px solid #888;background:Canvas;color:CanvasText;font:14px system-ui";
    controls.textContent = `${message} Open the LearnHarness toolbar for Copy prompt and manual paste-back.`;
    document.body.prepend(controls);
    respond({ ok: false, submitted, untouched: !filling, error: message, ...(hidden ? { hidden: true } : {}), ...(error instanceof SignedOutError ? { signedOut: true } : {}) });
  }).finally(() => { running = false; });
  return true;
}); document.addEventListener("visibilitychange", attachControls); }
// Injecting the script again (to inspect a tab loaded before the extension) must not add a second handler.
const once = globalThis as { __lhMedicalContent?: boolean };
if (!once.__lhMedicalContent) { once.__lhMedicalContent = true; install(); }
