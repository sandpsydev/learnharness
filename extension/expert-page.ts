/**
 * Expert AI selectors from the owner's 2026-10-29 logged-in page inspection.
 * No live page was opened, fetched, read, or automated by this agent.
 * Completion uses the copy action bar: the best available signal, since no
 * mid-answer capture exists. A timeout/manual fallback remains in content.ts.
 * References are still an explicit placeholder pending a sources-panel capture.
 */
export const EXPERT_PAGE = {
  question: '[data-e2e="desktop-send-input-editor"][contenteditable="true"]',
  initialScreen: '[data-e2e="desktop-initial-screen"]',
  newConversation: 'button[data-e2e="header-new-conversation"]',
  sidebarNewConversation: 'button[data-e2e="new-conversation"]',
  submit: 'button[type="submit"][data-send-button="true"]',
  answer: 'article[data-e2e="expy-chat-assistant-message"]',
  body: '[data-e2e="output-text"] [data-e2e="assistant-output-markdown"]',
  complete: '[data-e2e="assistant-message-action-bar"] [data-e2e="expy-chat-clipboard-button"]',
  access: '.ec-signout-modal, .ec-unauthorized-modal, .ec-disclaimer-modal, .ec-drug-dosing-agreement-modal, .ec-welcome-modal',
} as const;

export const ACCESS_HELP = "Sign in to Expert AI and use the university network, then retry. If the page layout differs, copy the prompt and use manual paste-back. The question stays queued.";

function shown(element: Element | null): element is HTMLElement {
  if (!element || !element.isConnected) return false;
  const view = element.ownerDocument.defaultView;
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true") return false;
    if (view?.getComputedStyle) {
      const style = view.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    }
  }
  if (view?.getComputedStyle && element.getClientRects().length === 0) return false;
  return true;
}
function enabled(element: Element | null): element is HTMLElement {
  return shown(element) && !element.hasAttribute("disabled") && element.getAttribute("aria-disabled") !== "true";
}
export function requireVisible(doc: Document) {
  if (doc.visibilityState !== "visible" || !doc.hasFocus()) throw new Error("Keep the Expert AI tab visible and its window focused, then retry.");
}
export function questionBox(doc: Document): HTMLElement {
  if ([...doc.querySelectorAll(EXPERT_PAGE.access)].some(shown)) throw new Error(ACCESS_HELP);
  const box = [...doc.querySelectorAll<HTMLElement>(EXPERT_PAGE.question)].find(enabled);
  if (!box) throw new Error(ACCESS_HELP);
  return box;
}
function submitFor(box: HTMLElement): Element | null {
  // Desktop and mobile have separate forms; never send through the hidden copy.
  return box.closest("form")?.querySelector(EXPERT_PAGE.submit) ?? null;
}
export function startConversation(doc: Document) {
  requireVisible(doc);
  const box = questionBox(doc);
  const fresh = [...doc.querySelectorAll(EXPERT_PAGE.newConversation)].find(enabled)
    ?? [...doc.querySelectorAll(EXPERT_PAGE.sidebarNewConversation)].find(enabled);
  if (!fresh || !shown(submitFor(box))) {
    throw new Error("Expert AI page controls are unavailable. Use Copy prompt and manual paste-back.");
  }
  fresh.click();
}
export function fillQuestion(doc: Document, prompt: string) {
  requireVisible(doc);
  const box = questionBox(doc);
  if (!conversationIsFresh(doc)) throw new Error("Wait for an empty new conversation before filling the prompt. Use manual paste-back if needed.");
  box.focus();
  // Use the editor's native editing path so its internal state sees the change.
  const selection = doc.getSelection?.();
  if (selection && doc.execCommand) {
    const range = doc.createRange();
    range.selectNodeContents(box);
    selection.removeAllRanges();
    selection.addRange(range);
    if (doc.execCommand("insertText", false, prompt)) return;
  }
  box.textContent = prompt;
  const InputEventClass = doc.defaultView?.InputEvent ?? InputEvent;
  box.dispatchEvent(new InputEventClass("input", { bubbles: true, inputType: "insertText", data: prompt }));
}
export function submitQuestion(doc: Document) {
  requireVisible(doc);
  const submit = submitFor(questionBox(doc));
  if (!enabled(submit)) throw new Error("Expert AI submit control is unavailable. Copy the prompt and paste it manually.");
  submit.click();
}
export function answerContainer(doc: Document): HTMLElement | null {
  // Never fall back to an older completed answer while the last one streams.
  const last = [...doc.querySelectorAll<HTMLElement>(EXPERT_PAGE.answer)].at(-1);
  return shown(last ?? null) && shown(last!.querySelector(EXPERT_PAGE.complete)) ? last! : null;
}
export function readAnswer(container: HTMLElement, sourceUrl: string) {
  const body = container.querySelector<HTMLElement>(EXPERT_PAGE.body)?.cloneNode(true) as HTMLElement | undefined;
  if (!body) throw new Error("No completed answer was found. Use manual paste-back.");
  body.querySelectorAll('[data-e2e="nudge"], .nudge-container, button[data-id="inlineSources"]').forEach((node) => node.remove());
  // Thinking, disclaimer and action controls are outside the markdown body.
  // Preserve citation IDs in plain text until the sources panel can be mapped.
  body.querySelectorAll('[data-citation-ids]').forEach((node) => {
    const ids = node.getAttribute("data-citation-ids");
    if (ids) node.append(` [sources: ${ids}]`);
  });
  body.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, tr, br, hr").forEach((node) => node.append("\n"));
  const text = (body.textContent ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) throw new Error("No completed answer was found. Use manual paste-back.");
  // PLACEHOLDER: sources-panel structure has not been inspected. Do not guess
  // reference URLs from inline source pills or unrelated page links.
  const references: Array<{ title?: string; url: string }> = [];
  return { text, references, sourceUrl };
}
export function conversationIsFresh(doc: Document): boolean {
  // The composer can be absent briefly while the new screen mounts.
  if (![...doc.querySelectorAll(EXPERT_PAGE.question)].some(enabled)) return false;
  const box = questionBox(doc);
  return shown(box.closest(EXPERT_PAGE.initialScreen)) && box.getAttribute("data-empty") === "true" && !(box.textContent ?? "").trim();
}
export function canSubmit(doc: Document): boolean { return enabled(submitFor(questionBox(doc))); }
