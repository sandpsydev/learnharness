import { VerifyApi } from "./api";
import { httpUrl } from "./config";
import { VERIFY_LIMITS, cleanVerifyReferences, formatVerifyReference } from "../src/core/contracts/verify";
import { errorMessage } from "./types";
import type { ActiveQuestion, Answer, Highlight, QueueItem, SessionState } from "./types";

/** `untouched` means it is certain nothing was filled or submitted. */
export interface PageResult { ok: boolean; submitted: boolean; untouched?: boolean; error?: string }
export interface ControllerPorts {
  api(): Promise<VerifyApi>;
  read(): Promise<SessionState>;
  write(state: SessionState): Promise<void>;
  focusExpert(): Promise<number>;
  submit(tabId: number, item: QueueItem, requestId: string): Promise<PageResult>;
  clipboard(text: string): Promise<void>;
  /** True only when the page provably never began filling this request. */
  closeAttempt(requestId: string): Promise<boolean>;
}
function validateAnswer(answer: Answer) {
  if (!answer || typeof answer.text !== "string" || !answer.text.trim() || answer.text.length > VERIFY_LIMITS.answerChars) {
    throw new Error("Paste an answer of 1–60,000 characters.");
  }
  if (!Array.isArray(answer.references) || answer.references.length > VERIFY_LIMITS.maxReferences ||
      !cleanVerifyReferences(answer.references) ||
      (answer.sourceUrl !== undefined && !httpUrl(answer.sourceUrl))) throw new Error("Use sources with a title or HTTP/HTTPS URL (at most 100).");
}
export function validateHighlight(highlight: Highlight) {
  if (!highlight || typeof highlight.text !== "string" || !highlight.text.trim() || highlight.text.length > VERIFY_LIMITS.highlightChars) throw new Error("Select or paste 1–20,000 characters.");
  if (!httpUrl(highlight.url)) throw new Error("Use the original HTTP or HTTPS page/PDF URL. Paste it in the extension for local files or restricted viewers.");
}

/** All mutations share a lock. An active question also survives MV3 worker sleep. */
export class ExtensionController {
  private busy = false;
  constructor(private ports: ControllerPorts) {}
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("One action is already in progress. Wait for it to finish.");
    this.busy = true;
    try { return await action(); } finally { this.busy = false; }
  }
  private async copy(text: string): Promise<string> {
    try { await this.ports.clipboard(text); return "Copied to clipboard."; }
    catch { return "Clipboard unavailable; use Copy in the extension popup."; }
  }
  ask(id?: string) { return this.exclusive(() => this.askOne(id)); }
  private async askOne(id?: string) {
    const state = await this.ports.read();
    if (state.active?.phase === "starting") {
      // The lock proves no attempt is running now, so a saved "starting" was cut off
      // (for example by a worker restart). It may have sent the question.
      state.active.phase = "uncertain";
      const notice = "An earlier attempt was cut off. Check the Expert AI tab, then return its answer or release the question in the popup.";
      await this.ports.write({ ...state, notice });
      throw new Error(notice);
    }
    if (state.active && !(state.active.phase === "manual" && state.active.item.id === id)) {
      throw new Error("Return the current answer first, or release the current question in the popup before asking another.");
    }
    const api = await this.ports.api();
    await api.ping();
    const items = await api.queue();
    const item = id ? items.find((q) => q.id === id) : items.find((q) => q.status === "queued");
    if (!item) throw new Error("No queued question is available. Refresh the queue.");
    const active: ActiveQuestion = { item, requestId: crypto.randomUUID(), phase: "starting" };
    await this.ports.write({ ...state, active, notice: "Opening your visible Expert AI tab…" });
    let result: PageResult;
    let tabId: number;
    try {
      tabId = active.tabId = await this.ports.focusExpert();
      await this.ports.write({ ...state, active });
    } catch (error) {
      result = { ok: false, submitted: false, untouched: true, error: errorMessage(error) };
      return this.stopCleanly(state, result);
    }
    try { result = await this.ports.submit(tabId, item, active.requestId); }
    catch {
      // A lost message could mean the submit already happened. Only the page
      // never having asked to begin proves otherwise. Never retry the submit.
      const untouched = await this.ports.closeAttempt(active.requestId).catch(() => false);
      result = untouched
        ? { ok: false, submitted: false, untouched: true, error: "The Expert AI tab stopped responding before anything was sent." }
        : { ok: false, submitted: true, error: "The tab did not confirm submission. Check it before manually pasting or retrying." };
    }
    if (!result.ok && result.untouched && !result.submitted) return this.stopCleanly(state, result);
    if (!result.ok) {
      active.phase = result.submitted ? "uncertain" : "manual";
      const copied = await this.copy(item.prompt);
      const notice = `${result.error ?? "Page controls unavailable."} ${copied} Use manual paste-back in the extension.`;
      await this.ports.write({ ...state, active, notice });
      throw new Error(notice);
    }
    active.phase = "asked";
    await this.ports.write({ ...state, active });
    try { await api.asked(item.id); }
    catch (error) {
      active.phase = "uncertain";
      await this.ports.write({ ...state, active, notice: "Question submitted, but the app did not confirm its status. Return its answer manually; do not submit it again." });
      throw error;
    }
    await this.ports.write({ ...state, active, notice: "Question submitted. Read the answer, then choose Send to LearnHarness." });
  }
  /** Nothing reached Expert AI: go back to how things were and leave the item queued. */
  private async stopCleanly(before: SessionState, result: PageResult): Promise<never> {
    const notice = `Nothing was sent to Expert AI and the question is still queued. If Expert AI asks you to sign in, sign in there, then click Ask in Expert AI again. (${result.error ?? "The page was not ready."})`;
    await this.ports.write({ ...before, notice });
    throw new Error(notice);
  }
  manual(id: string) { return this.exclusive(async () => {
    const state = await this.ports.read();
    if (state.active && state.active.item.id !== id) throw new Error("Release the current question before choosing another.");
    const item = (await (await this.ports.api()).queue()).find((q) => q.id === id);
    if (!item) throw new Error("That question is no longer in the queue.");
    const active = state.active ?? { item, requestId: crypto.randomUUID(), phase: "manual" as const };
    const copied = await this.copy(item.prompt);
    await this.ports.write({ ...state, active, notice: `${copied} Start a new conversation, keep Standard mode, paste the prompt, then paste the answer back here.` });
  }); }
  release() { return this.exclusive(async () => {
    const state = await this.ports.read();
    await this.ports.write({ ...state, active: undefined, recovery: undefined, notice: "Local question released. Its app queue entry is unchanged; it can be selected again." });
  }); }
  answer(answer: Answer, next: boolean, source?: { tabId: number; requestId: string }) {
    return this.exclusive(async () => {
      const state = await this.ports.read();
      const active = state.active;
      if (!active) throw new Error("Choose the question in the extension before returning its answer.");
      if (source && (active.tabId !== source.tabId || active.requestId !== source.requestId || active.phase === "manual")) {
        throw new Error("This answer belongs to an older question. Use the current question's manual paste-back.");
      }
      validateAnswer(answer);
      // Save before network I/O, so a closed popup or worker sleep loses nothing.
      await this.ports.write({ ...state, recovery: { kind: "answer", answer } });
      let following: QueueItem | null;
      try { following = (await (await this.ports.api()).answer(active.item.id, answer)).next; }
      catch (error) {
        const copied = await this.copy([answer.text, ...answer.references.map(formatVerifyReference)].join("\n\n"));
        await this.ports.write({ ...state, recovery: { kind: "answer", answer }, notice: `Answer kept for retry. ${copied}` });
        throw error;
      }
      await this.ports.write({ ...state, active: undefined, recovery: undefined, notice: "Answer sent to LearnHarness." });
      // Only this explicit Send & ask next action may start the next query.
      if (next && following) {
        try { await this.askOne(following.id); }
        catch (error) {
          // Returning the old answer succeeded. Never offer it again as the
          // next question's answer just because opening that question failed.
          const nextError = errorMessage(error);
          await this.ports.write({ ...await this.ports.read(), notice: `Answer sent. Next question: ${nextError}` });
          return { hasNext: true, nextError };
        }
      }
      return { hasNext: Boolean(following) };
    });
  }
  highlight(highlight: Highlight) { return this.exclusive(async () => {
    validateHighlight(highlight);
    const state = await this.ports.read();
    // Do not overwrite an unsent Expert AI answer with an unrelated highlight.
    if (state.recovery?.kind === "answer") throw new Error("Return or copy the saved answer before sending another highlight.");
    await this.ports.write({ ...state, recovery: { kind: "highlight", highlight } });
    try { await (await this.ports.api()).highlight(highlight); }
    catch (error) {
      const copied = await this.copy(`${highlight.text}\n\n${highlight.url}`);
      await this.ports.write({ ...state, recovery: { kind: "highlight", highlight }, notice: `Highlight kept for retry. ${copied}` });
      throw error;
    }
    await this.ports.write({ ...state, recovery: undefined, notice: "Highlight sent to the most recently active teaching session." });
  }); }
}
