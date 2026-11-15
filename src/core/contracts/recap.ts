/**
 * Session recap (medical fork, docs/medical-spec.md "Session recap"): one
 * Obsidian review note per teaching session, written only when the learner
 * asks for it. Types and constants only, browser-safe. The behaviour lives in
 * core/session-recap.ts (what the model is shown, the check on what it hands
 * back, the note) and server/recap.ts (the run).
 */

/** One table the session showed, kept word for word. */
export interface RecapTable {
	/** The id the writer used for it in this run (K1, K2…). Not stable across runs. */
	id: string;
	/** The GitHub-style Markdown table, exactly as the teacher wrote it. */
	markdown: string;
}

/** One picture the session showed. All of this comes from the session record, never from the writer. */
export interface RecapFigure {
	/** File name in the vault's Attachments folder (and the app's own copy). */
	file: string;
	caption: string;
	/** "Author, via Source · licence", as the figure card showed it; empty for a drawn figure. */
	credit: string;
}

/** A picture the writer asked the app to find for a visual point the session taught without one. */
export interface RecapPictureRequest {
	/** What the picture must show, as the session described it ("the course of the ureter and its three narrowings"). */
	concept: string;
	/** What kind of picture, to aim the search: anatomy drawing, CT, stone photograph… */
	modality?: string;
	/** One plain sentence for the note: what the picture shows, using only what the session said. */
	caption: string;
	/** For when no real figure fits: a brief for a simple labelled drawing, using only labels and links the session stated. */
	diagram?: string;
}

/** One theme of the session, with what was taught about it. */
export interface RecapTopic {
	title: string;
	points: string[];
	tables: RecapTable[];
	figures: RecapFigure[];
}

/** Something the learner got wrong, was unsure about, or did not know. */
export interface RecapMiss {
	question: string;
	/** What the learner answered (or "did not know"). */
	yours: string;
	/** The right answer, as the session gave it. */
	correct: string;
}

export interface RecapQuestion {
	question: string;
	answer: string;
}

/** The app's own copy of one session's recap: data/recaps/<chatId>.json. */
export interface SessionRecap {
	chatId: string;
	title: string;
	/** The session's start date, YYYY-MM-DD — fixed for the session, so the file name stays put on a refresh. */
	sessionDate: string;
	generatedAt: string;
	/** How many messages the session had when this was written (to tell the learner it has moved on since). */
	messageCount: number;
	summary: string;
	topics: RecapTopic[];
	misses: RecapMiss[];
	selfTest: RecapQuestion[];
	/** Where the note went in the vault, relative to <vault>/LearnHarness. Absent until it has been written there. */
	notePath?: string;
	usage: { calls: number; inputTokens: number; outputTokens: number };
}

export type RecapPhase = "reading" | "writing" | "pictures" | "saving";

/** The run for one session, as the button polls it. */
export interface RecapRunState {
	chatId: string;
	running: boolean;
	startedAt: string;
	finishedAt?: string;
	phase?: RecapPhase;
	/** While pictures are being found: which one ("Finding a picture: stone morphology (2 of 4)"). */
	current?: string;
	/** A plain line for the learner when the run ended in failure. */
	error?: string;
	/** A plain line when it ended well but something was left out (pictures that could not be found). */
	message?: string;
}

/** What the Session recap button shows for one session. */
export interface RecapStatus {
	vault: { configured: boolean; problem?: string };
	/** Any run is writing a recap right now (one at a time, whichever session). */
	busy: boolean;
	run: RecapRunState | null;
	recap: {
		generatedAt: string;
		/** Where the note is, relative to the app folder; absent when it has not reached the vault yet. */
		notePath?: string;
		/** Full path of the note, for showing. */
		absolutePath?: string;
		/** obsidian:// link that opens the note. */
		obsidianUrl?: string;
		/** Messages added to the session since this recap was written. */
		newMessages: number;
		topics: number;
	} | null;
}
