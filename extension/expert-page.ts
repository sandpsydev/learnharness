import { extractCitationIds } from "../src/core/contracts/verify";
import type { VerifyReference } from "../src/core/contracts/verify";

/**
 * Expert AI selectors from the owner's 2026-10-29 logged-in page inspection.
 * No live page was opened, fetched, read, or automated by this agent.
 * Completion uses the copy action bar: the best available signal, since no
 * mid-answer capture exists. A timeout/manual fallback remains in content.ts.
 * Sources come from the owner-inspected drawer. Inline citation IDs have no
 * verified mapping to drawer cards, so only source titles/sections are sent.
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
  sourcesButton: '[data-e2e="assistant-message-action-bar"] button[class*="sources-button_"]',
  drawer: '[data-e2e="fab-expy-sources-drawer"]',
  sourceCards: '[data-e2e="drawer-content"] ul[data-e2e="fab-expy-sources-list"] li button[data-e2e="fab-expy-source-card-button"]',
  drawerClose: 'button[data-e2e="drawer-close-btn"]',
  access: '.ec-signout-modal, .ec-unauthorized-modal',
  popup: '.ec-disclaimer-modal, .ec-drug-dosing-agreement-modal, .ec-welcome-modal',
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
  if ([...doc.querySelectorAll(EXPERT_PAGE.popup)].some(shown)) throw new Error("Close the Expert AI pop-up, then retry.");
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
  const mode = box.closest("form")?.querySelector('[data-e2e="output-mode-menu-trigger"]');
  if (!shown(mode ?? null) || mode?.textContent?.replace(/\s+/g, " ").trim() !== "Standard") {
    throw new Error("Switch Expert AI to Standard, then retry.");
  }
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
  if (!last || !shown(last)) return null;
  return shown(last.querySelector(EXPERT_PAGE.complete)) ? last : null;
}
export function readAnswer(container: HTMLElement, sourceUrl: string) {
  const body = container.querySelector<HTMLElement>(EXPERT_PAGE.body)?.cloneNode(true) as HTMLElement | undefined;
  if (!body) throw new Error("No completed answer was found. Use manual paste-back.");
  body.querySelectorAll('[data-e2e="nudge"], .nudge-container, button[data-id="inlineSources"]').forEach((node) => node.remove());
  // Thinking, disclaimer and action controls are outside the markdown body.
  // Inline citation IDs are not mapped to drawer cards; send the source list
  // separately rather than adding uninterpretable numbers to the answer.
  body.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, tr, br, hr").forEach((node) => node.append("\n"));
  const text = (body.textContent ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) throw new Error("No completed answer was found. Use manual paste-back.");
  const references: VerifyReference[] = [];
  return { text, references, sourceUrl };
}
export function conversationIsFresh(doc: Document): boolean {
  // The composer can be absent briefly while the new screen mounts.
  if (![...doc.querySelectorAll(EXPERT_PAGE.question)].some(enabled)) return false;
  const box = questionBox(doc);
  return shown(box.closest(EXPERT_PAGE.initialScreen)) && box.getAttribute("data-empty") === "true" && !(box.textContent ?? "").trim();
}
export function canSubmit(doc: Document): boolean { return enabled(submitFor(questionBox(doc))); }

function visibleDrawer(doc: Document): HTMLElement | undefined {
  return [...doc.querySelectorAll<HTMLElement>(EXPERT_PAGE.drawer)].find(shown);
}
async function waitForPage<T>(doc: Document, check: () => T | undefined, timeout = 10_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    requireVisible(doc);
    const value = check();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Expert AI sources drawer did not respond. Use manual paste-back for the answer and sources.");
}
function drawerReferences(drawer: HTMLElement, sourceUrl: string): VerifyReference[] {
  return [...drawer.querySelectorAll<HTMLElement>(EXPERT_PAGE.sourceCards)].map((card) => {
    const title = card.querySelector('[class*="source-text-line--topic-ti"]')?.textContent?.trim()
      || card.getAttribute("aria-label")?.replace(/^View source:\s*/i, "").trim();
    if (!title) throw new Error("Expert AI source title was unavailable. Use manual paste-back.");
    const section = card.querySelector('[class*="source-text-line--section-"]')?.textContent?.trim();
    const pill = card.querySelector('[class*="source-pill--"]');
    const type = pill?.className.match(/source-pill--([a-z-]+)/i)?.[1];
    const href = card.getAttribute("href") ?? card.querySelector("a[href]")?.getAttribute("href");
    let url: string | undefined;
    if (href) {
      try { const parsed = new URL(href, sourceUrl); if (["http:", "https:"].includes(parsed.protocol)) url = parsed.href; } catch { /* Keep the title, never invent a link. */ }
    }
    const ids = extractCitationIds(card.textContent ?? "", card.getAttribute("aria-label") ?? "", url ?? "", card.getAttribute("data-doi") ?? "", card.getAttribute("data-pmid") ? `PMID ${card.getAttribute("data-pmid")}` : "");
    return { title, ...(section ? { section } : {}), ...(type ? { type } : {}), ...(url ? { url } : {}), ...(ids.pmids[0] ? { pmid: ids.pmids[0] } : {}), ...(ids.dois[0] ? { doi: ids.dois[0] } : {}) };
  });
}
/** Called only within the learner's own Send click. Read cards without opening
 * individual sources, then restore whether the drawer was open or closed. */
export async function readAnswerWithSources(container: HTMLElement, sourceUrl: string) {
  const doc = container.ownerDocument;
  requireVisible(doc);
  questionBox(doc); // Access/pop-up check before opening the drawer.
  const button = container.querySelector(EXPERT_PAGE.sourcesButton);
  if (!enabled(button)) throw new Error("Expert AI sources control was unavailable. Use manual paste-back.");
  const wasOpen = Boolean(visibleDrawer(doc));
  if (wasOpen && button.getAttribute("aria-pressed") !== "true") {
    throw new Error("Close the other answer's sources drawer, then retry sending this answer.");
  }
  let opened = false;
  try {
    if (!wasOpen) { opened = true; button.click(); }
    const drawer = await waitForPage(doc, () => {
      const current = visibleDrawer(doc);
      return button.getAttribute("aria-pressed") === "true" && current?.querySelector(EXPERT_PAGE.sourceCards) ? current : undefined;
    });
    const references = drawerReferences(drawer, sourceUrl);
    if ([...doc.querySelectorAll(EXPERT_PAGE.answer)].at(-1) !== container || !container.isConnected) throw new Error("The answer changed. Read it again before sending.");
    return { ...readAnswer(container, sourceUrl), references };
  } finally {
    if (opened) {
      const close = visibleDrawer(doc)?.querySelector(EXPERT_PAGE.drawerClose);
      if (visibleDrawer(doc) && !close) throw new Error("Close the sources drawer and retry sending the answer.");
      if (close) {
        requireVisible(doc);
        if (!enabled(close)) throw new Error("Close the sources drawer and retry sending the answer.");
        close.click();
        await waitForPage(doc, () => visibleDrawer(doc) ? undefined : true);
      }
    }
  }
}
