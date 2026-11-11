/**
 * Table sizing (app/globals.css), QA 2026-11-12: tables hug their contents but
 * never run wider than the column when their cells can wrap — the live case was
 * a two-column coverage table measuring 1894px in a 358px phone column. Wide
 * tables still scroll (cells keep a readable minimum) instead of squeezing.
 * Layout itself is checked in a browser; this pins the rules that produce it.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const css = fs.readFileSync(path.join(import.meta.dirname, "..", "app", "globals.css"), "utf-8");
const block = (selector: string): string => {
	const at = css.indexOf(`${selector} {`);
	assert.ok(at >= 0, `missing rule ${selector}`);
	return css.slice(at, css.indexOf("}", at));
};

describe("markdown tables on a narrow column", () => {
	it("hug their contents but are capped at the column width", () => {
		const table = block('[data-streamdown="table"]');
		assert.match(table, /width: max-content;/);
		assert.match(table, /max-width: 100%;/);
	});

	it("give every cell a readable minimum, so a wide table scrolls instead of squeezing", () => {
		assert.match(block('[data-streamdown="table"] :where(th, td)'), /min-width: 8\.5rem;/);
	});

	it("let headers wrap", () => {
		assert.match(block('[data-streamdown="table"] th'), /white-space: normal;/);
	});
});
