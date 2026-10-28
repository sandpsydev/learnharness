import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { AnkiCard } from "../src/core/contracts.ts";
import { AnkiDialog, AnkiReviewBody, pushSummaryLine } from "../components/anki-dialog.tsx";

/**
 * The Anki review panel (docs/medical-spec.md Phase 5): SSR pins for what
 * the learner sees. The body is pure; fetching and autosave live in the
 * wrapper and are covered at the API / service level (tests/anki.test.ts).
 */

const card = (over: Partial<AnkiCard> = {}): AnkiCard => ({
	id: "card_1",
	type: "basic",
	kind: "mechanism",
	system: "renal",
	topic: "RTA",
	front: "Why is urine pH high in type 1 RTA?",
	back: "No distal H+ secretion",
	...over,
});

function body(over: Partial<Parameters<typeof AnkiReviewBody>[0]> = {}) {
	return renderToStaticMarkup(
		createElement(AnkiReviewBody, {
			title: "Renal tubular acidosis",
			phase: "ready",
			activity: "",
			error: null,
			cards: [card()],
			deckOverride: "",
			pushing: false,
			pushError: null,
			summary: null,
			resumed: false,
			onCardChange: () => {},
			onCardDelete: () => {},
			onDeckOverride: () => {},
			onPush: () => {},
			onRetry: () => {},
			onRedraft: () => {},
			onStop: () => {},
			onDiscard: () => {},
			onClose: () => {},
			...over,
		}),
	);
}

describe("Anki review panel", () => {
	it("shows each card editable, with its deck and a Send button counting unsent cards", () => {
		const html = body({ cards: [card(), card({ id: "card_2", system: "cardiovascular" })] });
		assert.equal((html.match(/data-testid="anki-card"/g) ?? []).length, 2);
		assert.ok(html.includes("LearnHarness::Cardio"), "the deck options come from the shared system list");
		assert.ok(html.includes("LearnHarness::Renal"));
		assert.ok(html.includes("Why is urine pH high in type 1 RTA?"));
		assert.ok(html.includes("Send 2 cards to Anki"));
		assert.ok(html.includes('data-testid="anki-card-delete"'));
		assert.ok(html.includes('data-testid="anki-deck-override"'));
	});

	it("a management card shows its source field; other kinds do not", () => {
		assert.ok(body({ cards: [card({ kind: "management", source: "KDIGO 2024" })] }).includes('data-testid="anki-card-source"'));
		assert.ok(!body().includes('data-testid="anki-card-source"'));
	});

	it("flags a cloze card with no deletion and still lets the learner fix it", () => {
		const html = body({ cards: [card({ type: "cloze", front: "plain text" })] });
		assert.ok(html.includes('data-testid="anki-card-problem"'));
		assert.ok(html.includes("{{c1::answer}}"));
	});

	it("marks sent, skipped and failed cards, locks sent ones, and counts only unsent ones", () => {
		const html = body({
			cards: [
				card({ id: "a", push: { status: "added" } }),
				card({ id: "b", push: { status: "duplicate", message: "already there" } }),
				card({ id: "c", push: { status: "failed", message: "boom" } }),
			],
		});
		assert.ok(html.includes('data-testid="anki-card-added"'));
		assert.ok(html.includes('data-testid="anki-card-duplicate"'));
		assert.ok(html.includes('data-testid="anki-card-failed"'));
		assert.ok(html.includes("Send 2 cards to Anki"));
		const sent = html.match(/<li[^>]*data-card-id="a"[\s\S]*?<\/li>/)?.[0] ?? "";
		assert.ok(!sent.includes('data-testid="anki-card-delete"'), "a card already in Anki cannot be deleted here");
		assert.match(sent, /disabled/);
	});

	it("says drafting happens in the background and that nothing is sent yet", () => {
		const html = body({ phase: "generating", activity: "Drafting cards (part 1 of 2)", cards: [] });
		assert.ok(html.includes("Drafting cards (part 1 of 2)…"));
		assert.ok(html.includes("Nothing is sent to Anki until you review"));
		assert.ok(html.includes('data-testid="anki-stop"'));
		assert.ok(!html.includes('data-testid="anki-push"'));
	});

	it("shows an error with Try again, a push error in place, and the empty result honestly", () => {
		const err = body({ phase: "error", error: "No model is configured." });
		assert.ok(err.includes("No model is configured."));
		assert.ok(err.includes('data-testid="anki-retry"'));
		const down = body({ pushError: "Can't reach Anki. Open the Anki desktop app and make sure the AnkiConnect add-on (code 2055492159) is installed, then try again." });
		assert.ok(down.includes('data-testid="anki-push-error"'));
		assert.ok(down.includes("Open the Anki desktop app"));
		assert.ok(down.includes('data-testid="anki-card"'), "the cards stay for another try");
		const empty = body({ cards: [] });
		assert.ok(empty.includes('data-testid="anki-empty"'));
		assert.ok(empty.includes("disabled"), "nothing to send");
	});

	it("offers to redraft when it reopened an earlier unsent draft", () => {
		assert.ok(body({ resumed: true }).includes('data-testid="anki-redraft"'));
		assert.ok(!body().includes('data-testid="anki-redraft"'));
	});

	it("words the push result plainly", () => {
		assert.equal(pushSummaryLine({ added: 3, duplicate: 0, failed: 0 }), "Added 3 cards.");
		assert.equal(pushSummaryLine({ added: 1, duplicate: 2, failed: 1 }), "Added 1 card, skipped 2 already in Anki, 1 could not be added.");
	});

	it("renders nothing while closed", () => {
		assert.equal(renderToStaticMarkup(createElement(AnkiDialog, { origin: null, onClose: () => {} })), "");
	});
});
