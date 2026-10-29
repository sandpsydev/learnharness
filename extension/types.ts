/// <reference types="chrome" />
import type { VerifyReference, VerifyStatus } from "../src/core/contracts/verify";

export interface Config { appUrl: string; expertUrl: string; token: string }
export interface QueueItem {
  id: string; chatId: string; chatTitle: string; prompt: string;
  status: VerifyStatus; createdAt: string;
}
export interface Answer { text: string; references: VerifyReference[]; sourceUrl?: string }
export interface Highlight { text: string; url: string; title?: string }
export interface ActiveQuestion {
  item: QueueItem; tabId?: number; requestId: string;
  phase: "starting" | "asked" | "uncertain" | "manual";
}
export interface SessionState {
  active?: ActiveQuestion; notice?: string;
  recovery?: { kind: "answer"; answer: Answer } | { kind: "highlight"; highlight: Highlight };
}
export type Request =
  | { type: "state" } | { type: "queue" } | { type: "config" }
  | { type: "save-config"; config: Config } | { type: "ping" }
  | { type: "ask"; id?: string } | { type: "manual"; id: string }
  | { type: "release" } | { type: "copy"; text: string }
  | { type: "answer"; answer: Answer; next: boolean; requestId?: string }
  | { type: "begin"; requestId: string }
  | { type: "highlight"; highlight: Highlight };
export type Reply<T = unknown> = { ok: true; data: T } | { ok: false; error: string };
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Try the manual fallback.";
}
