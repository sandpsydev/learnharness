/**
 * THE LIBRARY'S VISION PASS (medical fork, Phase 6): for the image-heavy
 * pages of a PDF the learner chose to describe at import, render the page and
 * ask the vision model (the app's ChatGPT sign-in, via the vision slot) what
 * the extracted text is missing — the figure, the diagram, the table, the
 * radiograph. The description is stored with the page, marked as AI-written
 * and unverified (core/library.ts VISION_HEADING).
 *
 * One model call per page, no tool loop: the page image goes in, a short
 * plain-text description comes out.
 */

import { randomUUID } from "node:crypto";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import type { PiEngine } from "../models.ts";
import type { HeadlessApi } from "../subagents/headless.ts";

const INSTRUCTIONS = `You describe ONE page of a medical lecture deck or textbook for a search index a medical student will use.

The page's extracted text is given for context — it is already indexed, so do NOT repeat it. Describe only what the text misses:
- figures, diagrams, flowcharts, and what they show (structure and flow);
- tables (what is compared, the key contrast);
- radiographs, scans, histology, clinical photos (modality, view, the findings that are visible, what arrows or labels point to);
- graphs and charts (axes, trend, the point being made).
Transcribe important labels and numbers exactly as printed. Describe only what is visible; never add findings, diagnoses, or facts that are not shown. Plain text, at most 120 words, no preamble.
If the page has nothing beyond its text worth describing, answer exactly: NONE`;

/** Render dpi for the vision pass: enough to read labels, cheap to upload. */
const VISION_DPI = 110;
/** Pages rendered per pdfjs open (the file is re-read per render call). */
const RENDER_BATCH = 6;
/** After this many failures in a row the pass gives up and says why. */
const GIVE_UP_AFTER = 5;

export interface VisionPassOptions {
	engine: PiEngine;
	headless: HeadlessApi;
	pdfPath: string;
	/** Pages to describe (ascending). */
	pages: readonly number[];
	/** Extracted text per page, for the model's context. */
	textOf: (page: number) => string;
	signal?: AbortSignal;
	/** Called after each page (described or not) with how many are done. */
	onProgress?: (done: number, total: number) => void;
}

export interface VisionPassResult {
	/** page → description (only pages that had something to say). */
	descriptions: Map<number, string>;
	/** Pages that were attempted and answered (described or NONE). */
	describedPages: number[];
	/** Set when the pass stopped early or skipped pages. */
	notice?: string;
}

export async function describePages(opts: VisionPassOptions): Promise<VisionPassResult> {
	const descriptions = new Map<number, string>();
	const describedPages: number[] = [];
	const sessionId = randomUUID();
	let failures = 0;
	let lastError = "";
	let done = 0;
	let skipped = 0;
	const abort = () => {
		const err = new Error("aborted");
		err.name = "AbortError";
		return err;
	};

	for (let i = 0; i < opts.pages.length; i += RENDER_BATCH) {
		if (opts.signal?.aborted) throw abort();
		const batch = opts.pages.slice(i, i + RENDER_BATCH);
		let rendered: Awaited<ReturnType<HeadlessApi["renderPdfPages"]>> = [];
		try {
			rendered = await opts.headless.renderPdfPages(opts.pdfPath, [...batch], { dpi: VISION_DPI });
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
		}
		for (const page of batch) {
			if (opts.signal?.aborted) throw abort();
			const png = rendered.find((r) => r.page === page)?.png;
			let answered = false;
			if (png) {
				try {
					const text = await describeOne(opts.engine, sessionId, opts.textOf(page), png, opts.signal);
					answered = true;
					failures = 0;
					describedPages.push(page);
					if (text) descriptions.set(page, text);
				} catch (err) {
					if ((err as Error).name === "AbortError") throw err;
					lastError = err instanceof Error ? err.message : String(err);
				}
			}
			if (!answered) {
				failures++;
				skipped++;
			}
			opts.onProgress?.(++done, opts.pages.length);
			if (failures >= GIVE_UP_AFTER) {
				const left = opts.pages.length - done;
				return {
					descriptions,
					describedPages,
					notice: `Image descriptions stopped after ${GIVE_UP_AFTER} failures in a row (${lastError || "unknown error"}); ${skipped + left} image-heavy page${skipped + left === 1 ? " was" : "s were"} indexed as text only.`,
				};
			}
		}
	}
	return {
		descriptions,
		describedPages,
		...(skipped > 0 ? { notice: `${skipped} image-heavy page${skipped === 1 ? "" : "s"} couldn't be described (${lastError || "unknown error"}) and ${skipped === 1 ? "was" : "were"} indexed as text only.` } : {}),
	};
}

async function describeOne(engine: PiEngine, sessionId: string, pageText: string, png: Buffer, signal?: AbortSignal): Promise<string> {
	const context = pageText.trim().slice(0, 900);
	const messages: Message[] = [
		{
			role: "user",
			content: [
				{ type: "text", text: `Extracted text of this page (already indexed):\n${context || "(none)"}` },
				{ type: "image", data: png.toString("base64"), mimeType: "image/png" },
			],
			timestamp: Date.now(),
		},
	];
	const stream = engine.streamFn(engine.model, normalizeContext({ systemPrompt: INSTRUCTIONS, messages, tools: [] }), {
		sessionId,
		reasoning: undefined,
		signal,
	} as never);
	let message: AssistantMessage | null = null;
	for await (const event of stream) {
		if (event.type === "done") {
			message = event.message;
			break;
		}
		if (event.type === "error") {
			if (event.reason === "aborted") {
				const err = new Error("aborted");
				err.name = "AbortError";
				throw err;
			}
			throw new Error(event.error.errorMessage ?? "the vision model call failed");
		}
	}
	if (!message) throw new Error("the vision model stream ended without a result");
	const text = message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("")
		.trim();
	return /^none\.?$/i.test(text) ? "" : text;
}
