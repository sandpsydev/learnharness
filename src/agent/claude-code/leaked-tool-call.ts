import { TOOL_RESULT_LABEL_PREFIX, TOOL_USE_LABEL_PREFIX } from "./transcript.ts";

/**
 * Safety net for a model that copies the replayed history and writes a tool call out as text
 * (e.g. `[tool call quiz] {"type":"check",...}`) instead of making the real call. The learner
 * would see raw JSON and no quiz, so such text is removed before the reply is shown or saved.
 */

const MARKERS: RegExp[] = [
	/\[tool call [^\]\n]*\]/g, // the old replay format, which the model may still imitate from older habits
	/\[tool result [^\]\n]*\]/g,
	new RegExp(`${escapeRegExp(TOOL_USE_LABEL_PREFIX)}[^\\]\\n]*\\]`, "g"),
	new RegExp(`${escapeRegExp(TOOL_RESULT_LABEL_PREFIX)}[^\\]\\n]*\\]`, "g"),
];

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Index just past the JSON object or array opening at `start`, or -1 when it never closes. */
function endOfJson(text: string, start: number): number {
	let depth = 0;
	let inString = false;

	for (let i = start; i < text.length; i++) {
		const char = text[i];

		if (inString) {
			if (char === "\\") i++;
			else if (char === '"') inString = false;
			continue;
		}

		if (char === '"') inString = true;
		else if (char === "{" || char === "[") depth++;
		else if (char === "}" || char === "]") {
			depth--;
			if (depth === 0) return i + 1;
		}
	}

	return -1;
}

function findLeak(text: string): { start: number; end: number } | null {
	let first: { start: number; end: number } | null = null;

	for (const marker of MARKERS) {
		marker.lastIndex = 0;
		const match = marker.exec(text);
		if (!match || (first && match.index >= first.start)) continue;

		let end = match.index + match[0].length;
		let payload = end;
		while (payload < text.length && /\s/.test(text[payload] ?? "")) payload++;

		if (text[payload] === "{" || text[payload] === "[") {
			const jsonEnd = endOfJson(text, payload);
			end = jsonEnd === -1 ? text.length : jsonEnd;
		}

		first = { start: match.index, end };
	}

	return first;
}

export function hasLeakedToolCall(text: string): boolean {
	return findLeak(text) !== null;
}

/** The text with every leaked tool call (label and JSON payload) removed. */
export function stripLeakedToolCalls(text: string): string {
	let result = text;

	for (let leak = findLeak(result); leak; leak = findLeak(result)) {
		result = result.slice(0, leak.start) + result.slice(leak.end);
	}

	return result.replace(/\n{3,}/g, "\n\n").trim();
}
