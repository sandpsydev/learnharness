/** What counts as "the same picture" for the no-repeat rule (core/figure-duplicates.ts): pure, no I/O. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findRepeat, isRepeat, type FigureCandidateShape } from "../src/core/figure-duplicates.ts";
import { cardRefOf, parseFigureNumber, type FigureCardRef } from "../src/core/figure-refs.ts";
import type { FigureResult } from "../src/core/contracts.ts";

const TITLE = "Sabiston (2021) p.849";

function card(over: { caption?: string; title?: string; file?: string; crop?: { top: number; bottom: number }; tier?: "slides" | "commons" }): FigureCardRef {
	const result: FigureResult = {
		concept: "x",
		outcome: "image",
		caption: over.caption ?? "A figure.",
		keyFeature: "",
		links: [],
		brief: "",
		image: {
			file: over.file ?? "a".repeat(24) + ".png",
			mime: "image/png",
			tier: over.tier ?? "slides",
			source: "Your library",
			title: over.title ?? TITLE,
			credit: "",
			licence: "",
			...(over.crop ? { crop: over.crop } : {}),
		},
	};
	return cardRefOf(result, "m1")!;
}

const cand = (over: Partial<FigureCandidateShape>): FigureCandidateShape => ({
	file: "b".repeat(24) + ".png",
	library: true,
	title: TITLE,
	crop: null,
	number: null,
	...over,
});
const n = (raw: string) => parseFigureNumber(raw);

describe("is this picture one the chat already shows?", () => {
	it("the same cached file always is, library or not", () => {
		assert.equal(isRepeat(card({ file: "c".repeat(24) + ".jpg", tier: "commons", title: "File:X" }), cand({ file: "c".repeat(24) + ".jpg", library: false, title: "File:Y" })), true);
	});

	it("a different outside picture is not", () => {
		assert.equal(isRepeat(card({ tier: "commons", title: "File:X" }), cand({ library: false, title: "File:X" })), false);
	});

	it("another library page is not", () => {
		assert.equal(isRepeat(card({}), cand({ title: "Sabiston (2021) p.850" })), false);
	});

	it("one page, the figure numbers decide: 35.4 then 35.5 differ, 35.5 then 35.5B is the same figure", () => {
		const shown = card({ caption: "Sabiston Fig. 35.4: ductogram." });
		assert.equal(isRepeat(shown, cand({ number: n("35.5") })), false);
		assert.equal(isRepeat(card({ caption: "Fig. 35.5 TDLU" }), cand({ number: n("35.5B") })), true);
	});

	it("one page, no numbers: crops that overlap are the same figure, crops that do not are different ones", () => {
		const shown = card({ crop: { top: 0.1, bottom: 0.4 } });
		assert.equal(isRepeat(shown, cand({ crop: { top: 0.12, bottom: 0.45 } })), true);
		assert.equal(isRepeat(shown, cand({ crop: { top: 0.55, bottom: 0.9 } })), false);
		assert.equal(isRepeat(shown, cand({ crop: { top: 0.35, bottom: 0.8 } })), false, "only a sliver of the thinner band is shared");
	});

	it("one page, nothing says they differ (an old card, a whole page): it counts as a repeat", () => {
		assert.equal(isRepeat(card({}), cand({ crop: { top: 0.55, bottom: 0.9 } })), true);
		assert.equal(isRepeat(card({ crop: { top: 0.1, bottom: 0.4 } }), cand({ crop: null })), true);
	});

	it("findRepeat returns the card it repeats, or null", () => {
		const a = card({ caption: "Fig. 35.4", title: "Sabiston (2021) p.847" });
		const b = card({ caption: "Fig. 35.5" });
		assert.equal(findRepeat([a, b], cand({ number: n("35.5") })), b);
		assert.equal(findRepeat([a], cand({ number: n("35.5") })), null);
	});
});
