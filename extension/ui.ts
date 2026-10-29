import { formatVerifyReference } from "../src/core/contracts/verify";
import type { VerifyReference } from "../src/core/contracts/verify";
import type { Reply, Request } from "./types";
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
