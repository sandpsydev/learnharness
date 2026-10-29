# LearnHarness Medical — fork spec

Status: **approved by owner** (2026-10-29). The build plan is implemented in PRs #1–#9 on the fork.

This is a **build plan**: what to change in the LearnHarness code and prompts to make the medical version. The running app never reads this file.

## Learner profile (design target)

- Clinical-year medical student. The aim is broad, deep medical understanding: becoming a better doctor with less friction and time spent. Exams are checkpoints along the way, not the goal: Thai NL 1/2/3 and USMLE. Practice questions follow the shared NL/USMLE single-best-answer vignette style.
- Studies from PDF lecture slides and PDF textbooks. Long-term spacing lives in Anki.
- Teaching language: **English only**. Prompts address the learner as **"you"**.

## Phase 1 — Prompt changes (no code)

### 1.1 Pronoun rewrite
All prompt fragments (`src/agent/system-prompt.md`, `src/agent/prompts/**`) and tool descriptions: "he/his/him" → "you/your".

### 1.2 Medical accuracy tiers — replaces `shared/15-accuracy.md`
| Tier | Covers | Rule |
|---|---|---|
| Settled | anatomy, physiology, pathophysiology, classic signs, drug mechanisms | Learner's PDFs are ground truth. No citations. Existing "verify on doubt" rule applies. |
| Changing | management, first-line drugs, doses, guideline thresholds, screening schedules | Must be grounded in a source and cited inline (short tag: guideline + year, or book + page). Source order: current international guidelines / UpToDate-level evidence → learner's PDFs → textbooks. Unsourced management facts are explicitly flagged "unverified". |
| Conflict | learner's PDF disagrees with current international guidance on management | Teach the international answer; note the PDF's version and that local/exam answers may differ. |

Cost guard: citations only on Changing-tier facts — never on settled science.

### 1.3 Arbitrary facts — new teacher fragment `teacher/06-medical-facts.md`
Amends the method (`05-method.md`) for medicine:
1. **Derive everything that has a "why"** — first principles as now.
2. **Real rationale when one exists** for non-derivable facts (why a cutoff sits where it does: the trial, the statistic, the history). **Never invent a rationale.**
3. If still arbitrary: state it plainly, mark it **[memorise]**, and suggest it for Anki export.
4. **Mnemonic policy:** no first-letter acronyms ("I WATCH DEATH" style). Memory hooks are reserved for *discriminating look-alikes*: disease A vs B, drug X vs Y — built on the one or two high-yield differentiating features, ideally mechanistic.

### 1.4 Bedside endpoint — added to `teacher/20-teaching.md`
Every mechanism chain ends at its clinical consequence: the sign, lab finding, imaging finding, drug effect or exam buzzword it produces.

### 1.5 Practice vignettes — added to `practice/10-doctrine.md`
- Two new demand formats, mapped onto existing modes:
  - **Single-best-answer MCQ** (NL style: stem + 5 options) — natural fit for *discrimination*; distractors are the live confusables.
  - **Free-response next-step** (diagnosis / next best investigation / management in own words) — *recall* or *composition*.
- Out of scope (owner): lab/ECG/image interpretation, long-case MEQ, separate interactive case mode.

## Phase 3 — Clickable MCQ (code)

- `problem` tool schema (`src/agent/tools/practice.ts`): optional `options` (exactly 5, A–E) + `correctOption` + per-option `optionRationale` (hidden until conclude, like `modelSolution`).
- Practice UI (`components/`): A–E options alongside the existing thinking field. **Select, then Submit** (owner decision): clicking picks an option and it can be changed; a Submit button sends the chosen option plus the thinking text as a claimed answer.
- On conclude: reveal correct option and why each distractor is wrong.
- Grading stays the agent's (hint ladder, miss classification unchanged).

## Phase 4 — Knowledge graph tags (code)

The existing graph (propositions + reasoning chains, linked to their sessions) is kept as is; two optional fields are added to each node.

- **Organ system** (one or more): Cardiovascular, Respiratory, Renal/Urinary, GI/Hepatobiliary, Endocrine, Reproductive/Obstetrics, Neurology, Psychiatry, Musculoskeletal, Dermatology, Haematology/Oncology, Infectious disease/Immunology, General principles (pharmacology, biochemistry, genetics, biostatistics). Multi-system facts carry several (e.g. diabetic nephropathy → Endocrine + Renal).
- **Fact type** (one): mechanism, clinical feature, diagnosis/investigation, management, memorise.
- **Assigned by** the extraction step (`src/agent/subagents/extraction.ts`) when it saves propositions, and by notes import. First assignment sticks, like the node name; the learner can edit both on the node's detail card.
- **Graph view:** current layout unchanged (owner decision); add filter chips for system and fact type.
- **Downstream:** Anki uses the system tag to pick the deck (`LearnHarness::Cardio`, …); practice can target "management facts in Renal", etc.
- Existing nodes without tags stay valid (fields optional); a one-off "tag existing nodes" action back-fills them.

## Phase 5 — Anki export (code)

- **Trigger:** on demand only — a "Make Anki cards" action on (a) a session, (b) selected graph nodes, (c) a library PDF section.
- **Generation:** a background sub-agent (Workbench job) drafts cards; learner reviews/edits/deletes in a review panel before push.
- **Card types:** Cloze; Basic Q/A; Mechanism "why" (chain on back); Mini-vignette (2–3 line stem → diagnosis/next step). Content kinds: mechanism, DDx, labs, approach, management, [memorise] facts.
- Same mnemonic policy as 1.3. Management cards carry their source tag.
- **Delivery:** AnkiConnect (`http://127.0.0.1:8765`) — push to a running Anki desktop. Clear error when Anki/AnkiConnect isn't running.
- **Organisation:** deck per system (`LearnHarness::Cardio`, `::Renal`, …, chosen by the agent, overridable on export); tags: `lh::topic::…`, `lh::type::{ddx,labs,approach,mechanism,management,memorise}`, `lh::session::<id>`.
- Duplicate guard: skip cards whose front already exists in the target deck (AnkiConnect `canAddNotes`).

## Phase 6 — PDF library (code)

- **Import once:** Settings → Library: add PDFs (slides, textbooks). **Copied into the app's data dir** (owner decision), so moving or renaming the originals never breaks citations; one index per book.
- **Image-heavy pages, asked per PDF** (owner decision): at import, choose "text only" (fast, free) or "ChatGPT vision describes image-heavy pages" (slower, uses Plus quota). Textbooks are usually text-rich; slides are the main case.
- **SlideScribe lectures (manual import, owner decision):** the learner's SlideScribe project (`~/work/firstmate/projects/slidescribe`) writes one Markdown note per lecture into its vault (`vault/SlideScribe/<course>/<lecture>.md`). Frontmatter includes `title`, `course`, `source_pdf`, `slide_count`; the body has one `## Slide N: [title]` section per PDF page with *Takeaway*, *On the slide* (vision description), *Explained*, *Key terms* and *Links*, plus ▶ timestamps, ⭐ lecturer-stressed and ⚠ / "(AI read — verify)" marks.
  - Settings → Library → "Import SlideScribe note": pick the `.md`; the app finds its PDF via `source_pdf` (or asks), copies both, and indexes **per slide section** (no vision pass needed; SlideScribe already did it).
  - Citations read "<lecture title>, slide N".
  - **Trust:** the whole note counts as the learner's material, ground truth for the settled tier (owner decision). The note's own ⚠ / "(AI read — verify)" marks are kept and shown when that passage is cited.
  - SlideScribe notes never feed the knowledge graph (owner decision); library search only.
- **Indexing:** page text via existing `pdf-ops`; chunk by page/section; keyword index + embeddings from a small embedding model that runs locally on the Mac (free, offline, no API key; upstream removed its provider embedder). TOC/outline captured where the PDF has one.
- **Agent tool:** `library_search(query)` → ranked passages with `book + page`; `library_read(book, pages)`. Available to prober, teacher, practice, and Anki generator.
- Teacher grounds settled-tier teaching on the learner's books when relevant and cites `book p.N` when it does.
- Indexing a large textbook takes a few minutes once, with a progress bar; no money cost.

## Repo / workflow

- Public GitHub fork of `amosblomqvist/learnharness` under the owner's account; work on branch `medical` (the fork's default branch); `main` mirrors upstream and is merged into `medical` periodically.
- **This spec is the approved plan.** It overrides the repo's "get the plan approved first" rule for anything it covers; workers do not re-ask for approval of what is decided here.
- **Built with Firstmate** (owner's crew system, `~/work/firstmate`): the first mate dispatches each task below to a crewmate in its own worktree.
  - **Delivery: direct-PR into `medical`, auto-merge (`+yolo`)** once checks pass (owner decision). Every PR description says in plain English what it changed and lists every design choice the worker made that this spec didn't settle.
  - **Undecided details:** the worker picks the sensible default, records it in the PR, and doesn't block (owner decision; the owner is mostly away). Only escalate what can't be undone or breaks a decision in this spec.
  - **Gate per PR:** `npm run lint`, `npm run typecheck`, `npm test` green.
  - **Routing:** per the owner's Firstmate dispatch rules (planning → Opus, hard implementation → Sonnet, routine → Codex).

### Task breakdown

| Task id | Scope | Depends on | Notes |
|---|---|---|---|
| `med-prompts` | Phase 1 (1.1–1.5) | none | Prompt files only. |
| `med-graph-tags` | Phase 4 | none | Graph contracts, extraction, notes import, node card, filter chips. |
| `med-practice-filter` | Phase 4 downstream practice: add all shown filtered nodes to the selection; pass system/fact-type context and favour next-step vignettes for management. | `med-graph-tags` | Additive selection in practice-select mode. |
| `med-library` | Phase 6 incl. SlideScribe import | none | New store + tools + Settings UI; local embedding model. |
| `med-verify-app` | Phase 2, app side | none | Evidence routing in prompts/tools; verify queue + provisional marks; local API the extension talks to; PubMed / Europe PMC tools. |
| `med-extension` | Phase 2, Chrome extension | `med-verify-app` | Skeleton, app link, highlight-to-send. **Expert AI page selectors need the owner present** (inspect the logged-in page once). |
| `med-mcq` | Phase 3 | `med-prompts` | Both touch the practice doctrine. |
| `med-anki` | Phase 5 | `med-graph-tags` | Deck per system tag. Owner must have Anki desktop + AnkiConnect (add-on `2055492159`) for the live test. |

Wave A (parallel): `med-prompts`, `med-graph-tags`, `med-library`, `med-verify-app`. Wave B: `med-mcq`, `med-anki`, `med-extension`.

## Evidence sources for the Changing tier

### Routing — the tutor picks the source by question type

| Question type | Source | Run by |
|---|---|---|
| Management principles, clinical judgement, "approach to", first-line choice and why, nuanced comparisons | **UpToDate Expert AI** (main source for management) | learner click, via extension |
| Exact guideline text, thresholds, dosing tables, recent changes, Thai guidelines | Web search (Tavily free tier; the app's search backend) over open guidelines (NICE, ESC, AHA/ACC, IDSA, KDIGO, GOLD, GINA, WHO, Thai societies) | agent, automatic |
| Primary evidence, trial results, references cited in Expert AI answers | PubMed / Europe PMC official APIs | agent, automatic |

### UpToDate Expert AI loop (Phase 2 — Chrome extension)

The line: the app never queries UpToDate by itself. Every query starts with a learner click or keypress and runs one at a time in the learner's visible, logged-in tab (Mahidol access). Nothing runs in background or hidden tabs, and nothing is disguised as human usage.

- **Queue built ahead:** at plan time the teacher writes the lesson's Expert AI questions up front: well-formed prompts with patient context, asking for the guideline basis. Questions that come up mid-session are appended.
- **Non-blocking (owner decision):** teaching continues meanwhile. Management claims taught before their check are marked *provisional* and corrected automatically when the answer arrives.
- **Ask, one click:** clicking a queue item (or pressing a shortcut) focuses Expert AI in the learner's tab, fills in the prompt and submits it.
- **Return, one click:** a "Send to LearnHarness" button next to the answer sends its text and reference links to the app. "Send & ask next" chains to the next queued item, so the steady state is one keypress per question.
- **After return (automatic):** the tutor compares the answer with what it taught, corrects anything that differs and cites "UpToDate Expert AI, [date]". PMIDs/DOIs in the answer are fetched from PubMed for cross-checking, and key points are offered for Anki.
- **Any page:** highlight text, then "Send to LearnHarness", for guidelines, papers or PDFs open in the browser.
- **Target:** Chrome (Manifest V3; also runs in Edge, Brave, Arc).
- **Access (owner's setup):** Mahidol network (campus ethernet/wifi) plus the learner's own UpToDate sign-in, which stays logged in. Expert AI lives at `https://ai.uptodate.com/?dpRedirect=false`; when logged in, the page opens straight onto the question box. The extension matches `https://ai.uptodate.com/*` only.
- **Page layout (owner screenshot, 2026-10-29):** "Ask a medical question…" box, a response-mode dropdown (default "Standard"), mic button, submit arrow, and a "New conversation" button; the sidebar lists past conversations. The page warns "Do not input any personal data, including PHI", so generated prompts are always generic: never names, hospital numbers or other identifiers, even if the learner mentions a real patient. Expert AI is labelled an experimental Gen-AI pilot, so its answers are still cross-checked against the PubMed references they cite.
- **Conversations (owner decision):** every question starts a fresh conversation ("New conversation" first), so each answer is independent. Each prompt is therefore fully self-contained.
- **Mode (owner decision):** always "Standard"; the extension never touches the dropdown.
- **Not logged in / off network:** if the page shows a sign-in or access screen instead of the question box, the extension does nothing and tells the learner to sign in (or use the uni network); the question stays queued.
- **Config:** Expert AI URL (default above); local app address.
- **Maintenance risk:** UpToDate UI changes can break fill/send. Fallback: prompt on the clipboard, manual paste-back.
- OpenEvidence: not integrated (no confirmed public API / eligibility outside US HCPs).
- **Excluded by design:** any AI agent operating the browser to query UpToDate and read its answers. That includes ChatGPT's own agent/computer-use mode, other computer-use agents and autonomous extensions. It is the same automated access the licence forbids, whichever AI drives it. Every query starts with the learner's click.

## Models

Owner constraint: **no paid API keys**; run on existing subscriptions (Claude Pro, ChatGPT Plus, Google AI Pro).

- **ChatGPT Plus → every model role inside the app** (teacher, prober, practice, extraction, researcher, vision), via the app's native ChatGPT sign-in. Usage counts against the Plus plan's limits.
- **Claude Pro → building only** (Claude Code). The app has no Claude-subscription sign-in.
- **Google AI Pro → not used by the app** (no API access; the app's Google provider needs a Gemini API key).
- **Embeddings:** local model (Phase 6); the graph itself needs none.
- **Free, no-payment services:** Tavily free-tier key for web search; PubMed / Europe PMC need no key.
- **Google AI Pro must never be connected to pi or this app:** Google suspends accounts whose Gemini CLI/Antigravity logins are used in third-party tools.

### Engine decision (owner, 2026-10-29)

Stay on the existing **pi engine with ChatGPT**. Possible future migration to the Claude Agent SDK only if needed. Known constraints for that day:
- Anthropic requires an API key for third-party apps (no claude.ai login), so a migration does not by itself unlock Claude Pro.
- pi is what provides ChatGPT sign-in and the other providers; dropping it loses them unless both engines are kept.
- The swap seam is the agent layer + `src/server/pi/` bridge; see the upstream precedent in `docs/pi-engine-swap.md`.
- Every medical feature here is built against the engine-neutral seams (tools, prompts, stores), so it carries over unchanged.

## Later (not in this build)

- **Export graph to Obsidian:** one-way export; each proposition becomes a note and each chain becomes `[[links]]` from premises to conclusion, so the graph sits beside the SlideScribe vault. Revisit after the owner has used the app (owner, 2026-10-29).

## Open items

- Complete the first ChatGPT sign-in in the app.
- Add a free Tavily key for web search.
- Push the first reviewed cards to Anki with Anki desktop and AnkiConnect running.
- Ask the first live Expert AI question and send the answer back; note whether "Send to LearnHarness" appears before the answer finishes streaming.
- Import the first PDF or SlideScribe note into the library.
