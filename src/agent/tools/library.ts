import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { citationFor, marksNotice, snippet, VISION_NOTICE } from "../../core/library.ts";
import type { LibraryReader } from "../library/searcher.ts";

/**
 * THE LIBRARY TOOLS (medical fork, Phase 6): `library_search` and
 * `library_read` over the learner's imported PDFs (slides, textbooks) and
 * SlideScribe lecture notes. The prober, teacher and practice agents get them
 * when the library has at least one searchable book; the later Anki
 * generator (med-anki) adds the SAME pair by spreading `libraryTools(ctx)`
 * into its own registry — nothing here is agent-specific.
 *
 * Mechanical descriptions only (the repo's tool-description rule): what to
 * pass and what comes back. When to look in the books, and how to cite what
 * they say, live in the prompt (prompts/shared/35-library.md and the teacher
 * fragment).
 */

export const LIBRARY_TOOL_NAMES = ["library_search", "library_read"] as const;

/** What the library tools close over (injected by the composition root). */
export interface LibraryToolContext {
	reader: LibraryReader;
}

/** Output ceiling for library_read — narrow the pages instead of dumping a book. */
const READ_CAP = 24_000;

const searchInput = Type.Object({
	query: Type.String({
		minLength: 1,
		description: "What to look for — a question, a term, or a sentence in your own words. Keyword and meaning search run together.",
	}),
	book: Type.Optional(
		Type.String({ description: "Limit the search to one book (its title as the library lists it). Omit to search every book." }),
	),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12, description: "How many passages to return (default 6)." })),
});

const readInput = Type.Object({
	book: Type.String({ minLength: 1, description: "The book's title exactly as library_search showed it." }),
	pages: Type.String({
		minLength: 1,
		description: "Pages to read: '5', '3-7', '1,4,9' or 'all'. For a lecture note these are slide numbers; 'extra' reads the note's extra-notes section.",
	}),
});

export function libraryTools(ctx: LibraryToolContext): Record<string, AgentTool<any>> {
	return {
		library_search: {
			name: "library_search",
			label: "library_search",
			description:
				"Search the learner's own library — the PDFs (lecture slides, textbooks) and SlideScribe lecture notes they imported. " +
				"Returns the best-matching passages, ranked, each with its book and page (or lecture and slide) and a short excerpt. " +
				"Use library_read to read a whole page.",
			parameters: searchInput,
			execute: serverExecute("library_search", searchInput, async ({ query, book, limit }): Promise<string> => {
				const { hits, notes } = await ctx.reader.search(query, { book, limit });
				const lines: string[] = [];
				if (hits.length === 0) {
					lines.push(`No passages found for "${query}".`);
				} else {
					lines.push(`${hits.length} passage${hits.length === 1 ? "" : "s"} for "${query}", best first:`);
					hits.forEach((h, i) => {
						const cite = citationFor(h.book, h.chunk.page);
						lines.push("", `${i + 1}. ${cite}${h.chunk.section ? ` — ${h.chunk.section}` : ""}`, `   ${snippet(h.chunk.text)}`);
						const marks = marksNotice(h.chunk.marks);
						if (marks) lines.push(`   ${marks}`);
						if (h.chunk.visionText) lines.push(`   ${VISION_NOTICE}`);
					});
					lines.push("", "Cite a passage by the name and page printed above.");
				}
				for (const n of notes) lines.push("", n);
				return lines.join("\n");
			}),
		},
		library_read: {
			name: "library_read",
			label: "library_read",
			description:
				"Read the full text of pages from one book in the learner's library (by the title library_search printed). " +
				"Returns each requested page's text under a citation header.",
			parameters: readInput,
			execute: serverExecute("library_read", readInput, async ({ book, pages }): Promise<string> => {
				const result = ctx.reader.read(book, pages);
				if (!result.ok) throw new Error(result.error);
				const out: string[] = [];
				for (const { page, chunks } of result.pages) {
					out.push(`--- ${citationFor(result.book, page)} ---`);
					if (chunks.length === 0) {
						out.push("(no text on this page — it may be an image or blank)");
						continue;
					}
					if (chunks[0]!.section && result.book.kind === "pdf") out.push(`Section: ${chunks[0]!.section}`);
					out.push(chunks.map((c) => c.text).join("\n"));
					for (const c of chunks) {
						const marks = marksNotice(c.marks);
						if (marks) out.push(marks);
						if (c.visionText) out.push(VISION_NOTICE);
					}
				}
				const text = out.join("\n");
				return text.length > READ_CAP
					? `${text.slice(0, READ_CAP)}\n\n[Output truncated at ${READ_CAP} characters — read fewer pages at a time.]`
					: text;
			}),
		},
	};
}
