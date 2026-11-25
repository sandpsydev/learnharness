/** Read-only audit. Pass a directory of chat JSON copies; prints identifiers and
 * aggregate counts only, never learner text or question content. */
import { readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { LhMessage } from "../src/core/native-messages.ts";
import { GUARDED_QUESTION_TOOLS, unseenStepNote } from "../src/agent/visible-teaching.ts";

const directory = process.argv[2];
if (!directory) throw new Error("Usage: tsx scripts/audit-visible-teaching.ts <chat-copy-directory>");
const totals: Record<string, { total: number; refused: number; kinds: Record<string, { total: number; refused: number }> }> = {};
const calls: Array<{ chat: string; index: number; model: string; kind: string; refused: boolean }> = [];
let chats = 0;
for (const file of (await readdir(resolve(directory))).filter((name) => name.endsWith(".json")).sort()) {
	const chat = JSON.parse(await readFile(join(resolve(directory), file), "utf8")) as { id: string; messages: LhMessage[] };
	if (!Array.isArray(chat.messages)) continue;
	chats++;
	for (const [index, message] of chat.messages.entries()) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall" || !GUARDED_QUESTION_TOOLS.includes(block.name)) continue;
			const refused = unseenStepNote(chat.messages.slice(0, index), message, block.id) !== null;
			const kind = ["quiz", "explain"].includes(block.name) ? `${block.name}:${block.arguments.type ?? "unspecified"}` : block.name;
			const model = message.model;
			const total = totals[model] ??= { total: 0, refused: 0, kinds: {} };
			total.total++; total.refused += Number(refused);
			const byKind = total.kinds[kind] ??= { total: 0, refused: 0 };
			byKind.total++; byKind.refused += Number(refused);
			calls.push({ chat: chat.id, index, model, kind, refused });
		}
	}
}
console.log(JSON.stringify({ chats, totals, calls }, null, 2));
