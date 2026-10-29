import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { Value } from "typebox/value";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { PlanTree, ProbeAssessment } from "../src/core/contracts.ts";
import { medicalProbeDoneInputSchema } from "../src/core/contracts/probe.ts";
import { inputAppends, ChatInputError } from "../src/core/input-events.ts";
import { medicalPlanNodes, medicalProbeAssessment, TEST_OUT_PHRASE, isTestOutRequest, isTestOutQuestion } from "../src/core/medical-teaching.ts";
import { parseProbeDoneInput } from "../src/core/tool-parts.ts";
import { danglingQuestionOf } from "../src/core/native-messages.ts";
import { planBlocksFor } from "../src/core/plan-blocks.ts";
import { PlanBlock, PlanPopup } from "../components/plan-block.tsx";
import { PlanMarginalia } from "../components/plan-window.tsx";
import { TestOutStep } from "../components/test-out-step.tsx";
import { ProbeDoneCard } from "../components/artifacts/probe-done-card.tsx";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-medical-edge-"));
process.env.LH_DATA_DIR = tmp;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const { composeInstructions } = await import("../src/agent/teacher-agent.ts");
const { planTools } = await import("../src/agent/tools/plan.ts");
const { probeDoneTool } = await import("../src/agent/tools/probe.ts");
const { chatStore } = await import("../src/store/chats.ts");

const assessment: ProbeAssessment = { strands: [
	{ strand: "recognition", status: "hold", assessment: "Recognises the pattern reliably." },
	{ strand: "drug choice", status: "shaky", assessment: "Unsure about choosing treatment." },
	{ strand: "escalation", status: "gap", assessment: "Missing the escalation decision." },
] };
function call(name: string, args: object, id = name): LhMessage {
	return { ...fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1], { id })], { stopReason: "toolUse" }), id: `m-${id}` } as LhMessage;
}
function result(name: string, details: object, id = name): LhMessage {
	return { id: `r-${id}`, role: "toolResult", toolCallId: id, toolName: name, content: [], details, isError: false, timestamp: 1 } as LhMessage;
}
const concluded = [call("probe_done", { assessment }), result("probe_done", { ok: true })];
const nodes = [
	{ id: "recognition", title: "Recognition" }, { id: "drug", title: "Drug choice" },
	{ id: "escalation", title: "Escalation" }, { id: "deeper", title: "Off-path physiology" },
];
const areas = [
	{ nodeId: "recognition", probeStrands: ["recognition"] },
	{ nodeId: "drug", probeStrands: ["drug choice"], reason: "Choose the safe first move." },
	{ nodeId: "escalation", probeStrands: ["escalation"] },
	{ nodeId: "deeper", group: "optional" as const },
];
const tree: PlanTree = { nodes: medicalPlanNodes(nodes, areas, assessment), edges: [], version: 1 };
const documentFor = (html: string) => parseHTML(`<html><body>${html}</body></html>`).document;

describe("medical probe verdict and planning", () => {
	it("requires hold/shaky/gap on every new area, retaining historical reads", () => {
		assert.ok(Value.Check(medicalProbeDoneInputSchema, { assessment }));
		assert.deepEqual(probeDoneTool({ chatId: "x", chatStore, deliver() {} }).probe_done!.parameters, medicalProbeDoneInputSchema);
		for (const status of [undefined, "strong", "", 1]) {
			const input = { assessment: { strands: [{ strand: "a", assessment: "evidence", status }] } };
			assert.equal(Value.Check(medicalProbeDoneInputSchema, input), false);
			if (status !== undefined) assert.equal(parseProbeDoneInput(input), undefined);
		}
		const legacy = { assessment: { strands: [{ strand: "a", assessment: "old evidence" }] } };
		assert.equal(parseProbeDoneInput(legacy)?.assessment.strands[0]?.status, undefined);
		assert.deepEqual(medicalProbeAssessment(concluded), assessment);
		assert.equal(medicalProbeAssessment([concluded[0]!, result("probe_done", { ok: false })]), undefined);
		assert.equal(medicalProbeAssessment([concluded[0]!]), undefined);
		for (const stopReason of ["error", "aborted"] as const) {
			assert.equal(medicalProbeAssessment([{ ...concluded[0]!, stopReason } as LhMessage, concluded[1]!]), undefined);
		}
	});

	it("builds the map from hold/shaky/gap; Optional stays off-path", async () => {
		const chat = chatStore.createChat("Phase 9 plan");
		chatStore.saveMessages(chat.id, concluded);
		const tool = planTools({ chatId: chat.id, chatStore }).plan_init!;
		const mermaid = "graph TD\nrecognition[Recognition] --> drug[Drug choice] --> escalation[Escalation]\ndeeper[Off-path physiology]";
		const reply = await tool.execute("plan", { mermaid, areas });
		assert.equal((reply.details as { ok: boolean }).ok, true);
		const saved = chatStore.getChat(chat.id)!.tree!;
		assert.deepEqual(saved.nodes.map((n) => n.group), ["already-yours", "to-build", "to-build", "optional"]);
		assert.deepEqual(saved.nodes[0]!.probeStrands, ["recognition"]);
		assert.equal(saved.nodes[1]!.summary, "Choose the safe first move.");
		const missing = await tool.execute("plan2", { mermaid });
		assert.equal((missing.details as { ok: boolean }).ok, false, "new verdict cannot silently lose grouping");
		assert.deepEqual(chatStore.getChat(chat.id)!.tree, saved, "invalid rewrites leave the plan intact");
		assert.throws(() => medicalPlanNodes(nodes, [...areas, areas[0]!], assessment), /Duplicate/);
		assert.throws(() => medicalPlanNodes(nodes, areas.slice(1), assessment), /Missing/);
		assert.throws(() => medicalPlanNodes(nodes, [{ nodeId: "absent" }], assessment), /Unknown area/);
		assert.throws(() => medicalPlanNodes(nodes, [{ nodeId: "drug", probeStrands: ["made up"] }], assessment), /Unknown probe strand/);
		assert.equal(medicalPlanNodes(nodes, [{ ...areas[0]!, group: "to-build" }, ...areas.slice(1)], assessment)[0]!.group, "to-build", "a missed test-out can revise hold");
		assert.deepEqual(medicalPlanNodes(nodes, undefined), nodes, "old sessions remain readable");
	});
});

describe("medical prompt amendment", () => {
	it("loads for teaching, after the upstream cadence; probing and practice stay unchanged", () => {
		const prompt = composeInstructions("teacher");
		assert.ok(prompt.includes("Faster, deeper medical teaching — amendment"));
		assert.ok(prompt.indexOf("# Faster, deeper") > prompt.indexOf("# The two questions"));
		for (const text of ["05-method.md", "28-predictions.md", "30-question-principles.md", "**Goal:**", "**Already yours:**", "**To build:**", "**Optional deeper:**", "**Rough time**", "faculty emphasises", "**Depth matches scope:**", "shared framework tying the conditions together", "must-know points, core pathophysiology and basic management", "never a vague list", "deep dives the learner can send to Tonight's questions", "a single-condition topic goes all the way down", "you judge which kind a topic is", "never stacks extra steps", "Right and confident", "Wrong or unsure", "one hard applied question", "right, move on; if wrong, teach"]) assert.ok(prompt.includes(text), text);
		assert.equal(composeInstructions("prober").includes("# Faster, deeper"), false);
		assert.equal(composeInstructions("practice").includes("# Faster, deeper"), false);
	});
});

describe("test-out button and phrase", () => {
	it("the tappable shared current-step button sends the same chat phrase", () => {
		let sent = "";
		const element = TestOutStep({ node: tree.nodes[1]!, disabled: false, onTest: (text) => { sent = text; } });
		const button = element.props.children[1];
		button.props.onClick();
		assert.equal(sent, TEST_OUT_PHRASE);
		const document = documentFor(renderToStaticMarkup(element));
		assert.match(document.body.textContent!, /Current step: Drug choice/);
		const rendered = document.querySelector("button")!;
		assert.ok(rendered.className.includes("min-h-11"));
		assert.doesNotMatch(rendered.className, /hidden/);
		assert.equal(rendered.hasAttribute("disabled"), false);
		assert.equal(documentFor(renderToStaticMarkup(<TestOutStep node={tree.nodes[1]!} disabled onTest={() => {}} />)).querySelector("button")!.hasAttribute("disabled"), true);
		const source = fs.readFileSync(path.join(import.meta.dirname, "../components/chat.tsx"), "utf8");
		assert.match(source, /stepAction=\{currentStep && <TestOutStep/);
		assert.match(source, /void send\(\{ type: "text", text \}\)/);
	});

	for (const tool of ["quiz", "explain"]) it(`the phrase atomically replaces a waiting ${tool} without grading it right`, () => {
		const question = call(tool, { nodeId: "drug", type: "predict", question: "Ordinary question?" }, "ordinary");
		const record = { tree, messages: [...concluded, question] };
		for (const text of [TEST_OUT_PHRASE, "I know this - test me", " i KNOW this – test me! "]) {
			assert.ok(isTestOutRequest(text));
			const appends = inputAppends(record, { type: "text", text });
			assert.equal(appends.length, 2);
			assert.equal(appends[0]!.role, "toolResult");
			assert.equal((appends[0] as unknown as { details: { dismissed: boolean } }).details.dismissed, true);
			assert.equal(appends[1]!.role, "user");
			assert.equal((appends[1] as { content: string }).content, text);
			assert.equal(danglingQuestionOf([...record.messages, ...appends]), null);
			const hard = call(tool, { nodeId: "drug", type: "check" }, "hard");
			const following = call(tool, { nodeId: "escalation", type: "check" }, "following");
			assert.equal(isTestOutQuestion([...record.messages, ...appends, hard], "hard"), true);
			assert.equal(isTestOutQuestion([...record.messages, ...appends, hard, result(tool, {}, "hard"), following], "following"), false);
		}
		assert.equal(inputAppends(record, { type: "text", text: "Can you explain that?" }).length, 1);
		assert.equal(inputAppends({ ...record, kind: "practice" }, { type: "text", text: TEST_OUT_PHRASE }).length, 1);
		assert.equal(inputAppends({ tree, messages: [question] }, { type: "text", text: TEST_OUT_PHRASE }).length, 1, "never change probing");
		assert.equal(inputAppends({ tree, messages: [...concluded, question, result(tool, {}, "ordinary")] }, { type: "text", text: TEST_OUT_PHRASE }).length, 1, "already answered needs no dismissal");
		assert.throws(() => inputAppends({ tree, messages: [...concluded, question, call("ask_user_question", {}, "preference")] }, { type: "text", text: TEST_OUT_PHRASE }), ChatInputError);
	});
});

describe("map groups", () => {
	it("keeps groups in the saved snapshot and labels nodes in every map surface", () => {
		const [snapshot] = planBlocksFor([], [result("plan_init", { ok: true })], tree, concluded);
		assert.ok(snapshot && snapshot.role === "custom" && snapshot.customType === "plan-block");
		const payload = (snapshot.details as unknown as { block: import("../src/core/contracts.ts").PlanBlockData }).block;
		assert.deepEqual(payload.nodes.map((n) => n.group), tree.nodes.map((n) => n.group));
		const messages = [{ parts: [{ type: "tool-plan_init", state: "output-available", output: { ok: true, tree } }] }];
		for (const html of [
			renderToStaticMarkup(<PlanBlock data={payload} onOpen={() => {}} />),
			renderToStaticMarkup(<PlanPopup messages={messages} onClose={() => {}} />),
			renderToStaticMarkup(<PlanMarginalia messages={messages} />),
		]) {
			const document = documentFor(html);
			for (const [id, group, label] of [["recognition", "already-yours", "Already yours"], ["drug", "to-build", "To build"], ["deeper", "optional", "Optional"]]) {
				const node = document.querySelector(`[data-testid="plan-node-${id}"]`)!;
				assert.equal(node.getAttribute("data-group"), group);
				assert.ok(node.textContent!.includes(label!), node.textContent!);
			}
		}
	});

	it("shows each verdict in the assessment card", () => {
		const html = renderToStaticMarkup(<ProbeDoneCard part={{ input: { assessment }, output: { ok: true }, state: "output-available" }} />);
		for (const status of ["hold", "shaky", "gap"]) assert.ok(html.includes(status));
	});
});
