/**
 * SESSION RECAP — pure core (medical fork, docs/medical-spec.md "Session
 * recap").
 *
 * A recap is one review note per teaching session, written from that session
 * alone. This module is the whole of the "only from the chat" rule:
 *
 *   assembleTranscript  turns the session record into the ONE text the writer
 *                       is shown: what the teacher said, what the learner said,
 *                       every check-in and quiz with the learner's answer and
 *                       the correction the session gave, and the figures and
 *                       tables that appeared. Nothing else goes in — not the
 *                       graph, not the library, not the Expert AI answers.
 *                       Every part carries a turn number [T12]; tables and
 *                       figures carry ids (K1, F1).
 *   validateRecap       refuses a draft whose points do not name turns of this
 *                       session, or that names a table or figure the session
 *                       never showed. Tables and figures are copied from the
 *                       record by id, never retyped by the writer, so they
 *                       cannot be invented.
 *   renderRecapNote     turns the stored recap into the Markdown note.
 *
 * No IO, no model calls, no node builtins.
 */

import type { GraphNode, OrganSystem } from "./contracts/graph.ts";
import type { FigureResult, SteerDetails, VisualResult } from "./contracts/jobs.ts";
import type { RecapFigure, RecapMiss, RecapPictureRequest, RecapQuestion, RecapTable, RecapTopic, SessionRecap } from "./contracts/recap.ts";
import { fingerprint } from "./illness-script.ts";
import { failedOutputCallIds, userFacingTextOf, type LhMessage } from "./native-messages.ts";
import { SESSION_RECAPS_DIR, frontmatter, safeFileStem, wikilink, type DesiredNote } from "./obsidian.ts";
import type { QuestionAnswerData } from "./question-core.ts";

// ─── limits ──────────────────────────────────────────────────────────────────

export const RECAP_LIMITS = {
	/** The whole transcript is kept under this many characters (about 150k tokens). */
	transcriptChars: 600_000,
	/** Per-message clip, tried in turn until the whole transcript fits. */
	messageClips: [14_000, 7_000, 3_500, 1_800],
	summaryChars: 1_500,
	topics: 16,
	pointsPerTopic: 24,
	misses: 30,
	selfTest: 40,
	textChars: 1_200,
	/** New pictures the app may look for in one recap. */
	pictures: 5,
	pictureChars: 240,
	diagramChars: 700,
} as const;

const TOOL_QUESTIONS = new Set(["quiz", "probe", "explain", "recall", "ask_user_question"]);

const clean = (s: string): string => s.replace(/\s+/g, " ").trim();

// ─── tables ──────────────────────────────────────────────────────────────────

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const looksLikeRow = (line: string): boolean => line.includes("|") && line.trim() !== "";

/** Split text into runs of prose and GitHub-style Markdown tables. A table is a header row, a separator row and the rows after it. */
export function splitTables(text: string): Array<{ table: false; text: string } | { table: true; text: string }> {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const out: Array<{ table: boolean; text: string }> = [];
	const push = (table: boolean, chunk: string[]): void => {
		if (chunk.length > 0) out.push({ table, text: chunk.join("\n") });
	};
	let prose: string[] = [];
	let fenced = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
		const next = lines[i + 1];
		if (!fenced && looksLikeRow(line) && next !== undefined && TABLE_SEPARATOR.test(next) && next.includes("-")) {
			push(false, prose);
			prose = [];
			const rows = [line, next];
			i += 1;
			while (i + 1 < lines.length && looksLikeRow(lines[i + 1]!) && !/^\s*(```|~~~)/.test(lines[i + 1]!)) rows.push(lines[++i]!);
			push(true, rows);
		} else {
			prose.push(line);
		}
	}
	push(false, prose);
	return out as Array<{ table: false; text: string } | { table: true; text: string }>;
}

// ─── the transcript ──────────────────────────────────────────────────────────

/** A figure the session showed, as the writer may refer to it. */
export interface RecapFigureSource {
	id: string;
	/** "image" = a real figure cached for the session; "drawn" = an SVG the app drew. */
	kind: "image" | "drawn";
	/** The file name the note will embed it under. */
	file: string;
	/** Real figures: the caption the figure card showed. Drawn figures: empty, the writer names it. */
	caption: string;
	credit: string;
	/** Real figures: the file in the session's figure cache. */
	cacheFile?: string;
	/** Drawn figures: the SVG. */
	svg?: string;
}

export interface AssembledTranscript {
	text: string;
	/** The highest turn number. */
	turns: number;
	/** Turns that are the teacher teaching (a recap of nothing is refused). */
	teacherTurns: number;
	tables: Map<string, RecapTable>;
	figures: Map<string, RecapFigureSource>;
	/** How many characters each message was clipped to (the first clip that fit). */
	clippedTo: number;
}

export interface AssembleOptions {
	chatId: string;
	/** Is this session figure still in the figure cache? A figure the learner can no longer be given is not offered. */
	hasCachedFigure: (file: string) => boolean;
}

const ID_TAIL = (chatId: string): string => chatId.replace(/[^a-z0-9]/gi, "").slice(-8) || "session";

/** The file name a session figure gets in the Attachments folder. */
export function figureAssetName(chatId: string, source: { cacheFile: string } | { svg: string }): string {
	return "cacheFile" in source ? `recap-${ID_TAIL(chatId)}-${source.cacheFile}` : `recap-${ID_TAIL(chatId)}-drawn-${fingerprint(source.svg).slice(0, 12)}.svg`;
}

const optionLabels = (data: QuestionAnswerData, indices: readonly number[] | undefined): string[] => {
	if (!indices) return [];
	return indices.map((i) => data.options?.find((o) => o.index === i)?.label ?? data.options?.[i - 1]?.label).filter((l): l is string => typeof l === "string" && l !== "");
};

/** One answered question, in words. */
export function questionBlock(details: QuestionAnswerData | undefined, tool: string): string | null {
	if (!details || typeof details.questionText !== "string" || details.questionText.trim() === "") return null;
	const lines: string[] = [];
	const predict = details.questionType === "predict";
	const kind =
		tool === "ask_user_question" || details.kind === "ask"
			? "QUESTION TO THE LEARNER (about what to do, not a knowledge check)"
			: tool === "explain" || tool === "recall" || details.kind === "explain"
				? "RECALL CHECK (the learner explains in their own words)"
				: predict
					? "PREDICTION QUESTION (asked before the teaching, so a wrong answer is expected)"
					: "CHECK QUESTION";
	lines.push(`${kind}: ${details.questionText.trim()}`);
	if (details.options && details.options.length > 0) lines.push(`Options: ${details.options.map((o) => `${o.index}. ${o.label}`).join(" | ")}`);
	if (details.dismissed === true) {
		lines.push("The learner skipped this question.");
		return lines.join("\n");
	}
	const chosen = [...(details.answers ?? []).map((a) => a.label), ...(typeof details.other === "string" && details.other.trim() ? [details.other.trim()] : [])];
	if (details.dontKnow === true) lines.push("The learner answered: I don't know.");
	else if (typeof details.text === "string" && details.text.trim() !== "") lines.push(`The learner answered: ${details.text.trim()}`);
	else if (chosen.length > 0) lines.push(`The learner answered: ${chosen.join("; ")}`);
	if (details.correct === true) lines.push("Result: correct.");
	else if (details.correct === false) lines.push("Result: incorrect.");
	const right = optionLabels(details, details.correctIndices);
	if (right.length > 0) lines.push(`The correct answer: ${right.join("; ")}`);
	if (typeof details.committed === "string" && details.committed.trim() !== "") lines.push(`The answer the teacher had committed to: ${details.committed.trim()}`);
	if (typeof details.explanation === "string" && details.explanation.trim() !== "") lines.push(`The explanation the learner was shown: ${details.explanation.trim()}`);
	const thinking = details.thinking ?? details.note;
	if (typeof thinking === "string" && thinking.trim() !== "") lines.push(`The learner's own reasoning: ${thinking.trim()}`);
	return lines.join("\n");
}

interface Block {
	label: string;
	text: string;
	teacher?: boolean;
}

/** The session, message by message, as plain blocks before numbering and clipping. */
function blocksOf(messages: ReadonlyArray<LhMessage>, opts: AssembleOptions, tables: Map<string, RecapTable>, figures: Map<string, RecapFigureSource>): Block[] {
	const blocks: Block[] = [];
	const failed = failedOutputCallIds(messages);
	let tableN = 0;
	let figureN = 0;
	const seenFigureFiles = new Set<string>();
	for (const message of messages) {
		if (message.role === "user") {
			for (const text of userFacingTextOf(message.content)) blocks.push({ label: "LEARNER", text: text.trim() });
		} else if (message.role === "assistant") {
			for (const text of userFacingTextOf(message.content, failed)) {
				const parts = splitTables(text.trim()).map((part) => {
					if (!part.table) return part.text;
					const id = `K${++tableN}`;
					tables.set(id, { id, markdown: part.text.trim() });
					return `[TABLE ${id}]\n${part.text.trim()}\n[END TABLE ${id}]`;
				});
				blocks.push({ label: "TEACHER", text: parts.join("\n").trim(), teacher: true });
			}
		} else if (message.role === "toolResult") {
			if (message.isError || !TOOL_QUESTIONS.has(message.toolName)) continue;
			const block = questionBlock(message.details as QuestionAnswerData | undefined, message.toolName);
			if (block) blocks.push({ label: "QUESTION", text: block });
		} else if (message.role === "custom" && message.customType === "subagent-steer") {
			const details = message.details as Partial<SteerDetails> | undefined;
			if (!details || details.aborted === true) continue;
			if (details.kind === "figure") {
				const result = details.result as FigureResult | undefined;
				const image = result?.outcome === "image" ? result.image : undefined;
				if (!result || !image || !opts.hasCachedFigure(image.file) || seenFigureFiles.has(image.file)) continue;
				seenFigureFiles.add(image.file);
				const id = `F${++figureN}`;
				const credit = [image.credit, image.licence].filter((s) => typeof s === "string" && s.trim() !== "").join(" · ");
				figures.set(id, { id, kind: "image", file: figureAssetName(opts.chatId, { cacheFile: image.file }), caption: clean(result.caption), credit, cacheFile: image.file });
				blocks.push({
					label: "FIGURE",
					text: `FIGURE ${id}, a real picture shown to the learner: ${clean(result.caption)}${result.keyFeature ? ` Key feature to find: ${clean(result.keyFeature)}` : ""}${result.notShown ? ` It does not show: ${clean(result.notShown)}` : ""}`,
				});
			} else if (details.kind === "visual") {
				const svg = (details.result as VisualResult | undefined)?.svg;
				if (typeof svg !== "string" || svg.length === 0) continue;
				const file = figureAssetName(opts.chatId, { svg });
				if ([...figures.values()].some((f) => f.file === file)) continue;
				const id = `F${++figureN}`;
				figures.set(id, { id, kind: "drawn", file, caption: "", credit: "", svg });
				blocks.push({ label: "FIGURE", text: `FIGURE ${id}, a diagram the app drew and showed to the learner at this point (name it yourself if you use it, from what the teacher said about it).` });
			}
		}
	}
	return blocks;
}

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max).trimEnd()} […clipped]`);

/** The session as the one text the recap writer is shown. */
export function assembleTranscript(messages: ReadonlyArray<LhMessage>, opts: AssembleOptions): AssembledTranscript {
	const tables = new Map<string, RecapTable>();
	const figures = new Map<string, RecapFigureSource>();
	const blocks = blocksOf(messages, opts, tables, figures);
	const render = (limit: number): string =>
		blocks.map((b, i) => `[T${i + 1}] ${b.label}:\n${clip(b.text, limit)}`).join("\n\n");
	let text = "";
	let clippedTo: number = RECAP_LIMITS.messageClips[0];
	for (const limit of RECAP_LIMITS.messageClips) {
		text = render(limit);
		clippedTo = limit;
		if (text.length <= RECAP_LIMITS.transcriptChars) break;
	}
	return { text, turns: blocks.length, teacherTurns: blocks.filter((b) => b.teacher).length, tables, figures, clippedTo };
}

/** True when the clipped transcript still does not fit (the session is too long to recap in one go). */
export const transcriptTooLong = (t: Pick<AssembledTranscript, "text">): boolean => t.text.length > RECAP_LIMITS.transcriptChars;

// ─── what the writer hands back, and the check on it ─────────────────────────

export interface RawRecapDraft {
	summary?: unknown;
	topics?: unknown;
	misses?: unknown;
	selfTest?: unknown;
}

export interface ValidatedTopic extends RecapTopic {
	/** Pictures to look for; once found they are added to `figures`. */
	pictures: RecapPictureRequest[];
}

export interface ValidatedRecap {
	summary: string;
	topics: ValidatedTopic[];
	misses: RecapMiss[];
	selfTest: RecapQuestion[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? clean(v) : "");
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A question or answer keeps its line breaks (a vignette is several lines); only the ends are trimmed. */
const block = (v: unknown): string => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim() : "");

/** Check a draft against the session it was written from. Problems are plain sentences for the writer to act on. */
export function validateRecap(raw: RawRecapDraft, transcript: Pick<AssembledTranscript, "turns" | "tables" | "figures">): { ok: true; recap: ValidatedRecap } | { ok: false; problems: string[] } {
	const problems: string[] = [];
	const turnsOk = (value: unknown, where: string): boolean => {
		const turns = list(value);
		if (turns.length === 0) {
			problems.push(`${where}: name the turn numbers it comes from, for example "turns": [3, 4].`);
			return false;
		}
		const bad = turns.filter((t) => !Number.isInteger(t) || (t as number) < 1 || (t as number) > transcript.turns);
		if (bad.length > 0) {
			problems.push(`${where}: turn ${bad.map(String).join(", ")} is not in the session (it has turns 1 to ${transcript.turns}).`);
			return false;
		}
		return true;
	};

	const summary = block(raw.summary);
	if (summary === "") problems.push("summary: write a short summary of what the session covered.");
	else if (summary.length > RECAP_LIMITS.summaryChars) problems.push(`summary: keep it under ${RECAP_LIMITS.summaryChars} characters.`);

	const topics: ValidatedTopic[] = [];
	let pictureCount = 0;
	const usedTables = new Set<string>();
	const usedFigures = new Set<string>();
	const rawTopics = list(raw.topics);
	if (rawTopics.length === 0) problems.push("topics: give at least one topic the session covered.");
	if (rawTopics.length > RECAP_LIMITS.topics) problems.push(`topics: at most ${RECAP_LIMITS.topics}; merge related ones.`);
	rawTopics.slice(0, RECAP_LIMITS.topics).forEach((entry, i) => {
		const where = `topics[${i}]`;
		if (!isRecord(entry)) return void problems.push(`${where}: must be an object with a title and points.`);
		const title = str(entry.title);
		if (title === "") problems.push(`${where}: needs a title.`);
		const points: string[] = [];
		const rawPoints = list(entry.points);
		if (rawPoints.length > RECAP_LIMITS.pointsPerTopic) problems.push(`${where}: at most ${RECAP_LIMITS.pointsPerTopic} points; keep the key ones.`);
		rawPoints.slice(0, RECAP_LIMITS.pointsPerTopic).forEach((p, j) => {
			if (!isRecord(p)) return void problems.push(`${where}.points[${j}]: must be an object with text and turns.`);
			const text = str(p.text);
			if (text === "") problems.push(`${where}.points[${j}]: empty text.`);
			else if (text.length > RECAP_LIMITS.textChars) problems.push(`${where}.points[${j}]: too long; split it into shorter points.`);
			if (turnsOk(p.turns, `${where}.points[${j}]`) && text !== "") points.push(text);
		});
		const tables: RecapTable[] = [];
		for (const id of list(entry.tables)) {
			const table = typeof id === "string" ? transcript.tables.get(id.trim().toUpperCase()) : undefined;
			if (!table) problems.push(`${where}.tables: "${String(id)}" is not a table of this session (tables are ${[...transcript.tables.keys()].join(", ") || "none"}).`);
			else if (!usedTables.has(table.id)) {
				usedTables.add(table.id);
				tables.push(table);
			}
		}
		const figures: RecapFigure[] = [];
		for (const f of list(entry.figures)) {
			const id = (typeof f === "string" ? f : isRecord(f) ? str(f.id) : "").trim().toUpperCase();
			const source = transcript.figures.get(id);
			if (!source) {
				problems.push(`${where}.figures: "${id}" is not a figure of this session (figures are ${[...transcript.figures.keys()].join(", ") || "none"}).`);
				continue;
			}
			if (usedFigures.has(id)) continue;
			const caption = source.kind === "image" ? source.caption : isRecord(f) ? str(f.caption) : "";
			if (caption === "") {
				problems.push(`${where}.figures: ${id} is a drawn diagram; give it a short "caption" from what the teacher said about it.`);
				continue;
			}
			usedFigures.add(id);
			figures.push({ file: source.file, caption: caption.slice(0, 240), credit: source.credit });
		}
		const pictures: RecapPictureRequest[] = [];
		list(entry.pictures).forEach((pic, j) => {
			const at = `${where}.pictures[${j}]`;
			if (!isRecord(pic)) return void problems.push(`${at}: must be an object with concept, caption and turns.`);
			const concept = str(pic.concept);
			const caption = str(pic.caption);
			const modality = str(pic.modality);
			const diagram = block(pic.diagram);
			if (concept === "" || caption === "") problems.push(`${at}: needs a concept (what the picture must show) and a caption (one sentence, from what the session said).`);
			if (caption.length > RECAP_LIMITS.pictureChars || concept.length > RECAP_LIMITS.pictureChars) problems.push(`${at}: keep the concept and caption under ${RECAP_LIMITS.pictureChars} characters.`);
			if (diagram.length > RECAP_LIMITS.diagramChars) problems.push(`${at}: keep the diagram brief under ${RECAP_LIMITS.diagramChars} characters.`);
			if (++pictureCount > RECAP_LIMITS.pictures) {
				if (pictureCount === RECAP_LIMITS.pictures + 1) problems.push(`pictures: at most ${RECAP_LIMITS.pictures} new pictures in a recap; keep the ones that matter most.`);
				return;
			}
			if (turnsOk(pic.turns, at) && concept !== "" && caption !== "") {
				pictures.push({ concept, caption, ...(modality !== "" ? { modality } : {}), ...(diagram !== "" ? { diagram } : {}) });
			}
		});
		if (title !== "" && points.length === 0 && tables.length === 0 && figures.length === 0) problems.push(`${where}: "${title}" has no points, tables or figures.`);
		if (title !== "") topics.push({ title: title.slice(0, 140), points, tables, figures, pictures });
	});

	const misses: RecapMiss[] = [];
	const rawMisses = list(raw.misses);
	if (rawMisses.length > RECAP_LIMITS.misses) problems.push(`misses: at most ${RECAP_LIMITS.misses}.`);
	rawMisses.slice(0, RECAP_LIMITS.misses).forEach((entry, i) => {
		const where = `misses[${i}]`;
		if (!isRecord(entry)) return void problems.push(`${where}: must be an object.`);
		const question = block(entry.question);
		const yours = block(entry.yours);
		const correct = block(entry.correct);
		if (question === "" || yours === "" || correct === "") problems.push(`${where}: needs question, yours (what the learner said) and correct (the answer the session gave).`);
		if (turnsOk(entry.turns, where) && question !== "" && yours !== "" && correct !== "") misses.push({ question, yours, correct });
	});

	const selfTest: RecapQuestion[] = [];
	const rawTest = list(raw.selfTest);
	if (rawTest.length > RECAP_LIMITS.selfTest) problems.push(`selfTest: at most ${RECAP_LIMITS.selfTest}.`);
	rawTest.slice(0, RECAP_LIMITS.selfTest).forEach((entry, i) => {
		const where = `selfTest[${i}]`;
		if (!isRecord(entry)) return void problems.push(`${where}: must be an object.`);
		const question = block(entry.question);
		const answer = block(entry.answer);
		if (question === "" || answer === "") problems.push(`${where}: needs a question and its answer.`);
		if (turnsOk(entry.turns, where) && question !== "" && answer !== "") selfTest.push({ question, answer });
	});

	if (problems.length > 0) return { ok: false, problems };
	return { ok: true, recap: { summary, topics, misses, selfTest } };
}

// ─── naming ──────────────────────────────────────────────────────────────────

/** The file stem of a recap: `<date> <session title>`, made safe. */
export function recapStem(sessionDate: string, title: string): string {
	return safeFileStem(`${sessionDate} ${clean(title) || "Session"}`, `${sessionDate} Session`);
}

/** The session's date as a plain YYYY-MM-DD (UTC, like every other date the vault notes carry). */
export const sessionDateOf = (createdAt: string): string => (/^\d{4}-\d{2}-\d{2}/.test(createdAt) ? createdAt.slice(0, 10) : new Date(createdAt).toISOString().slice(0, 10));

// ─── rendering ───────────────────────────────────────────────────────────────

export interface RecapRenderContext {
	/** The file stem to use; defaults to the date-and-title one (the caller makes it collision-proof). */
	stem?: string;
	/** Fact notes the graph holds from this session, already named for linking. */
	facts: ReadonlyArray<{ stem: string; name: string }>;
	/** Organ systems of those facts, for tags. */
	systems: readonly OrganSystem[];
}

const oneLine = (s: string): string => clean(s).replace(/^#+\s*/, "");
const quoted = (text: string): string[] => text.split("\n").map((l) => (l.trim() === "" ? ">" : `> ${l}`));

/** The generated part of a recap's note (frontmatter included, the learner's area not). */
export function renderRecapNote(recap: SessionRecap, ctx: RecapRenderContext): DesiredNote {
	const lines: string[] = [
		frontmatter([
			["lh_managed", true],
			["lh_kind", "recap"],
			["lh_id", recap.chatId],
			["date", recap.sessionDate],
			["session", recap.title],
			["tags", ["session-recap", ...ctx.systems.map((s) => `system/${s}`)]],
			["lh_written", recap.generatedAt.slice(0, 10)],
		]),
		"",
		`# ${oneLine(recap.title)}`,
		"",
		`*Session recap for ${recap.sessionDate}, written ${recap.generatedAt.slice(0, 10)}. It holds only what that session covered; nothing was added from outside it.*`,
		"",
		"## Summary",
		"",
		recap.summary,
		"",
	];
	for (const topic of recap.topics) {
		lines.push(`## ${oneLine(topic.title)}`, "");
		for (const point of topic.points) lines.push(`- ${point}`);
		if (topic.points.length > 0) lines.push("");
		for (const table of topic.tables) lines.push(table.markdown, "");
		for (const figure of topic.figures) {
			lines.push(`![[${figure.file}|560]]`, `*${figure.caption}${figure.credit ? ` — ${figure.credit}` : " — drawn by LearnHarness"}*`, "");
		}
	}
	if (recap.misses.length > 0) {
		lines.push("## Where you went wrong or were unsure", "");
		for (const miss of recap.misses) {
			lines.push(`- **${miss.question.replace(/\n+/g, " ")}**`, `  - You said: ${miss.yours.replace(/\n+/g, " ")}`, `  - The session's answer: ${miss.correct.replace(/\n+/g, " ")}`);
		}
		lines.push("");
	}
	if (recap.selfTest.length > 0) {
		lines.push("## Self-test", "", "*Questions from this session. Answer from memory, then open the answer.*", "");
		recap.selfTest.forEach((q, i) => {
			lines.push(`**${i + 1}.** ${q.question.split("\n").join("  \n")}`, "", "> [!success]- Answer", ...quoted(q.answer), "");
		});
	}
	if (ctx.facts.length > 0) {
		lines.push("## Fact notes from this session", "", ...ctx.facts.map((f) => `- ${wikilink(f.stem, f.name)}`), "");
	}
	return { kind: "recap", id: recap.chatId, path: `${SESSION_RECAPS_DIR}/${ctx.stem ?? recapStem(recap.sessionDate, recap.title)}.md`, content: lines.join("\n").trimEnd() };
}

/** Graph facts that came up in this session (their provenance names the chat), oldest first. */
export function sessionFacts(nodes: readonly GraphNode[], chatId: string, max = 60): GraphNode[] {
	return nodes
		.filter((n) => n.provenance.some((p) => p.chatId === chatId))
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
		.slice(0, max);
}
