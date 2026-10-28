/**
 * UNVERIFIED EXPERT AI PAGE ADAPTER — owner inspection is still required.
 * Based ONLY on docs/medical-spec.md's written screenshot description,
 * 2026-10-29. No live page was opened, fetched, read, or automated.
 * ALL site-specific selectors, labels, access detection and extraction live
 * here. Reserved data-lh-* attributes are deliberately non-live placeholders:
 * until the owner replaces them, automatic submission fails closed and the
 * clipboard/manual return path is available. The local fixture uses them.
 */
export const UNVERIFIED_PAGE = {
  // NOT VERIFIED: question box's described placeholder, native textarea assumed.
  question: 'textarea[placeholder="Ask a medical question…"]',
  // NOT VERIFIED: exact accessible label described in the spec.
  newConversation: 'button[aria-label="New conversation"]',
  // NOT VERIFIED: submit arrow's real selector/accessible name is unknown.
  submit: 'button[data-lh-expert-submit]',
  // NOT VERIFIED: no answer DOM or completion signal is described in the spec.
  answer: '[data-lh-expert-answer][data-lh-answer-complete="true"]',
  // NOT VERIFIED: actual reference DOM is unknown; scope strictly to the answer.
  references: 'a[data-lh-expert-reference]',
  // NOT VERIFIED: explicit access marker is unknown. Missing question box also stops.
  access: '[data-lh-expert-access-required]',
} as const;

export const ACCESS_HELP = "Sign in to Expert AI and use the university network, then retry. If the page layout differs, copy the prompt and use manual paste-back. The question stays queued.";

function shown(element: Element | null): element is HTMLElement {
  if (!element || !element.isConnected || element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") return false;
  const view = element.ownerDocument.defaultView;
  if (view?.getComputedStyle) {
    const style = view.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (element.getClientRects().length === 0) return false;
  }
  return true;
}
function enabled(element: Element | null): element is HTMLElement {
  return shown(element) && !element.hasAttribute("disabled") && element.getAttribute("aria-disabled") !== "true";
}
export function requireVisible(doc: Document) {
  if (doc.visibilityState !== "visible" || !doc.hasFocus()) throw new Error("Keep the Expert AI tab visible and its window focused, then retry.");
}
export function questionBox(doc: Document): HTMLTextAreaElement {
  if (shown(doc.querySelector(UNVERIFIED_PAGE.access))) throw new Error(ACCESS_HELP);
  const box = doc.querySelector<HTMLTextAreaElement>(UNVERIFIED_PAGE.question);
  if (!enabled(box)) throw new Error(ACCESS_HELP);
  return box as HTMLTextAreaElement;
}
export function startConversation(doc: Document) {
  requireVisible(doc);
  questionBox(doc); // Access check before clicking anything.
  const fresh = doc.querySelector(UNVERIFIED_PAGE.newConversation);
  // Check the reserved submit placeholder BEFORE changing the conversation.
  if (!enabled(fresh) || !doc.querySelector(UNVERIFIED_PAGE.submit)) {
    throw new Error("Expert AI page controls are not verified yet. Use Copy prompt and manual paste-back.");
  }
  fresh.click();
}
export function fillQuestion(doc: Document, prompt: string) {
  requireVisible(doc);
  const box = questionBox(doc);
  box.focus();
  const setter = doc.defaultView?.HTMLTextAreaElement && Object.getOwnPropertyDescriptor(doc.defaultView.HTMLTextAreaElement.prototype, "value")?.set;
  if (setter) setter.call(box, prompt); else box.value = prompt;
  const EventClass = doc.defaultView?.Event ?? Event;
  box.dispatchEvent(new EventClass("input", { bubbles: true }));
  box.dispatchEvent(new EventClass("change", { bubbles: true }));
}
export function submitQuestion(doc: Document) {
  requireVisible(doc);
  questionBox(doc);
  const submit = doc.querySelector(UNVERIFIED_PAGE.submit);
  if (!enabled(submit)) throw new Error("Expert AI submit control is unavailable. Copy the prompt and paste it manually.");
  submit.click();
}
export function answerContainer(doc: Document): HTMLElement | null {
  const answers = [...doc.querySelectorAll<HTMLElement>(UNVERIFIED_PAGE.answer)].filter(shown);
  return answers.at(-1) ?? null;
}
export function readAnswer(container: HTMLElement, sourceUrl: string) {
  const text = (container.innerText ?? container.textContent ?? "").trim();
  if (!text) throw new Error("No completed answer was found. Use manual paste-back.");
  const references: Array<{ title?: string; url: string }> = [];
  for (const link of container.querySelectorAll<HTMLAnchorElement>(UNVERIFIED_PAGE.references)) {
    let url: URL;
    try { url = new URL(link.getAttribute("href") ?? "", sourceUrl); } catch { continue; }
    if (!["http:", "https:"].includes(url.protocol) || references.some((ref) => ref.url === url.href)) continue;
    references.push({ url: url.href, title: link.textContent?.trim() || undefined });
  }
  return { text, references, sourceUrl };
}
/** NOT VERIFIED: a fresh conversation is assumed to have an empty box and
 * no completed answer. Owner inspection must confirm both signals. */
export function conversationIsFresh(doc: Document): boolean {
  return questionBox(doc).value === "" && answerContainer(doc) === null;
}
export function canSubmit(doc: Document): boolean { return enabled(doc.querySelector(UNVERIFIED_PAGE.submit)); }
