/**
 * Real figures — the pure rules (src/core/figures.ts): which sites may be used,
 * when an image may be shown, and how a licence line is read. No network.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	FIGURE_CHAT_PATTERN,
	FIGURE_FILE_PATTERN,
	FIGURE_SOURCES,
	figureCreditLine,
	figureImageAllowed,
	figureImagePath,
	figureSourceById,
	figureSourceForPage,
	httpsUrl,
	readFigureLicence,
} from "../src/core/figures.ts";

describe("readFigureLicence", () => {
	it("reads a Creative Commons licence URL, with its version", () => {
		assert.deepEqual(readFigureLicence("https://creativecommons.org/licenses/by-nc-sa/3.0/"), {
			label: "CC BY-NC-SA 3.0",
			url: "https://creativecommons.org/licenses/by-nc-sa/3.0/",
		});
		assert.equal(readFigureLicence('<a rel="license" href="http://creativecommons.org/licenses/by/4.0/deed.en">')?.label, "CC BY 4.0");
		assert.equal(readFigureLicence("https://creativecommons.org/licenses/by-nc-nd/3.0/nz/")?.label, "CC BY-NC-ND 3.0");
	});

	it("reads licence labels as sources print them (Commons, Europe PMC)", () => {
		assert.equal(readFigureLicence("CC BY-SA 4.0")?.label, "CC BY-SA 4.0");
		assert.equal(readFigureLicence("cc by-nc")?.label, "CC BY-NC");
		assert.equal(readFigureLicence("cc by")?.label, "CC BY");
		assert.equal(readFigureLicence("CC-BY 2.0")?.label, "CC BY 2.0");
		assert.equal(readFigureLicence("CC0")?.label, "CC0");
		assert.equal(readFigureLicence("https://creativecommons.org/publicdomain/zero/1.0/")?.label, "CC0 1.0");
		assert.equal(readFigureLicence("Public domain")?.label, "Public domain");
		assert.equal(readFigureLicence("PD-US-expired")?.label, "Public domain");
	});

	it("reads nothing when no reusable licence is stated", () => {
		assert.equal(readFigureLicence(""), null);
		assert.equal(readFigureLicence("© 2026 PathologyOutlines.com. All rights reserved."), null);
		assert.equal(readFigureLicence("Non-free, fair use"), null);
		assert.equal(readFigureLicence("Copyrighted free use"), null);
		assert.equal(readFigureLicence("https://creativecommons.org/licenses/weird/9.9/"), null);
		assert.equal(readFigureLicence("Courtesy of Dr. X"), null);
	});
});

describe("the source allow-list", () => {
	it("matches a listed site and its subdomains, https only", () => {
		assert.equal(figureSourceForPage("https://radiopaedia.org/cases/pneumothorax")?.id, "radiopaedia");
		assert.equal(figureSourceForPage("https://www.nejm.org/doi/full/10.1056/NEJMicm1")?.id, "journal");
		assert.equal(figureSourceForPage("https://litfl.com/ecg-library/")?.id, "litfl");
		assert.equal(figureSourceForPage("http://radiopaedia.org/cases/x"), null, "plain http is refused");
		assert.equal(figureSourceForPage("https://evil.example/radiopaedia.org"), null);
		assert.equal(figureSourceForPage("https://radiopaedia.org.evil.example/x"), null, "a lookalike host is not a subdomain");
		assert.equal(figureSourceForPage("https://user:pw@radiopaedia.org/x"), null, "credentials in a URL are refused");
		assert.equal(figureSourceForPage("not a url"), null);
	});

	it("journals and PathologyOutlines are link only: no image host at all", () => {
		for (const id of ["journal", "pathologyoutlines"]) {
			const source = figureSourceById(id)!;
			assert.equal(source.embed, "never");
			assert.equal(figureImageAllowed(source, "https://www.nejm.org/na101/home/literatum/x.jpg"), false);
			assert.equal(figureImageAllowed(source, `https://${source.pageHosts[0]}/img.jpg`), false);
		}
	});

	it("an image may only come from its own source's image hosts", () => {
		const commons = figureSourceById("commons")!;
		assert.equal(figureImageAllowed(commons, "https://upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg"), true);
		assert.equal(figureImageAllowed(commons, "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/800px-X.jpg"), true);
		assert.equal(figureImageAllowed(commons, "http://upload.wikimedia.org/x.jpg"), false);
		assert.equal(figureImageAllowed(commons, "https://example.com/x.jpg"), false);
		const litfl = figureSourceById("litfl")!;
		assert.equal(figureImageAllowed(litfl, "https://i0.wp.com/litfl.com/wp-content/uploads/ecg.jpg"), true, "LITFL's own image CDN path");
		assert.equal(figureImageAllowed(litfl, "https://i0.wp.com/someoneelse.com/wp-content/uploads/ecg.jpg"), false, "a shared CDN only for LITFL's path");
	});

	it("every source declares the tier it is looked in", () => {
		const tiers = new Set(FIGURE_SOURCES.map((s) => s.tier));
		for (const tier of ["radiopaedia", "commons", "open-journal", "specialty", "journal-link"] as const) assert.ok(tiers.has(tier), tier);
	});
});

describe("small helpers", () => {
	it("httpsUrl accepts plain https only", () => {
		assert.ok(httpsUrl("https://commons.wikimedia.org/x"));
		assert.equal(httpsUrl("file:///etc/passwd"), null);
		assert.equal(httpsUrl("data:image/png;base64,AAAA"), null);
		assert.equal(httpsUrl("javascript:alert(1)"), null);
	});

	it("credit line names the author and the source", () => {
		assert.equal(figureCreditLine({ author: "  Jane  Roe ", source: "Wikimedia Commons" }), "Jane Roe, via Wikimedia Commons");
		assert.equal(figureCreditLine({ source: "Radiopaedia", title: "Pneumothorax" }), "Pneumothorax, via Radiopaedia");
	});

	it("cache names are only ever hex keys under a chat folder", () => {
		assert.ok(FIGURE_FILE_PATTERN.test("0123456789abcdef01234567.png"));
		assert.equal(FIGURE_FILE_PATTERN.test("../../etc/passwd"), false);
		assert.equal(FIGURE_FILE_PATTERN.test("0123456789abcdef01234567.svg"), false);
		assert.ok(FIGURE_CHAT_PATTERN.test("chat_mv27rrra_feff23b6"));
		assert.equal(FIGURE_CHAT_PATTERN.test("../chat_x_y"), false);
		assert.equal(figureImagePath("chat_a_b", "0123456789abcdef01234567.png"), "/api/figures/chat_a_b/0123456789abcdef01234567.png");
	});
});
