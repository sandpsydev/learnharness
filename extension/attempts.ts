/**
 * Tracks whether the Expert AI page has started filling a question.
 *
 * The page asks permission (`begin`) just before it writes anything into the
 * composer. That is the only evidence the extension controls: if the page never
 * got permission, nothing was filled or submitted. The state lives in worker
 * memory on purpose. After a worker restart an attempt is unknown, so `close`
 * answers "not sure" and the question stays on the safe uncertain path.
 */
export class Attempts {
  private state = new Map<string, { tabId: number; status: "open" | "begun" | "closed" }>();
  open(requestId: string, tabId: number) {
    this.state.clear();
    this.state.set(requestId, { tabId, status: "open" });
  }
  /** The page asks permission to fill. Refused once the attempt was closed. */
  begin(requestId: string, tabId: number): boolean {
    const attempt = this.state.get(requestId);
    if (!attempt || attempt.tabId !== tabId || attempt.status === "closed") return false;
    attempt.status = "begun";
    return true;
  }
  /** True when it is certain the page never began, and refuses any later begin. */
  close(requestId: string): boolean {
    const attempt = this.state.get(requestId);
    if (attempt?.status !== "open") return false;
    attempt.status = "closed";
    return true;
  }
}
