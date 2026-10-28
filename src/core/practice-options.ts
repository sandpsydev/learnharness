/** Shared MCQ identities; no grading happens at this seam. */
export const PRACTICE_OPTION_LETTERS = ["A", "B", "C", "D", "E"] as const;
export type PracticeOptionLetter = (typeof PRACTICE_OPTION_LETTERS)[number];
export type PracticeOptions = Record<PracticeOptionLetter, string>;
export interface PracticeMcq {
	options: PracticeOptions;
	correctOption: PracticeOptionLetter;
	optionRationale: PracticeOptions;
}

export function isPracticeOptionLetter(value: unknown): value is PracticeOptionLetter {
	return PRACTICE_OPTION_LETTERS.some((letter) => letter === value);
}

/** Saved records are untrusted, and older free-response records have no options. */
export function practiceOptionsOf(value: unknown): PracticeOptions | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const fields = value as Record<string, unknown>;
	return Object.keys(fields).length === 5 && PRACTICE_OPTION_LETTERS.every(
		(letter) => typeof fields[letter] === "string" && fields[letter].trim().length > 0,
	) ? fields as PracticeOptions : null;
}

export function practiceMcqOf(value: unknown): PracticeMcq | null {
	if (!value || typeof value !== "object") return null;
	const fields = value as Record<string, unknown>;
	const options = practiceOptionsOf(fields.options);
	const optionRationale = practiceOptionsOf(fields.optionRationale);
	return options && optionRationale && isPracticeOptionLetter(fields.correctOption)
		? { options, optionRationale, correctOption: fields.correctOption }
		: null;
}
