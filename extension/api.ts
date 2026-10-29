// Instantiated only by the service worker. Content scripts never get the token.
import type { Config, QueueItem, Answer, Highlight } from "./types";
export class VerifyApi {
  // Call the browser global directly; storing it unbound gives it this instance as its receiver.
  constructor(private config: Config, private fetchFn: typeof fetch = (input, init) => fetch(input, init)) {}
  private async call<T>(path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.config.appUrl}/v1/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${this.config.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(8000), redirect: "error", credentials: "omit", cache: "no-store",
      });
    } catch { throw new Error("LearnHarness is not running or its local API cannot be reached. Open the app and check the address in extension settings."); }
    let data;
    try { data = await response.json(); } catch { throw new Error("The local app returned an unreadable reply. Check the app address."); }
    if (!response.ok || data.ok !== true) throw new Error(data.error?.message ?? `LearnHarness returned HTTP ${response.status}.`);
    return data as T;
  }
  async ping() {
    const data = await this.call<{ app: string; apiVersion: number; authenticated: boolean }>("ping");
    if (data.app !== "learnharness" || data.apiVersion !== 1) throw new Error("This extension needs LearnHarness extension API version 1.");
    if (!data.authenticated) throw new Error("Pairing token is missing or incorrect. Copy it from LearnHarness Settings → Providers → Browser extension.");
    return data;
  }
  async queue(): Promise<QueueItem[]> { return (await this.call<{ items: QueueItem[] }>("queue")).items; }
  asked(id: string) { return this.call(`queue/${encodeURIComponent(id)}/asked`, {}); }
  answer(id: string, answer: Answer) { return this.call<{ next: QueueItem | null }>(`queue/${encodeURIComponent(id)}/answer`, answer); }
  highlight(highlight: Highlight) { return this.call("highlights", highlight); }
}
