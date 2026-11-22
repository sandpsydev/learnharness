import type { ImageContent, Message, TextContent, Tool } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";

export type ClaudeContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export type ClaudeInput = {
	systemPrompt: string;
	tools: Tool[];
	userContent: ClaudeContentBlock[];
};

type ReplayPart = string | ImageContent;

/**
 * Earlier tool calls are replayed as past-tense history, never as something shaped like a call
 * (`[tool call quiz] {json}`), because the model copies what it sees in the transcript and then
 * prints that text instead of making the real tool call. Keep these labels in step with
 * leaked-tool-call.ts, which strips any that still leak into a reply.
 */
export const TOOL_USE_LABEL_PREFIX = "[earlier tool use, already done: ";
export const TOOL_RESULT_LABEL_PREFIX = "[earlier tool result: ";

const HISTORY_NOTE =
	`Note on the record below: entries starting "${TOOL_USE_LABEL_PREFIX.trim()}" and "${TOOL_RESULT_LABEL_PREFIX.trim()}" ` +
	"are tools you already used earlier and what came back. They are history, not a format to write. " +
	"To use a tool now, make a real tool call; never write a tool call out as text.";

function toImageBlock(image: ImageContent): ClaudeContentBlock {
	return { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } };
}

function getLabelledParts(label: string, content: string | (TextContent | ImageContent)[]): ReplayPart[] {
	if (typeof content === "string") return [`${label}\n${content}`];

	const text = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	const images = content.filter((block) => block.type === "image");

	return [text ? `${label}\n${text}` : label, ...images];
}

function getReplayParts(message: Message): ReplayPart[] {
	switch (message.role) {
		case "system":
			return [];

		case "user":
			return getLabelledParts("[user]", message.content);

		case "assistant":
			return message.content.flatMap((block) => {
				if (block.type === "text") return [`[assistant]\n${block.text}`];
				if (block.type === "toolCall") return [`${TOOL_USE_LABEL_PREFIX}${block.name}] ${JSON.stringify(block.arguments)}`];
				return [];
			});

		case "toolResult": {
			const label = `${TOOL_RESULT_LABEL_PREFIX}${message.toolName}${message.isError ? ", failed" : ""}]`;
			return getLabelledParts(label, message.content);
		}
	}
}

/**
 * One content block per replayed entry, never one block for the whole record.
 *
 * Whenever a held process cannot be continued (a background result arrived between a tool call and
 * the next model call, a process timed out), the whole record is sent again as a fresh user message.
 * The prompt cache matches a request against an earlier one at content-block boundaries, up to the
 * block the request ends on. One big block can only ever match the part before it (the system
 * prompt and tools), so every such restart re-wrote the entire conversation at full price; a
 * measured turn re-wrote 91k to 114k tokens on each of five steps and read only 31,851 each time.
 * With a block per entry, each earlier entry stays byte-identical as the record grows, so the next
 * replay ends on blocks the previous one already stored.
 *
 * The text is unchanged: the blocks put together read exactly as the single block did (each block
 * after the first starts with the blank line that used to sit between entries).
 */
function toContentBlocks(parts: ReplayPart[]): ClaudeContentBlock[] {
	const blocks: ClaudeContentBlock[] = [];
	let afterText = false;

	for (const part of parts) {
		if (typeof part === "string") {
			blocks.push({ type: "text", text: afterText ? `\n\n${part}` : part });
			afterText = true;
		} else {
			blocks.push(toImageBlock(part));
			afterText = false;
		}
	}

	return blocks;
}

function toUnlabelledBlocks(content: string | (TextContent | ImageContent)[]): ClaudeContentBlock[] {
	if (typeof content === "string") return [{ type: "text", text: content }];

	return content.map((block) => (block.type === "text" ? { type: "text", text: block.text } : toImageBlock(block)));
}

function toUserContent(conversation: Message[]): ClaudeContentBlock[] {
	const [first] = conversation;
	if (conversation.length === 1 && first?.role === "user") return toUnlabelledBlocks(first.content);

	const parts = conversation.flatMap(getReplayParts);
	const usedTools = conversation.some((message) => message.role === "toolResult" || (message.role === "assistant" && message.content.some((block) => block.type === "toolCall")));

	return toContentBlocks(usedTools ? [HISTORY_NOTE, ...parts] : parts);
}

export function toClaudeInput(messages: Message[]): ClaudeInput {
	const conversation = messages.filter((message) => message.role !== "system");

	return {
		systemPrompt: getCurrentSystemPrompt(messages),
		tools: getCurrentTools(messages),
		userContent: toUserContent(conversation),
	};
}

export function toStreamJsonLine(content: ClaudeContentBlock[]): string {
	return JSON.stringify({ type: "user", message: { role: "user", content } });
}
