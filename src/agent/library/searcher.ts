/**
 * THE LIBRARY SEARCHER (medical fork, Phase 6): what the agent tools and the
 * server read the library through. Keyword ranking (BM25) always works; the
 * meaning ranking (local embeddings) joins in when the model's files are on
 * disk and the book has vectors from that same model. The two rankings are
 * fused (core/library.ts), so an exact drug name and a paraphrased question
 * both land.
 *
 * Per-book caches (chunks, term statistics, vectors) are keyed by the store's
 * fingerprint, so a re-index is picked up on the next call without a restart.
 */

import type { LibraryBook, LibraryChunk, LibraryHit } from "../../core/contracts.ts";
import {
	bm25Search,
	buildKeywordIndex,
	fuseRankings,
	parseLibraryPages,
	resolveBook,
	vectorSearch,
	type KeywordIndex,
	type LibraryEmbedder,
} from "../../core/library.ts";
import type { LibraryStore } from "../../core/ports.ts";

/** Meaning hits below this cosine are noise, however they rank. */
const MIN_MEANING_SCORE = 0.5;
/** …and so are hits this far under the best one. */
const MEANING_BAND = 0.12;
const CANDIDATES = 40;

export interface LibrarySearcherDeps {
	store: LibraryStore;
	/** The embedder to use for QUERIES right now, or null when its model
	 *  files aren't on disk (search must never trigger a download). */
	embedder: () => LibraryEmbedder | null;
}

export interface LibrarySearchResult {
	hits: LibraryHit[];
	/** Plain-language caveats for the tool output (still indexing, no meaning search, …). */
	notes: string[];
}

export type LibraryReadResult = { ok: true; book: LibraryBook; pages: Array<{ page: number; chunks: LibraryChunk[] }> } | { ok: false; error: string };

/** The reader the tools code against (a fake stands in for it in tests). */
export interface LibraryReader {
	/** Cheap: true when at least one book is searchable. Gates tool registration. */
	hasBooks(): boolean;
	search(query: string, opts?: { book?: string; limit?: number }): Promise<LibrarySearchResult>;
	read(book: string, pages: string): LibraryReadResult;
}

interface CachedBook {
	fingerprint: string;
	chunks: LibraryChunk[];
	keyword: KeywordIndex;
	vectors: { vectors: Float32Array; dim: number } | null;
	vectorsModel: string | null;
}

export function createLibrarySearcher(deps: LibrarySearcherDeps): LibraryReader {
	const cache = new Map<string, CachedBook>();

	function searchable(): LibraryBook[] {
		return deps.store.listBooks().filter((b) => b.status === "ready" && b.chunkCount > 0);
	}

	function load(book: LibraryBook): CachedBook {
		const fingerprint = `${deps.store.fingerprint(book.id)}:${book.embeddings?.model ?? ""}`;
		const hit = cache.get(book.id);
		if (hit && hit.fingerprint === fingerprint) return hit;
		const chunks = deps.store.readChunks(book.id);
		const entry: CachedBook = {
			fingerprint,
			chunks,
			keyword: buildKeywordIndex(chunks),
			vectors: book.embeddings ? deps.store.readVectors(book.id, book.embeddings.dim) : null,
			vectorsModel: book.embeddings?.model ?? null,
		};
		cache.set(book.id, entry);
		return entry;
	}

	return {
		hasBooks: () => searchable().length > 0,

		async search(query, opts = {}) {
			const notes: string[] = [];
			const all = deps.store.listBooks();
			const indexing = all.filter((b) => b.status === "indexing");
			let pool = searchable();
			if (opts.book) {
				const ref = resolveBook(all, opts.book);
				if (!ref.ok) return { hits: [], notes: [ref.error] };
				if (ref.book.status !== "ready") return { hits: [], notes: [`"${ref.book.title}" isn't ready yet (${ref.book.status}).`] };
				pool = pool.filter((b) => b.id === ref.book.id);
			}
			if (pool.length === 0) {
				return { hits: [], notes: [all.length === 0 ? "The library is empty — the learner hasn't imported any PDF yet (Settings → Library)." : "No searchable book yet."] };
			}
			if (!opts.book && indexing.length > 0) notes.push(`Still indexing, not searched yet: ${indexing.map((b) => `"${b.title}"`).join(", ")}.`);

			const cached = pool.map(load);
			const limit = Math.max(1, Math.min(opts.limit ?? 6, 12));
			const keyword = bm25Search(cached.map((c) => c.keyword), query, CANDIDATES);

			let meaning: ReturnType<typeof vectorSearch> = [];
			const embedder = deps.embedder();
			const withVectors = cached.filter((c) => c.vectors && c.vectorsModel === embedder?.model);
			if (embedder && withVectors.length > 0) {
				try {
					const q = await embedder.embedQuery(query);
					const raw = vectorSearch(
						cached.map((c) => (c.vectors && c.vectorsModel === embedder.model ? c.vectors : null)),
						q,
						CANDIDATES,
					);
					const top = raw[0]?.score ?? 0;
					meaning = raw.filter((h) => h.score >= MIN_MEANING_SCORE && h.score >= top - MEANING_BAND);
				} catch (err) {
					notes.push(`Meaning search unavailable (${err instanceof Error ? err.message : String(err)}); keyword results only.`);
				}
			} else if (cached.some((c) => !c.vectors)) {
				notes.push("Some books have no meaning index yet — results for them are keyword-only.");
			}

			const fused = fuseRankings(keyword, meaning, limit);
			const hits: LibraryHit[] = fused.map((f) => ({
				book: pool[f.set]!,
				chunk: cached[f.set]!.chunks[f.chunk]!,
				score: f.score,
				via: f.via,
			}));
			return { hits, notes };
		},

		read(bookRef, pagesSpec) {
			const all = deps.store.listBooks();
			const ref = resolveBook(all, bookRef);
			if (!ref.ok) return { ok: false, error: ref.error };
			const { book } = ref;
			if (book.status !== "ready") return { ok: false, error: `"${book.title}" isn't ready yet (${book.status}).` };
			const lo = book.kind === "slidescribe" ? 0 : 1;
			const wanted = parseLibraryPages(pagesSpec, lo, book.pageCount);
			if (wanted.length === 0) {
				return { ok: false, error: `Page spec "${pagesSpec}" matched nothing in "${book.title}" (${book.pageCount} pages). Use 'all', '5', '3-7' or '1,4,9'.` };
			}
			const byPage = new Map<number, LibraryChunk[]>();
			for (const c of load(book).chunks) {
				const list = byPage.get(c.page) ?? [];
				list.push(c);
				byPage.set(c.page, list);
			}
			return { ok: true, book, pages: wanted.map((page) => ({ page, chunks: byPage.get(page) ?? [] })) };
		},
	};
}
