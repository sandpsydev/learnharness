/**
 * Explain my miss (medical fork, Phase 7): the pure pieces every layer
 * shares — the session's fixed title, the marker text that tells the
 * agents "this is a miss session", and the check that keeps a question
 * bank's wording out of anything the app writes down (graph nodes, Anki
 * cards). No framework imports; safe on server, client and tests.
 */

/** The label every miss session starts with. The learner's pasted question
 *  is NEVER used as a title (the bank's wording stays out of the sidebar);
 *  the server appends the date so several misses stay tellable apart. */
export const MISS_SESSION_TITLE = "Explain my miss";

/** `Explain my miss — 29 Oct 14:05`, from the creation time. Fixed English
 *  month names so the title never depends on the machine's locale. */
export function missSessionTitle(now: Date = new Date()): string {
	const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${MISS_SESSION_TITLE} — ${now.getDate()} ${months[now.getMonth()]} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** The model-facing text of the session's miss marker. It only SIGNALS the
 *  flow — the rules live in the prober and teacher prompt fragments
 *  (prompts/prober/20-miss-flow.md, prompts/teacher/55-miss-flow.md), the
 *  way every other behavior does. Bracketed like the other injected
 *  session context: markers reach the model in the user role, so the text
 *  must not read as the learner speaking. */
export const MISS_FLOW_MARKER_TEXT =
	"[Session context] — Explain my miss: the learner is bringing one question-bank question they got wrong. " +
	"Follow the Explain-my-miss flow from your instructions. The question text or screenshot arrives in the learner's first message.";

/** Words per window when looking for copied wording. Eight words in a row
 *  is far past a shared medical term ("anterior cruciate ligament tear")
 *  and well inside a copied sentence. */
export const VERBATIM_WINDOW_WORDS = 8;

const wordsOf = (text: string): string[] =>
	text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.split(" ")
		.filter(Boolean);

/** The set of every `window`-word run in the given texts (normalized: case,
 *  punctuation and spacing do not hide a copy). */
export function verbatimRuns(texts: readonly string[], window = VERBATIM_WINDOW_WORDS): Set<string> {
	const runs = new Set<string>();
	for (const text of texts) {
		const words = wordsOf(text);
		for (let i = 0; i + window <= words.length; i++) runs.add(words.slice(i, i + window).join(" "));
	}
	return runs;
}

/** Does `candidate` repeat a run of the source texts word for word? Pass a
 *  prebuilt `runs` set (verbatimRuns) when checking many candidates. */
export function copiesSource(candidate: string, runs: ReadonlySet<string>, window = VERBATIM_WINDOW_WORDS): boolean {
	if (runs.size === 0) return false;
	const words = wordsOf(candidate);
	for (let i = 0; i + window <= words.length; i++) {
		if (runs.has(words.slice(i, i + window).join(" "))) return true;
	}
	return false;
}

/** The refusal text the extractor and card maker get back when a draft
 *  copies the question bank — they fix it in the same run. */
export function verbatimProblem(what: string): string {
	return (
		`${what} repeats the question bank's wording word for word. Question-bank text must never be copied: ` +
		"restate the underlying idea in your own words, with no run of the stem, options or explanation carried over."
	);
}
