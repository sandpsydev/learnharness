/**
 * Teaching v2 prompt pins: check sets, one-concept steps, first-pass depth, drug
 * introductions and medical figures. Wording lives in src/agent/prompts/;
 * these pins keep the rules from silently dropping out of the composed
 * teacher prompt (and keep the probe and practice prompts free of them).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-teaching-v2-"));
process.env.LH_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const { composeInstructions } = await import("../src/agent/teacher-agent.ts");

const teacher = composeInstructions("teacher");

describe("teaching v2 prompt rules", () => {
	it("a step is one small concept and is checked with a set, not a single check", () => {
		for (const text of [
			"One step, one small concept",
			"**A step is one small concept**",
			"One step, one check set",
			"check set of `quiz` calls",
			"the checks that follow the teaching form one set in one turn",
		]) assert.ok(teacher.includes(text), text);
		assert.equal(teacher.includes("One step, one coherent chunk"), false);
		assert.equal(teacher.includes("fewer, fuller steps"), false);
		assert.equal(teacher.includes("bigger chunks still"), false);
		assert.equal(teacher.includes("earns a bigger next step"), false);
		assert.equal(teacher.includes("One step, one fact."), false);
		assert.equal(teacher.includes("One step, one check."), false);
	});

	it("the teacher is told who the learner is; trial names are not evidence unless asked (04-whoami.md)", () => {
		for (const text of [
			"Who you are teaching",
			"their own faculty's lecture slides",
			"which treatment for whom, and why",
			"Teach the take-home message concisely",
			"Do not cite trial names, PMIDs or trial statistics as evidence unless the learner asks for them",
			"The learner sees only your visible messages, never your thinking. Teach a step in a visible message before you check it.",
			"give the key takeaway behind its placement",
		]) assert.ok(teacher.includes(text), text);
		assert.equal(teacher.includes("explain the actual trial"), false);
		for (const agent of ["prober", "practice"] as const) assert.equal(composeInstructions(agent).includes("Who you are teaching"), false, agent);
	});

	it("each step opens with a plain summary sentence, look-alikes share one table, the teacher keeps going after the last answer, sections close with a short summary (2026-11-18)", () => {
		for (const text of [
			"Say where the lesson is",
			"never an abstract framing",
			"contrast only two things the learner would truly confuse",
			"Look-alikes and sibling conditions, tests or drugs go in one table",
			"Keep going after the last answer",
			"carry straight on into the next step in the same turn",
			"2-4 line plain summary",
		]) assert.ok(teacher.includes(text), text);
		assert.equal(teacher.includes("don't announce the choreography"), false);
	});

	it("a prediction stays one question per turn and never joins a set", () => {
		assert.ok(teacher.includes("A prediction is one question in its own turn"));
	});

	it("a first pass is bird's-eye first, complete, and hands specialist detail to Optional", () => {
		for (const text of ["Overview first", "urgency", "Specialist detail is Optional deeper", "never a sample", "Must-know checklist", "The plan is your judgement"]) {
			assert.ok(teacher.includes(text), text);
		}
	});

	it("a check set is shown one question at a time, and the plan is complete and right first time", () => {
		for (const text of [
			"one at a time, each only after the previous is answered",
			"each only after the previous is answered",
			"must be complete and right the first time",
			"only ever adds points they heard in a lecture or on ward rounds",
			"ask for a go-ahead, never what to include",
		]) assert.ok(teacher.includes(text), text);
	});

	it("classification grids are a preferred figure when a topic has two natural axes", () => {
		for (const text of ["Classification grids are a preferred figure", "two natural axes", "surgical jaundice"]) assert.ok(teacher.includes(text), text);
	});

	it("the first time a drug comes up it gets a class and mechanism introduction", () => {
		assert.ok(teacher.includes("A drug gets a short introduction the first time it comes up"));
		assert.ok(teacher.includes("tagged pharmacology"));
	});

	it("medical figures: no biology toy demos, sourced flowcharts only, never anatomy", () => {
		for (const text of ["No toy simulations of biology", "Comparison tables first", "only when sourced", "Mechanism chains stay short", "Never draw anatomy"]) {
			assert.ok(teacher.includes(text), text);
		}
	});

	it("the probe and practice prompts do not carry the teacher's rules", () => {
		for (const agent of ["prober", "practice"] as const) {
			const prompt = composeInstructions(agent);
			assert.equal(prompt.includes("One small concept, then a check set"), false, agent);
			assert.equal(prompt.includes("Planning a first pass"), false, agent);
		}
	});
});
