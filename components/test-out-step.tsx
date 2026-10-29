"use client";

import { TEST_OUT_PHRASE, type PlanNode } from "@/src/core";

/** Shared by desktop and pocket; stays beside the current question/composer. */
export function TestOutStep({ node, disabled, onTest }: {
	node: PlanNode;
	disabled: boolean;
	onTest: (text: string) => void;
}) {
	return (
		<div data-testid="test-out-step" className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-background/95 px-3 py-2">
			<span className="min-w-0 text-sm">Current step: {node.title}</span>
			<button type="button" data-testid="test-out-button" disabled={disabled}
				aria-label={`${TEST_OUT_PHRASE}: ${node.title}`}
				className="min-h-11 rounded-md border px-3 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
				onClick={() => onTest(TEST_OUT_PHRASE)}>
				{TEST_OUT_PHRASE}
			</button>
		</div>
	);
}
