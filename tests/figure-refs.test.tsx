/**
 * Figure links (medical fork) — synthetic fixtures, zero network:
 *
 *   1. the matching rules: a mention links only to a figure card of the same chat
 *      (book + page, figure number, panel letter, the card's title); no card = plain text;
 *      several cards on one page = the best match, or all of them when nothing tells them apart
 *   2. the markdown plugin and the rendered text: where the link sits, what never links
 *      (code, existing links), the book name that sits in its own *emphasis*
 *   3. the pop-up shell
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React; // tsx classic-JSX shim (see render-cards.test.tsx)

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageResponse } from "../components/ai-elements/message.tsx";
import { FigureRefsContext } from "../components/figure-refs.tsx";
import { FigurePeek } from "../components/figure-peek.tsx";
import {
	cardRefOf,
	figureCardsOf,
	findCitationClusters,
	findFigureMentions,
	parseCreditTitle,
	parseFigureNumber,
	type FigureCardRef,
} from "../src/core/figure-refs.ts";
import type { FigureImage, FigureResult } from "../src/core/contracts.ts";

const SABISTON = "Sabiston Textbook of Surgery_ The Biological Basis of Modern Surgical Practice-Elsevier (2021)";
const SCHWARTZ = "2019_Schwartz_s_Principles_of_Surgery";
const ROBBINS = "Robbins & Kumar Basic Pathology 11th Edition [Medicalstudyzone.com]";

function result(file: string, title: string, caption: string, extra: Partial<FigureImage> = {}): FigureResult {
	return {
		concept: "synthetic",
		outcome: "image",
		image: { file, mime: "image/png", tier: "slides", source: "Your library", title, credit: "Test, via Your library", licence: "Your lecture slides", ...extra },
		caption,
		keyFeature: "the feature",
		links: [],
		brief: "ok",
	};
}
const card = (r: FigureResult, id: string): FigureCardRef => cardRefOf(r, id)!;

const C = {
	sabC: card(result("a".repeat(24) + ".png", `${SABISTON} p.857`, "Sabiston Fig. 35.7C (upper right) shows a breast mass."), "steer_c"),
	// One page, two cards, ONE cached picture file (as the finder really delivers them).
	sabB: card(result("a".repeat(24) + ".png", `${SABISTON} p.857`, "Sabiston Fig. 35.7B (upper middle panel) shows clustered microcalcifications."), "steer_b"),
	sabD: card(result("c".repeat(24) + ".png", `${SABISTON} p.857`, "Panel D (lower left) is a breast ultrasound of a simple cyst in Sabiston Fig. 35.7 (library p.857)."), "steer_d"),
	schw: card(result("d".repeat(24) + ".png", `${SCHWARTZ} p.597`, "Schwartz Figure 17-21 shows a spiculated right-breast mass; panel C provides a spot-compression view."), "steer_s"),
	robb: card(result("e".repeat(24) + ".png", `${ROBBINS} p.714`, "Panel A (upper left) shows H&E histology of invasive ductal carcinoma."), "steer_r"),
	slide: card(result("f".repeat(24) + ".png", "Renal lecture 3, slide 12", "A nephron diagram."), "steer_l"),
	commons: card(result("0".repeat(24) + ".jpg", "Histopathology of benign phyllodes tumor.jpg", "Low-power H&E of a phyllodes tumour.", { tier: "commons" }), "steer_m"),
};
const ALL = Object.values(C);
const ids = (cards: FigureCardRef[]) => cards.map((c) => c.id);

/** The linked spans and which cards each opens. */
function mentions(text: string, cards: FigureCardRef[] = ALL, lead = ""): Array<{ text: string; cards: FigureCardRef[] }> {
	return findFigureMentions(text, cards, lead).map((m) => ({ text: text.slice(m.start, m.end), cards: m.cards }));
}

describe("figure links — reading the cards", () => {
	it("reads the book and page from the credit title", () => {
		assert.deepEqual(parseCreditTitle(`${SABISTON} p.857`), { book: SABISTON, page: 857 });
		assert.deepEqual(parseCreditTitle("Renal lecture 3, slide 12"), { book: "Renal lecture 3", page: 12 });
		assert.equal(parseCreditTitle("Histopathology of benign phyllodes tumor.jpg"), null);
	});

	it("reads the figure number and panel from the finder's caption", () => {
		assert.deepEqual(C.sabC.number, { base: "35.7", letter: "C" });
		assert.equal(C.sabC.panel, "C");
		assert.deepEqual(C.sabD.number, { base: "35.7", letter: "" });
		assert.equal(C.sabD.panel, "D");
		assert.deepEqual(C.schw.number, { base: "17.21", letter: "" });
		assert.equal(C.robb.number, null);
		assert.equal(C.robb.panel, "A");
	});

	it("writes 17-21 and 17.21 as one number", () => {
		assert.deepEqual(parseFigureNumber("17-21"), parseFigureNumber("17.21"));
		assert.deepEqual(parseFigureNumber("17–15b"), { base: "17.15", letter: "B" });
	});

	it("lists each delivered picture card by its message id, in chat order — two cards of one page may share a file", () => {
		const steer = (id: string | undefined, r: FigureResult) => ({ id, parts: [{ type: "data-subagent-artifact", data: { kind: "figure", result: r } }] });
		const link: FigureResult = { ...result("x", "t", "c"), outcome: "link", image: undefined };
		const cards = figureCardsOf([
			{ parts: [{ type: "text" }] },
			steer("steer_1", C.sabC.result),
			steer("steer_2", link),
			steer("steer_3", C.sabB.result),
			steer(undefined, C.schw.result),
			{ parts: [{ type: "data-subagent-artifact", data: { kind: "visual", result: {} } }] },
		]);
		assert.deepEqual(ids(cards), ["steer_1", "steer_3", "m-4"], "a record with no message id falls back to its place in the chat");
		assert.equal(cards[0]!.file, cards[1]!.file, "the two Sabiston cards share one picture file and are still two cards");
	});
});

describe("figure links — which mention names which card", () => {
	it("links book + page + figure + panel to that card, naming the whole citation", () => {
		const m = mentions(" 2019, p.597, Fig. 17-21, panel C, spot-compression view).", ALL, "Schwartz");
		assert.equal(m.length, 1);
		assert.equal(m[0]!.text, "p.597, Fig. 17-21, panel C");
		assert.deepEqual(ids(m[0]!.cards), [C.schw.id]);
	});

	it("of three cards on one page, the figure letter picks one", () => {
		const m = mentions("(Sabiston 2021, p.857, Fig. 35.7B). Look for the cluster.");
		assert.equal(m.length, 1);
		assert.deepEqual(ids(m[0]!.cards), [C.sabB.id]);
	});

	it("of three cards on one page, 'panel X' picks one — even when the card names the panel but no letter on the number", () => {
		assert.deepEqual(ids(mentions("(Sabiston p.857, panel D)")[0]!.cards), [C.sabD.id]);
		assert.deepEqual(ids(mentions("(Sabiston p.857, panel C)")[0]!.cards), [C.sabC.id]);
		// A figure letter is a panel too: 35.7B cannot be the card whose panel is D.
		assert.deepEqual(ids(mentions("Sabiston p.857, Fig. 35.7B")[0]!.cards), [C.sabB.id]);
	});

	it("when nothing tells the cards of the page apart, all of them open together", () => {
		assert.deepEqual(ids(mentions("as Sabiston p.857 shows")[0]!.cards).sort(), [C.sabB.id, C.sabC.id, C.sabD.id].sort());
		assert.deepEqual(ids(mentions("Sabiston p.857, Fig. 35.7")[0]!.cards).sort(), [C.sabB.id, C.sabC.id, C.sabD.id].sort());
	});

	it("a citation with no matching card stays plain text", () => {
		assert.deepEqual(mentions("(Schwartz, 2019, p.581.)"), [], "a page with no figure card in this chat");
		assert.deepEqual(mentions("Robbins p.597"), [], "right page, wrong book");
		assert.deepEqual(mentions("Sabiston p.857, Fig. 35.9"), [], "a different figure number than any card shows");
		assert.deepEqual(mentions("Sabiston p.857, panel F"), [], "a panel no card is about");
		assert.deepEqual(mentions("see p.857"), [], "a page with no book named");
		assert.deepEqual(mentions("the figure from your Sabiston shows it"), [], "a book with no page or number");
		assert.deepEqual(mentions("Schwartz p.597", []), [], "a chat with no figure cards");
	});

	it("a bare chapter-style figure number links when a card carries it", () => {
		assert.deepEqual(ids(mentions("Look at Fig. 35.7B again.")[0]!.cards), [C.sabB.id]);
		assert.deepEqual(ids(mentions("Figure 17-21 shows it")[0]!.cards), [C.schw.id]);
		assert.deepEqual(mentions("Figure 3 shows it"), [], "a plain number is too common to trust");
		assert.deepEqual(mentions("Figure 99.1 shows it"), [], "no card has that number");
	});

	it("a bare figure number shared by two books links only when the book is named", () => {
		const other = card(result("9".repeat(24) + ".png", `${ROBBINS} p.50`, "Robbins Figure 35.7 shows a thing."), "steer_o");
		const cards = [C.sabB, other];
		assert.deepEqual(mentions("Fig. 35.7 again", cards), []);
		assert.deepEqual(ids(mentions("Robbins Fig. 35.7 again", cards)[0]!.cards), [other.id]);
	});

	it("reads 'library p.N' (how the teacher cites the learner's own book page) as part of the mention", () => {
		const robbins = card(result("7".repeat(24) + ".png", `${ROBBINS} p.708`, "Robbins 11th ed., Fig. 17.26A shows an apocrine cyst."), "steer_a");
		const m = mentions("(Robbins 11th ed., Fig. 17.26A, library p.708), which", [robbins], "");
		assert.equal(m.length, 1);
		assert.equal(m[0]!.text, "Fig. 17.26A, library p.708");
	});

	it("reads a slide by number", () => {
		assert.deepEqual(ids(mentions("(Renal lecture 3, slide 12)")[0]!.cards), [C.slide.id]);
	});

	it("an outside picture is named by its title", () => {
		const m = mentions("The Histopathology of benign phyllodes tumor image shows leaf-like fronds.");
		assert.equal(m.length, 1);
		assert.equal(m[0]!.text, "Histopathology of benign phyllodes tumor");
		assert.deepEqual(ids(m[0]!.cards), [C.commons.id]);
	});

	it("a half-typed citation (mid-stream) does not link", () => {
		assert.deepEqual(mentions("(Schwartz 2019, p.5"), []);
		assert.deepEqual(mentions("(Schwartz 2019, p."), []);
	});

	it("joins page, figure and panel into one mention", () => {
		const [c] = findCitationClusters("see p.597, Fig. 17-21 and panel C, then more");
		assert.deepEqual(c!.pages, [597]);
		assert.deepEqual(c!.panels, ["C"]);
		assert.equal(c!.figures[0]!.base, "17.21");
	});
});

const render = (md: string, cards: FigureCardRef[] = ALL, withContext = true) => {
	const node = <MessageResponse mode="static">{md}</MessageResponse>;
	return renderToStaticMarkup(withContext ? <FigureRefsContext.Provider value={{ cards, open: () => {} }}>{node}</FigureRefsContext.Provider> : node);
};
const links = (html: string) => [...html.matchAll(/<span[^>]*data-testid="figure-ref"[^>]*data-ids="([^"]*)"[^>]*>(.*?)<\/span>(?=[^<]|<(?!\/em|\/strong))/gs)];

describe("figure links — in the rendered text", () => {
	it("links the whole citation, the emphasised book name included", () => {
		const html = render("**Spiculated mass** (*Schwartz* 2019, p.597, Fig. 17-21, panel C, spot-compression view). Look at the strands.");
		assert.match(html, /data-testid="figure-ref"/);
		assert.match(html, new RegExp(`data-ids="${C.schw.id}"`));
		const inner = /data-testid="figure-ref"[^>]*>(.*?)<\/span>, spot-compression/s.exec(html)?.[1] ?? "";
		assert.match(inner, /<em>Schwartz<\/em> 2019, p\.597, Fig\. 17-21, panel C/, "the link covers the book name through the panel");
		assert.match(html, /role="button"/);
		assert.match(html, /class="lh-figure-ref"/);
	});

	it("links a plain-text book name and an italic one the same way", () => {
		const a = render("In Sabiston p.857, panel D, the cyst is black.");
		const b = render("In *Sabiston* p.857, panel D, the cyst is black.");
		for (const html of [a, b]) {
			assert.equal(links(html).length, 1, html);
			assert.match(html, new RegExp(`data-ids="${C.sabD.id}"`));
		}
	});

	it("opens all cards of the page when it cannot tell them apart", () => {
		const html = render("See *Sabiston* p.857.");
		const m = /data-ids="([^"]*)"/.exec(html)!;
		assert.deepEqual(m[1]!.split(",").sort(), [C.sabB.id, C.sabC.id, C.sabD.id].sort());
	});

	it("leaves a citation with no card as plain text, with no extra markup", () => {
		const md = "(*Schwartz*, 2019, p.581.) Another thing.";
		assert.equal(render(md), render(md, ALL, false));
		assert.ok(!render(md).includes("figure-ref"));
	});

	it("never links code, math or an existing link", () => {
		const html = render("`Schwartz p.597` and $p.597$ and [Schwartz p.597](https://example.com/x).");
		assert.ok(!html.includes("figure-ref"), html);
	});

	it("is plain without the chat's cards (recap, sidebar previews)", () => {
		const md = "(*Schwartz* 2019, p.597, Fig. 17-21)";
		assert.ok(!render(md, ALL, false).includes("figure-ref"));
		assert.ok(!render(md, []).includes("figure-ref"));
	});

	it("keeps the rest of the markdown (bold, tables) intact around a link", () => {
		const html = render("**Spiculated mass** (*Schwartz* 2019, p.597).\n\n| a | b |\n|---|---|\n| Sabiston p.857, panel B | x |\n");
		assert.match(html, /<strong[^>]*>Spiculated mass<\/strong>/);
		assert.equal((html.match(/data-testid="figure-ref"/g) ?? []).length, 2, "one in the sentence, one in the table cell");
	});
});

describe("figure links — the pop-up", () => {
	it("shows each picture large with its caption, credit and a 'Show in chat' action", () => {
		const html = renderToStaticMarkup(
			<FigurePeek chatId="chat_abc_123" cards={[C.sabB, C.sabD]} trigger={null} onClose={() => {}} onShowInChat={() => {}} />,
		);
		assert.match(html, /role="dialog"/);
		assert.match(html, /aria-modal="true"/);
		assert.equal((html.match(/data-testid="figure-peek-card"/g) ?? []).length, 2);
		assert.equal((html.match(/Show in chat/g) ?? []).length, 2);
		assert.match(html, new RegExp(`/api/figures/chat_abc_123/${C.sabB.image.file}`));
		assert.match(html, /data-testid="figure-credit"/);
		assert.match(html, /Test, via Your library/);
		assert.match(html, /Look for: /);
		assert.match(html, /max-h-\[70vh\]/, "tall pictures are capped so the caption stays on screen");
		assert.match(html, /Figures · 2 from this page/);
	});

	it("renders nothing for no cards", () => {
		assert.equal(renderToStaticMarkup(<FigurePeek chatId="c" cards={[]} trigger={null} onClose={() => {}} onShowInChat={() => {}} />), "");
	});
});
