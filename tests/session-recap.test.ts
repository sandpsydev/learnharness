/**
 * Session recap, the pure core (medical fork): what the writer is shown (only
 * the session), the check on what it hands back, the note it becomes, and the
 * file naming. No model, no filesystem.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionRecap } from "../src/core/contracts.ts";
import { MY_NOTES_MARKER, readManagedHeader, SESSION_RECAPS_DIR } from "../src/core/obsidian.ts";
import {
	RECAP_LIMITS,
	assembleTranscript,
	figureAssetName,
	questionBlock,
	recapStem,
	renderRecapNote,
	sessionDateOf,
	sessionFacts,
	splitTables,
	transcriptTooLong,
	validateRecap,
} from "../src/core/session-recap.ts";
import { CHAT_ID, FIGURE_FILE, TABLE, quizAnswer, sessionMessages, teacher, user } from "./recap-fixtures.ts";

const assemble = (messages = sessionMessages(), cached = true) => assembleTranscript(messages, { chatId: CHAT_ID, hasCachedFigure: () => cached });

describe("splitTables", () => {
	it("pulls a Markdown table out of prose and keeps the prose either side", () => {
		const parts = splitTables(`Before.\n\n${TABLE}\n\nAfter.`);
		assert.deepEqual(parts.map((p) => p.table), [false, true, false]);
		assert.equal(parts[1]!.text, TABLE);
	});

	it("does not mistake a pipe in prose, or a table inside a code fence, for a table", () => {
		assert.equal(splitTables("a | b is not a table\n\nnor is this").every((p) => !p.table), true);
		assert.equal(splitTables(`\`\`\`\n${TABLE}\n\`\`\``).every((p) => !p.table), true);
	});
});

describe("assembleTranscript — only the session", () => {
	const t = assemble();

	it("numbers every spoken part and says who spoke", () => {
		assert.match(t.text, /\[T1\] LEARNER:\nTeach me how loop diuretics work\./);
		assert.match(t.text, /\[T2\] TEACHER:\nLoop diuretics block NKCC2/);
		assert.equal(t.teacherTurns, 3);
	});

	it("labels the table and keeps it whole", () => {
		assert.match(t.text, /\[TABLE K1\]\n\| Drug \| Mechanism \|/);
		assert.match(t.text, /\[END TABLE K1\]/);
		assert.equal(t.tables.get("K1")!.markdown, TABLE);
	});

	it("shows an answered check with the learner's answer, the result, the right answer and the explanation", () => {
		assert.match(t.text, /CHECK QUESTION: Which transporter does furosemide block\?/);
		assert.match(t.text, /The learner answered: NCC/);
		assert.match(t.text, /Result: incorrect\./);
		assert.match(t.text, /The correct answer: NKCC2/);
		assert.match(t.text, /The explanation the learner was shown: Furosemide acts on NKCC2/);
	});

	it("shows a skipped question as skipped, with no answer and no explanation", () => {
		assert.match(t.text, /Which ion shift causes the hypokalaemia\?\nThe learner skipped this question\./);
	});

	it("offers the real figure with the caption the card showed, and a drawn one to be named by the writer", () => {
		assert.match(t.text, /FIGURE F1, a real picture shown to the learner: Left pneumothorax on an erect chest X-ray\. Key feature to find: The visceral pleural line/);
		assert.match(t.text, /FIGURE F2, a diagram the app drew/);
		const real = t.figures.get("F1")!;
		assert.equal(real.kind, "image");
		assert.equal(real.credit, "Dr Example, via Radiopaedia · CC BY-NC-SA 3.0");
		assert.equal(real.file, figureAssetName(CHAT_ID, { cacheFile: FIGURE_FILE }));
		assert.equal(t.figures.get("F2")!.kind, "drawn");
	});

	it("leaves out a figure whose picture is no longer cached", () => {
		const gone = assemble(sessionMessages(), false);
		assert.ok(!gone.text.includes("FIGURE F1, a real picture"));
		assert.equal([...gone.figures.values()].some((f) => f.kind === "image"), false);
	});

	it("carries nothing but the session: no graph, library or Expert AI text exists in its inputs", () => {
		// The assembler takes the messages and a figure-cache predicate and nothing else.
		assert.equal(assembleTranscript.length, 2);
		assert.ok(!/UpToDate|library|graph/i.test(t.text));
	});

	it("leaves out failed tool results, bookkeeping markers and unanswered work", () => {
		const messages = [
			...sessionMessages(),
			{ id: "x1", role: "toolResult", toolCallId: "c", toolName: "quiz", content: [], details: quizAnswer(), isError: true, timestamp: 1 },
			{ id: "x2", role: "custom", customType: "graph-context", content: "SECRET graph context", display: false, details: {}, timestamp: 1 },
			{ id: "x3", role: "custom", customType: "probe-handoff", content: "SECRET handoff", display: true, details: {}, timestamp: 1 },
		] as never[];
		const text = assemble(messages).text;
		assert.ok(!text.includes("SECRET"));
		assert.equal(text.match(/CHECK QUESTION/g)!.length, 2); // the two real ones; the errored result adds none
	});

	it("clips every message harder, step by step, before giving up on a very long session", () => {
		const long = Array.from({ length: 60 }, (_, i) => teacher(`t${i}`, "x".repeat(20_000)));
		const t2 = assemble([user("u", "go"), ...long] as never[]);
		assert.ok(t2.clippedTo < RECAP_LIMITS.messageClips[0]);
		assert.equal(transcriptTooLong(t2), t2.text.length > RECAP_LIMITS.transcriptChars);
		const huge = assemble(Array.from({ length: 700 }, (_, i) => teacher(`h${i}`, "y".repeat(20_000))) as never[]);
		assert.equal(transcriptTooLong(huge), true);
	});
});

describe("questionBlock", () => {
	it("marks a prediction as asked before the teaching and a recall as in the learner's own words", () => {
		assert.match(questionBlock(quizAnswer({ questionType: "predict" }), "quiz")!, /PREDICTION QUESTION \(asked before the teaching/);
		const recall = questionBlock({ ...quizAnswer(), kind: "explain", options: undefined, answers: [], text: "It blocks NKCC2.", committed: "Blocks NKCC2", correct: undefined, correctIndices: undefined }, "explain")!;
		assert.match(recall, /RECALL CHECK/);
		assert.match(recall, /The learner answered: It blocks NKCC2\./);
		assert.match(recall, /The answer the teacher had committed to: Blocks NKCC2/);
	});

	it("says a don't-know as one", () => {
		assert.match(questionBlock(quizAnswer({ dontKnow: true, answers: [] }), "quiz")!, /The learner answered: I don't know\./);
	});

	it("returns nothing for a payload with no question", () => {
		assert.equal(questionBlock(undefined, "quiz"), null);
	});
});

describe("validateRecap — nothing the session didn't have", () => {
	const t = assemble();
	const good = () => ({
		summary: "Loop diuretics and where they act.",
		fitsTogether: { text: "Loop diuretics act on NKCC2, which is why they cause a large diuresis.", turns: [2, 3] },
		highYield: [{ text: "Furosemide blocks NKCC2.", turns: [2] }],
		understandFirst: [{ text: "Why NCC is the wrong transporter for a loop diuretic.", turns: [3, 4] }],
		topics: [{ title: "Loop diuretics", points: [{ text: "They block NKCC2 in the thick ascending limb.", turns: [2] }], tables: ["K1"], figures: ["F1", { id: "F2", caption: "The nephron" }] }],
		misses: [{ question: "Which transporter does furosemide block?", yours: "NCC", correct: "NKCC2", turns: [3, 4] }],
		selfTest: [{ question: "Which transporter does furosemide block?", answer: "NKCC2", turns: [3] }],
	});

	it("accepts a draft whose every part names real turns, tables and figures, and copies the table and figure data from the record", () => {
		const r = validateRecap(good(), t);
		assert.ok(r.ok, r.ok ? "" : r.problems.join());
		if (!r.ok) return;
		const topic = r.recap.topics[0]!;
		assert.equal(topic.tables[0]!.markdown, TABLE);
		assert.equal(topic.figures[0]!.caption, "Left pneumothorax on an erect chest X-ray.");
		assert.equal(topic.figures[0]!.credit, "Dr Example, via Radiopaedia · CC BY-NC-SA 3.0");
		assert.equal(topic.figures[1]!.caption, "The nephron");
		assert.equal(topic.figures[1]!.credit, "");
		assert.equal(r.recap.fitsTogether, "Loop diuretics act on NKCC2, which is why they cause a large diuresis.");
		assert.deepEqual(r.recap.highYield, ["Furosemide blocks NKCC2."]);
		assert.deepEqual(r.recap.understandFirst, ["Why NCC is the wrong transporter for a loop diuretic."]);
	});

	it("refuses how-it-fits, high-yield and understand-first parts that name no turn or a turn not in the session; all three may be left out", () => {
		const bad = good() as Record<string, unknown>;
		bad.fitsTogether = { text: "A link nobody made.", turns: [] };
		bad.highYield = [{ text: "A fact.", turns: [99] }, { text: "", turns: [2] }];
		bad.understandFirst = [{ text: "A concept.", turns: [] }];
		const r = validateRecap(bad, t);
		assert.ok(!r.ok);
		if (r.ok) return;
		const all = r.problems.join("\n");
		assert.match(all, /fitsTogether: name the turn numbers/);
		assert.match(all, /highYield\[0\].*turn 99 is not in the session/);
		assert.match(all, /highYield\[1\]: empty text/);
		assert.match(all, /understandFirst\[0\]: name the turn numbers/);
		const bare = good() as Record<string, unknown>;
		delete bare.fitsTogether;
		delete bare.highYield;
		delete bare.understandFirst;
		const ok = validateRecap(bare, t);
		assert.ok(ok.ok);
		if (ok.ok) assert.deepEqual([ok.recap.fitsTogether, ok.recap.highYield, ok.recap.understandFirst], ["", [], []]);
	});

	it("refuses a point that names no turn, or a turn that is not in the session", () => {
		const bad = good();
		bad.topics[0]!.points = [{ text: "A made-up fact.", turns: [] }, { text: "Another.", turns: [99] }];
		const r = validateRecap(bad, t);
		assert.ok(!r.ok);
		if (r.ok) return;
		assert.ok(r.problems.some((p) => /points\[0\].*name the turn numbers/.test(p)));
		assert.ok(r.problems.some((p) => /points\[1\].*turn 99 is not in the session/.test(p)));
	});

	it("refuses a table or figure the session never showed", () => {
		const bad = good();
		bad.topics[0]!.tables = ["K9"];
		bad.topics[0]!.figures = ["F7"];
		const r = validateRecap(bad, t);
		assert.ok(!r.ok);
		if (r.ok) return;
		assert.ok(r.problems.some((p) => /"K9" is not a table of this session/.test(p)));
		assert.ok(r.problems.some((p) => /"F7" is not a figure of this session/.test(p)));
	});

	it("asks for a caption on a drawn diagram", () => {
		const bad = good();
		bad.topics[0]!.figures = ["F2"];
		const r = validateRecap(bad, t);
		assert.ok(!r.ok);
		if (r.ok) return;
		assert.ok(r.problems.some((p) => /F2 is a drawn diagram; give it a short "caption"/.test(p)));
	});

	it("needs a summary, a topic with something in it, and turns on every miss and self-test question", () => {
		const r = validateRecap({ summary: " ", topics: [{ title: "Empty", points: [] }], misses: [{ question: "q", yours: "a", correct: "b" }], selfTest: [{ question: "q", answer: "a", turns: [1] }, { question: "", answer: "a", turns: [1] }] }, t);
		assert.ok(!r.ok);
		if (r.ok) return;
		const all = r.problems.join("\n");
		assert.match(all, /summary: write a short summary/);
		assert.match(all, /"Empty" has no points, tables or figures/);
		assert.match(all, /misses\[0\]: name the turn numbers/);
		assert.match(all, /selfTest\[1\]: needs a question and its answer/);
	});

	it("takes new picture requests that name turns, and refuses ones that don't, and more than five", () => {
		const ok = good() as Record<string, unknown>;
		(ok.topics as Array<Record<string, unknown>>)[0]!.pictures = [{ concept: "Renal stones", modality: "stone photograph", caption: "Calcium oxalate stones are spiculated.", diagram: "A stone, labelled spiculated.", turns: [2] }];
		const accepted = validateRecap(ok, t);
		assert.ok(accepted.ok);
		if (accepted.ok) assert.deepEqual(accepted.recap.topics[0]!.pictures, [{ concept: "Renal stones", caption: "Calcium oxalate stones are spiculated.", modality: "stone photograph", diagram: "A stone, labelled spiculated." }]);

		const bad = good() as Record<string, unknown>;
		(bad.topics as Array<Record<string, unknown>>)[0]!.pictures = [{ concept: "", caption: "", turns: [] }, ...Array.from({ length: 6 }, (_, i) => ({ concept: `c${i}`, caption: `k${i}`, turns: [2] }))];
		const refused = validateRecap(bad, t);
		assert.ok(!refused.ok);
		if (refused.ok) return;
		const all = refused.problems.join("\n");
		assert.match(all, /pictures\[0\]: needs a concept/);
		assert.match(all, /pictures\[0\]: name the turn numbers/);
		assert.match(all, /at most 5 new pictures/);
	});

	it("uses a table or figure once even when two topics ask for it", () => {
		const draft = good();
		draft.topics.push({ title: "Again", points: [{ text: "NKCC2 again.", turns: [2] }], tables: ["K1"], figures: ["F1"] });
		const r = validateRecap(draft, t);
		assert.ok(r.ok);
		if (!r.ok) return;
		assert.equal(r.recap.topics[1]!.tables.length, 0);
		assert.equal(r.recap.topics[1]!.figures.length, 0);
	});
});

describe("naming", () => {
	it("is the date, a space and the session title, made safe", () => {
		assert.equal(recapStem("2026-11-10", "Loop diuretics"), "2026-11-10 Loop diuretics");
		assert.equal(recapStem("2026-11-10", 'AKI: pre/post "renal" #1'), "2026-11-10 AKI- pre-post renal 1");
		assert.equal(recapStem("2026-11-10", "   "), "2026-11-10 Session");
	});

	it("takes the session's start date from its creation time", () => {
		assert.equal(sessionDateOf("2026-11-10T23:59:00.000Z"), "2026-11-10");
	});
});

describe("renderRecapNote", () => {
	const recap = (): SessionRecap => {
		const r = validateRecap(
			{
				summary: "Loop diuretics and where they act.",
				fitsTogether: { text: "Loop diuretics act on NKCC2, so they cause a large diuresis.", turns: [2] },
				highYield: [{ text: "Furosemide blocks NKCC2.", turns: [2] }],
				understandFirst: [{ text: "Why NCC is the wrong transporter.", turns: [3] }],
				topics: [{ title: "Loop diuretics", points: [{ text: "They block NKCC2.", turns: [2] }], tables: ["K1"], figures: ["F1"] }],
				misses: [{ question: "Which transporter does furosemide block?", yours: "NCC", correct: "NKCC2", turns: [3] }],
				selfTest: [{ question: "Which transporter does furosemide block?", answer: "NKCC2\nin the thick ascending limb", turns: [3] }],
			},
			assemble(),
		);
		assert.ok(r.ok);
		if (!r.ok) throw new Error("unreachable");
		return { chatId: CHAT_ID, title: "Loop diuretics", sessionDate: "2026-11-10", generatedAt: "2026-11-12T08:00:00.000Z", messageCount: 9, ...r.recap, usage: { calls: 1, inputTokens: 1, outputTokens: 1 } };
	};

	it("carries the managed header, the date, the session title and tags", () => {
		const note = renderRecapNote(recap(), { facts: [], systems: ["renal"] });
		assert.deepEqual(readManagedHeader(note.content), { kind: "recap", id: CHAT_ID });
		assert.match(note.content, /date: "2026-11-10"/);
		assert.match(note.content, /session: "Loop diuretics"/);
		assert.match(note.content, /tags:\n {2}- session-recap\n {2}- system\/renal/);
		assert.equal(note.path, `${SESSION_RECAPS_DIR}/2026-11-10 Loop diuretics.md`);
	});

	it("has a summary, the topic with its points, the table as written, the figure with its credit, the misses and a self-test with hidden answers", () => {
		const text = renderRecapNote(recap(), { facts: [], systems: [] }).content;
		assert.match(text, /## Summary\n\nLoop diuretics and where they act\./);
		assert.match(text, /## Summary\n\nLoop diuretics and where they act\.\n\n## How it fits together\n\nLoop diuretics act on NKCC2, so they cause a large diuresis\.\n\n## High-yield to remember\n\n- Furosemide blocks NKCC2\.\n\n## Understand before continuing\n\n- Why NCC is the wrong transporter\.\n\n## Loop diuretics/);
		assert.match(text, /## Loop diuretics\n\n- They block NKCC2\./);
		assert.ok(text.includes(TABLE));
		assert.match(text, new RegExp(`!\\[\\[recap-[a-z0-9]+-${FIGURE_FILE.replace(".", "\\.")}\\|560\\]\\]\\n\\*Left pneumothorax on an erect chest X-ray\\. — Dr Example, via Radiopaedia · CC BY-NC-SA 3\\.0\\*`));
		assert.match(text, /## Where you went wrong or were unsure\n\n- \*\*Which transporter does furosemide block\?\*\*\n {2}- You said: NCC\n {2}- The session's answer: NKCC2/);
		assert.match(text, /## Self-test[\s\S]*\*\*1\.\*\* Which transporter does furosemide block\?\n\n> \[!success\]- Answer\n> NKCC2\n> in the thick ascending limb/);
	});

	it("links the fact notes from this session, and only when there are some", () => {
		const without = renderRecapNote(recap(), { facts: [], systems: [] }).content;
		assert.ok(!without.includes("Fact notes from this session"));
		const withFacts = renderRecapNote(recap(), { facts: [{ stem: "Furosemide blocks NKCC2", name: "Furosemide blocks NKCC2" }], systems: [] }).content;
		assert.match(withFacts, /## Fact notes from this session\n\n- \[\[Furosemide blocks NKCC2\]\]/);
	});

	it("leaves out the sections the session had nothing for, and has no My-notes marker of its own", () => {
		const r = recap();
		r.misses = [];
		r.selfTest = [];
		delete r.fitsTogether;
		r.highYield = [];
		delete r.understandFirst;
		const text = renderRecapNote(r, { facts: [], systems: [] }).content;
		assert.ok(!text.includes("Where you went wrong") && !text.includes("Self-test"));
		assert.ok(!text.includes("How it fits together") && !text.includes("High-yield") && !text.includes("Understand before continuing"));
		assert.ok(!text.includes(MY_NOTES_MARKER));
	});
});

describe("sessionFacts", () => {
	it("picks the graph facts whose provenance names this session", () => {
		const node = (id: string, chatId: string) => ({ id, name: id, statement: "s", aliases: [], createdAt: `2026-10-0${id.slice(-1)}T00:00:00.000Z`, provenance: [{ chatId, messageId: "m" }] });
		const picked = sessionFacts([node("n_2", CHAT_ID), node("n_1", CHAT_ID), node("n_3", "chat_other")], CHAT_ID);
		assert.deepEqual(picked.map((n) => n.id), ["n_1", "n_2"]);
	});
});
