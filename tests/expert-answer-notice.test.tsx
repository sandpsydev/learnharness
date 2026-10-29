import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { pendingExpertAnswerNotice, QueuedSteersBody } from "../components/queued-steers.tsx";
import { buildSubagentSteer, type JobRecord } from "../src/core/contracts/jobs.ts";

const answer = (id: string, patch: Partial<JobRecord> = {}): JobRecord => ({
	id, kind: "research", chatId: "session", toolCallId: `verify_${id}`,
	status: "done", activity: "finished", createdAt: "", updatedAt: "",
	delivery: { kind: "result", status: "pending" }, ...patch,
});

const render = (jobs: JobRecord[]) => renderToStaticMarkup(
	<QueuedSteersBody steers={[]} notice={pendingExpertAnswerNotice(jobs, "session", [])} />,
);

it("shows a quiet receipt for one returned answer and plural wording for several", () => {
	assert.equal(pendingExpertAnswerNotice([answer("a")], "session", []),
		"Expert AI answer received — your teacher will use it in its next reply");
	assert.equal(pendingExpertAnswerNotice([answer("a"), answer("b")], "session", []),
		"Expert AI answers received — your teacher will use them in its next reply");
	const document = parseHTML(render([answer("a")])).document;
	const status = document.querySelector('[role="status"]')!;
	assert.ok(status);
	assert.ok(status.className.includes("whitespace-normal"), "the full message wraps on phones");
	assert.ok(!status.className.includes("truncate"));
	assert.doesNotMatch(render([answer("a")]), /(?:sm:|max-sm:).*hidden|<button|role="alert"/);
});

it("clears when the teacher picks up the marker, even before delivery bookkeeping refreshes", () => {
	const job = answer("a");
	const marker = buildSubagentSteer(job, { brief: "Evidence", sources: [] });
	assert.equal(pendingExpertAnswerNotice([job], "session", [marker]), null);
	assert.equal(render([answer("a", { delivery: { kind: "result", status: "delivered" } })]), "");
	assert.equal(render([]), "");
});

it("keeps plural or singular wording for only the answers still waiting", () => {
	const jobs = [answer("a"), answer("b")];
	const marker = buildSubagentSteer(jobs[0]!, { brief: "Evidence", sources: [] });
	assert.match(pendingExpertAnswerNotice(jobs, "session", [marker])!, /answer received.*use it/);
});

it("excludes other sessions, highlights, ordinary research, aborts and legacy jobs", () => {
	assert.equal(render([
		answer("other", { chatId: "other-session" }),
		answer("highlight", { toolCallId: "highlight_h1" }),
		answer("research", { toolCallId: "call_research" }),
		answer("abort", { delivery: { kind: "abort", status: "pending" } }),
		answer("legacy", { delivery: undefined }),
	]), "");
});

it("shares the existing notice surface with queued learner messages", () => {
	const markup = renderToStaticMarkup(<QueuedSteersBody
		steers={[{ id: "learner", text: "Queued learner message" }]}
		notice={pendingExpertAnswerNotice([answer("a")], "session", [])}
	/>);
	assert.match(markup, /Expert AI answer received/);
	assert.match(markup, /Queued learner message/);
});
