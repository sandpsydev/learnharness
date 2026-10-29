import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { CaptureBox, CaptureRow, NO_PATIENT_IDENTIFIERS } from "../components/captures.tsx";
import type { useCaptures } from "../components/captures.tsx";

const noop = async () => {};
const state = {
	captures: [], error: null, busyId: null,
	add: async () => null, markDone: noop, remove: noop, start: noop, refresh: noop,
} as unknown as ReturnType<typeof useCaptures>;
const documentFor = (node: React.ReactNode) => parseHTML(`<html><body>${renderToStaticMarkup(node)}</body></html>`).document;

describe("capture box", () => {
	it("is text only: one text area, the patient-identifier reminder, no file or photo control", () => {
		const document = documentFor(<CaptureBox state={state} />);
		assert.equal(document.querySelectorAll("textarea").length, 1);
		assert.equal(document.querySelectorAll('input[type="file"]').length, 0);
		assert.equal(document.querySelectorAll("input").length, 0);
		assert.ok(document.querySelector('[data-testid="capture-privacy"]')!.textContent!.includes(NO_PATIENT_IDENTIFIERS));
		assert.match(NO_PATIENT_IDENTIFIERS, /No patient identifiers/);
	});

	it("uses 16px text so a phone browser doesn't zoom on focus", () => {
		assert.ok(documentFor(<CaptureBox state={state} />).querySelector("textarea")!.className.includes("text-base"));
	});
});

describe("capture row", () => {
	it("offers start, done and delete", () => {
		const capture = { id: "cp_a_00000000", text: "Why is the QT long?", status: "open" as const, createdAt: "", updatedAt: "" };
		const document = documentFor(<ul><CaptureRow capture={capture} actions={state} /></ul>);
		assert.ok(document.body.textContent!.includes("Why is the QT long?"));
		for (const id of ["capture-start", "capture-done", "capture-delete"]) {
			assert.ok(document.querySelector(`[data-testid="${id}"]`), id);
		}
	});
});
