"use client";

import { ToolContentResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import { PRACTICE_OPTION_LETTERS, type PracticeOptionLetter, type PracticeOptions } from "@/src/core";

/** The question dock's single-select row styling, without its quiz grading. */
export function PracticeOptionList({ options, selected, onSelect }: {
	options: PracticeOptions;
	selected?: PracticeOptionLetter | null;
	onSelect?: (letter: PracticeOptionLetter) => void;
}) {
	return (
		<div role="group" aria-label="Answer options" className="mt-3 flex flex-col gap-1.5">
			{PRACTICE_OPTION_LETTERS.map((letter) => {
				const picked = selected === letter;
				const content = <>
					<span className={cn(
						"mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border font-mono text-xs",
						picked ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
					)}>{letter}</span>
					<div className="min-w-0 flex-1"><ToolContentResponse>{options[letter]}</ToolContentResponse></div>
				</>;
				return onSelect ? (
					<button key={letter} type="button" aria-pressed={picked} data-option={letter}
						onClick={() => onSelect(letter)}
						className={cn(
							"flex items-start gap-3 rounded-lg border px-3 py-2 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary",
							picked ? "border-primary bg-accent" : "hover:bg-accent/50",
						)}>{content}</button>
				) : <div key={letter} className="flex items-start gap-3 text-sm">{content}</div>;
			})}
		</div>
	);
}
