/**
 * Teaching v2 prompt pins: check sets, fuller steps, first-pass depth, drug
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
	it("a step is a fuller chunk and is checked with a set, not a single check", () => {
		for (const text of [
			"One step, one coherent chunk",
			"One step, one check set",
			"check set of `quiz` calls",
			"the checks that follow the teaching form one set in one turn",
		]) assert.ok(teacher.includes(text), text);
		assert.equal(teacher.includes("One step, one fact."), false);
		assert.equal(teacher.includes("One step, one check."), false);
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
			assert.equal(prompt.includes("Fuller steps, then a check set"), false, agent);
			assert.equal(prompt.includes("Planning a first pass"), false, agent);
		}
	});
});
