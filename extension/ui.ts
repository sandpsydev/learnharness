import { formatVerifyReference } from "../src/core/contracts/verify";
import type { VerifyReference } from "../src/core/contracts/verify";
import type { ActiveQuestion, Reply, Request } from "./types";
export async function request<T>(message: Request): Promise<T> {
  const reply: Reply<T> = await chrome.runtime.sendMessage(message);
  if (!reply?.ok) throw new Error(reply?.error ?? "Extension worker unavailable. Reload the extension.");
  return reply.data;
}
export function element<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T; }
export function referenceLines(text: string, originals: VerifyReference[] = []): VerifyReference[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) =>
    originals.find((ref) => formatVerifyReference(ref) === line) ?? (/^https?:\/\//i.test(line) ? { url: line } : { title: line }));
}
/** Plain-words status for the current question, including what unblocks the queue. */
export function describePhase(phase: ActiveQuestion["phase"]): string {
  switch (phase) {
    case "starting": return "Opening Expert AI. If this stays here, release the question below.";
    case "manual": return "Not sent to Expert AI. Click Ask in Expert AI to try again, or paste the answer below.";
    case "asked": return "Sent to Expert AI. Read the answer there, then send it to LearnHarness.";
    case "uncertain": return "May already be in Expert AI. Check that tab first. To start over, release the question below.";
  }
}
