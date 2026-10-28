# The PDF library (medical fork, Phase 6)

Settings → Library lets the learner import PDFs (lecture slides, textbooks) and SlideScribe lecture notes. The prober, teacher and practice agents search them with `library_search` and `library_read` and cite what they use as `book p.N` (a lecture note: `<lecture title>, slide N`). The build plan is [`medical-spec.md`](medical-spec.md) Phase 6.

## What lives where

| Piece | File |
|---|---|
| Shapes the UI and stores share | `src/core/contracts/library.ts` |
| Pure brain: chunking, SlideScribe parser, BM25, vector ranking, rank fusion, citations | `src/core/library.ts` |
| Storage port + fs adapter (`data/library/<bookId>/`) | `src/core/ports.ts` (`LibraryStore`), `src/store/library.ts` |
| Page text, image counts and outline through the existing `pdf-ops` | `src/agent/subagents/pdf-ops.ts` (`readPdfBook`) |
| Indexer (reading → optional vision → chunks → embeddings) | `src/agent/library/indexer.ts` |
| Vision pass (ChatGPT describes image-heavy pages) | `src/agent/library/vision.ts` |
| Local embedding model | `src/agent/library/local-embedder.ts` |
| Hybrid searcher (keyword + meaning) | `src/agent/library/searcher.ts` |
| The two agent tools | `src/agent/tools/library.ts` |
| Import runs, queue, vision/embedder wiring | `src/server/library.ts` |
| HTTP | `app/api/library/**` |
| Settings UI | `components/settings/library-section.tsx` |
| Prompt text | `src/agent/prompts/shared/35-library.md`, `src/agent/prompts/teacher/07-library.md` |

## On disk

`data/library/<bookId>/` holds the library's own copy of the PDF (`source.pdf`), the SlideScribe note when there is one (`note.md`), `book.json` (the record, with live progress), `chunks.jsonl`, and `vectors.f32` (one unit vector per chunk, optional). Moving or renaming the original files never breaks a citation.

## Indexing

1. **Reading** — one pdfjs pass: line-aware page text, painted-image counts, the outline (TOC).
2. **Vision (only if the learner chose it for that PDF)** — pages with a painted image and little text, or a few drawn labels, are rendered and described by the vision slot's model (the ChatGPT sign-in). Capped at 300 pages per book. The description is stored under `[Image description — AI read, verify]`. Five failures in a row stop the pass; the rest is indexed as text and the book says so.
3. **Chunking** — one chunk per page (a long page splits on line boundaries, ~1400 characters); each chunk carries its outline path as `section`. SlideScribe notes: one chunk per `## Slide N:` section, no vision pass.
4. **Embeddings** — the local model embeds each chunk. If the model can't load (first run offline) the book is still **ready** with keyword search and a notice; "Retry search model" rebuilds only the vectors.

Books index one at a time. A book left `indexing` by a process that died is shown as interrupted, with Retry.

## Search

Keyword (BM25, pooled statistics across books) and meaning (cosine over the vectors) rankings are fused with reciprocal-rank fusion. Meaning hits under cosine 0.5, or more than 0.12 below the best, are dropped, so an unrelated query returns nothing rather than the nearest junk. Search never triggers the model download: it uses the embedder only when the model files are already on disk.

## SlideScribe notes

The parser matches `slidescribe/assemble.py`: frontmatter (`title`, `course`, `source_pdf`, `slide_count`, …), `## Slide N: title` sections, an optional `## Extra from the lecture`, and a trailing `## Run notes` that is not indexed. `source_pdf` is only a file name, so the importer takes the PDF from the same file picker, or asks for it by name. The note's `⚠` and `(AI read — verify)` marks are detected per chunk and printed next to the passage whenever it is returned. Notes never touch the knowledge graph.

## The local embedding model

`BAAI/bge-small-en-v1.5`, int8 ONNX export (`Xenova/bge-small-en-v1.5` at a pinned revision), MIT license, 384 dimensions, ~34 MB weights + 0.7 MB tokenizer. Runtime: `onnxruntime-node` (native) with `@huggingface/tokenizers` (pure JS), CLS pooling, L2-normalised; queries get bge's instruction prefix. The files are downloaded once from the pinned revision, checked against SHA-256 hashes in `EMBEDDING_MODEL`, and cached in `data/models/`; after that nothing touches the network. Tests never download weights: they use a fake embedder, and a live test runs only when `LH_LIVE_EMBED_DIR` points at a downloaded model.

## Seams for later work

- **Anki generator (`med-anki`)**: spread `libraryTools({ reader })` from `src/agent/tools/library.ts` into its own registry; `library.reader` and `library.toolContext()` (`src/server/library.ts`) supply the reader. "Make Anki cards from a library PDF section" can read a section through `reader.read(book, pages)`.
- **Agents**: `ProberToolContext`, `TeacherToolContext` and `PracticeToolContext` each take an optional `library` context; `chat-handler.ts` passes it only while the library has a searchable book. A user toggle `agent.tools.library_search = false` (or `library_read`) removes a tool through the existing generic tool filter.
