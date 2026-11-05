# LearnHarness Medical — fork spec

Status: **approved by owner** (through Phase 9, 2026-10-30). The build plan is implemented through Phase 9 on the fork.

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

## Phase 7 — Explain my miss (owner-approved 2026-10-29)

You bring in a question-bank question you got wrong (UWorld, AMBOSS, NL past papers). The tutor finds the one gap behind the miss, teaches only that gap, and checks it with a twin question.

- **Entry:** an "Explain my miss" action on the new-session screen starts a teaching session (kind `teach`, so graph extraction runs as normal) in the miss flow. **One missed question per session** (owner decision).
- **Input (owner decision: both):** paste the question text, or paste a screenshot straight into the chat box with Cmd+V. A pasted image is saved into the data dir and attached through upstream's file-attachment and image path, so the model sees it. Dragging a screenshot file in also works. The learner says which option they chose. The correct answer and the bank's explanation are optional. A pasted explanation is just another source: management claims in it still follow the accuracy tiers (1.2).
- **Flow:**
  1. Read the question, then ask why you picked your answer: one short question, with a follow-up only if needed. Never explain before hearing your reasoning.
  2. Name the root gap in one line, using the practice miss classes in plain words: missed a clue in the stem (cue), confused look-alikes (discrimination), knew it but slipped in the steps (execution), careless, or missing underlying knowledge (structural).
  3. Teach only that gap, with the normal teacher method: derive, end at the bedside, a look-alike hook for discrimination misses, accuracy tiers and citations for management, and the library first where it's relevant.
  4. **Twin question (owner decision):** one fresh single-best-answer vignette testing the same concept from a different angle, clickable A–E as in Phase 3. If it's missed, reteach once from the new angle.
- **The bank's content:** it is never copied word for word into graph nodes, session titles or cards. Concepts are written in the tutor's own words. Question text and screenshots stay in the local data dir.
- **Not included (owner decisions):** no batch mode, no automatic Anki offer (the existing session "Make Anki cards" action still works), no miss log.

## Phase 8 — Pocket mode (owner-approved 2026-10-29)

The learner uses LearnHarness from their phone on the ward, while the Mac at home does the work. The quick parts are on the phone; the heavy parts stay on the Mac.

- **Connection:** one command on the Mac turns phone access on. It runs the app in browser mode, listening on 127.0.0.1 only and never 0.0.0.0, on a fixed port. It keeps the Mac awake while phone access is on and prints the phone link. The phone reaches it through **Tailscale Serve** (tailnet-only HTTPS); never **Funnel** (public). Browser mode has no login, so tailnet-only is the security boundary. The desktop app's per-window API lock stays as it is.
- **One graph:** phone and Mac share the same data. While pocket mode is on, the Mac also uses the browser-mode link instead of the desktop app. Two servers never write the same data dir at once.
- **On the phone:**
  1. **Capture inbox (build first):** type a question or topic in seconds (the phone keyboard's dictation works). Text only: no photo or file attachments (owner decision, patient privacy), and a "no patient identifiers" reminder on the box. Captures show on the Mac's home screen as "Tonight's questions". One tap starts a teaching session on one; captures can be marked done or deleted. A capture can also be started right away from the phone.
  2. **Quick practice:** a short tap-to-answer A–E round from the learner's graph, filterable by organ system (e.g. the current rotation).
  3. **Short sessions:** start or continue a teaching session, laid out for a phone screen (including Explain my miss).
  4. **Expert AI queue, view only:** see the waiting questions; asking stays at the Mac.
- **Stays on the Mac:** asking Expert AI (Chrome extension), the Anki review panel, PDF and SlideScribe import, the graph view, and settings.
- **Cost:** none. Tailscale's free personal plan; the models still run on ChatGPT Plus.

Undecided details are the crew's call, listed in the PR. For example: the port, how the launcher finds and reuses the desktop app's data folder, how it refuses to start while the desktop app is running, the capture storage format, and the phone breakpoints.

## Phase 9 — Faster, deeper teaching (owner-approved 2026-10-30)

Goal: harder and faster. Time goes where the learner's understanding is thin, and every question sits at the edge of what they can do. Kept deliberately simple, with one planning procedure and one pacing principle, so the tutor adapts by judgment rather than by tuned settings. Probing is unchanged.

- **Probe verdict:** `probe_done` records a status for each area: **hold**, **shaky** or **gap**. The plan is built from it.
- **Planning procedure:** every plan is presented in the same short shape:
  1. **Goal:** one sentence on what the learner will be able to do at the end, framed at the bedside (recognise, explain, decide).
  2. **Already yours:** what the probe shows the learner holds. Never re-taught; at most one test-out question each. Taught only if that question is missed.
  3. **To build:** the gaps on the path to the goal, ordered by clinical weight (danger and first move first), each with a one-line reason it matters at the bedside.
  4. **Optional deeper:** worthwhile off-path items, listed but not taught unless the learner picks them.
  5. **Rough time** for the plan.
  An emphasis request picks from Optional or reshapes the goal; it never stacks extra steps on top. If it clashes with the probe ("you're already strong there"), the tutor says so in one line before changing the plan.
- **Sources at planning time:** when the library covers the topic, the tutor checks the learner's lecture slides and books for what their faculty emphasises, and may add a To-build item the probe missed. A book's chapter outline never becomes the plan: books set accuracy and emphasis, not scope.
- **Depth matches scope:** a broad topic (for example a lecture covering many conditions) gets a solid overview: the shared framework that ties the conditions together, and for each condition the must-know points, core pathophysiology and basic management. It is never a vague list. Conditions that deserve more are offered as deep dives, which the learner can send to Tonight's questions. A single-condition topic goes all the way down. The tutor judges which kind a topic is.
- **Pacing principle — every answer moves the edge:**
  - **Right and confident:** the next question goes up the ladder, harder and more real-world. Apply it to a new case; then a case with a twist (a comorbidity, a drug, a misleading clue); then a real ward decision (what you do now, what you watch for, when you call your senior). A right answer earns a harder question, not more of the same.
  - **Wrong or unsure:** step back, build in smaller steps, then climb again.
  - Prediction questions only where discovering the next step is worth it, usually in To-build. Never for material the learner holds.
- **"I know this — test me":** a button on the current step (and the same phrase in chat). It skips the explanation and asks one hard applied question; right moves on, wrong teaches the step.
- **Plan view:** the map shows which nodes are Already yours, To build and Optional.

Undecided details are the crew's call, listed in the PR, as usual: for example, the shape of the probe-status field, how the map shows the three groups, and where the button sits.

## Automatic Expert AI (owner-approved 2026-10-30)

The owner chose fully automatic asking and return, removing the earlier click-only and autonomous-browser exclusions after the institutional-access risk and loss of prompt review were explained. `verify_queue` remains the tutor's trigger for management questions it should not answer from memory. The extension polls the paired local queue using Chrome alarms, survives service-worker sleep, and processes one screened prompt at a time in its own background tab without focusing the learner's window. Each question starts a fresh Standard-mode conversation; the dropdown is never changed. Only the queued prompt is sent.

Automatic mode defaults on and has an off switch in extension settings. Sign-in, pop-ups, page failures and uncertain submissions pause it with a toolbar badge and a plain popup notice; it never signs in or resubmits an uncertain question. An untouched question stays queued. Finished answers return with sources through the existing hand-off and notice; manual asking, copy/paste return, Send and highlights stay available. Live checks belong to the owner; development uses generic fixtures only.

## Knowledge organizer (owner request 2026-11-04)

An agent on the graph page that arranges the learner's graph as they ask: create nodes, rename them, edit a node's statement, change its tags, and add, remove or change connections. Open it with **Organize** in the graph's top-right row.

- **Careful by construction.** The learner stays in control. The agent only *proposes*: it looks at the graph with read tools (`graph_overview`, `find_nodes`, `list_nodes`, `get_node`) and hands over a set of changes with `propose_changes`. The panel shows each change as before → after. Nothing is written until the learner presses **Accept**; **Reject** discards it. An applied set can be **undone** while it is the newest one.
- **All or nothing.** A set is checked as a whole, at proposal time and again at Accept against the graph as it is then. Any problem rejects the entire set with the reasons; nothing is half-applied. Rules enforced: ids are minted by the store (the agent refers to a new node by a short `ref`); a connection has at least one premise, existing nodes at both ends, no node as its own premise, no duplicate of an existing connection, no loop, and is not one the graph's own simplification pass would drop as redundant; tags come from the fixed organ-system and fact-type lists (an unknown tag is a rejection, not a silent drop); names are short (80 characters) and statements one sentence (600); a statement the graph already holds is refused as a duplicate. Accept and Undo return 409 while an extraction run is in flight, like deleting a node.
- **Not offered:** deleting or merging nodes (not asked for; a possible follow-up).
- **Prompt** (`src/agent/prompts/organizer/`, same fragment style): organize into the existing structure; use the existing tags, never invent near-duplicates; prefer the learner's wording; look for duplicates before creating; keep medical content unchanged unless asked and never add facts; ask one short question when an instruction is ambiguous.
- **Engine.** A new model role, `organizer`, on the strong slot, run on the existing pi engine and the ChatGPT sign-in; no new provider or key. The learner's request is a foreground request, not a background one.
- **How edits land.** A new node has no session (the learner made it) and its tags are marked learner-edited, so extraction never overrides them; deleting an unrelated session no longer takes such a node with it. A rename or statement edit changes the node's defining ledger line (the old statement stays as an alias). Tag changes append a learner-edit line, as the detail card does. Connections are added, removed or replaced in the chain ledger. Each applied set is journalled as a line-level diff (`data/graph/organizer-history.json`, last 20), so Undo restores the exact lines. Undo refuses, changing nothing, if something else has since edited those lines or built on a node the set created.
- **Files:** `src/core/graph-organizer.ts` (checks, apply, undo), `src/agent/tools/graph-organizer.ts` and `src/agent/subagents/organizer.ts` (agent), `src/server/graph-organizer.ts` and `app/api/graph/organizer/` (service, routes), `components/graph-organizer.tsx` (panel).

## Obsidian copy and Review mode (owner request 2026-11-05)

Two linked parts. LearnHarness stays the source of truth; Obsidian is a copy to read and add to. Nothing written in Obsidian ever flows back into the graph, except that the learner's own text under **My notes** is kept.

### A. The live copy of the graph

- **Setting.** Settings → **Obsidian** has one field, the vault folder. The copy is off until it is set. A suggested folder (`~/SlideScribe/vault`, if it exists) is offered with one click and never applied on its own; the app does not guess a vault or create one.
- **Where it writes.** Only inside one app-owned folder, `<vault>/LearnHarness/`. Every other file in the vault is never created, changed or deleted. The write layer (`src/store/obsidian-vault.ts`) refuses any path that leaves the folder, including `..`, absolute paths and a symlink inside the folder that points out. Layout: `Nodes/`, `Systems/`, `Illness scripts/`, `Attachments/` (images). Notes the learner adds to that folder are theirs: left alone, and their names are never reused.
- **A note per node.** The node's name is the file name (made safe: no `\ / : * ? " < > | # ^ [ ]`, no hidden or reserved names, at most 90 characters). Two nodes with one name never share a file: the older keeps the plain name, the other gets its id tail, `Preload (0001)`; links show the real name. The statement is the body; older wordings are Obsidian `aliases`; organ systems and the fact type are tags (`system/renal`, `fact/management`); **Because** lists the premises of each chain that concludes at the node and **Leads to** lists what it helps conclude (with its co-premises); a node that came from an imported notes file links back to that lecture note by name (`[[Lecture 4 - AKI]]`). One index note per organ system (`System - Renal-Urinary`, grouped by fact type), plus `System - Untagged` when some node has no system.
- **App-written notes are marked.** Frontmatter carries `lh_managed: true`, `lh_kind` and `lh_id`. Only such notes are ever rewritten, moved or removed.
- **My notes.** Every note ends with a marker line and a `## My notes` heading. Everything under the marker is the learner's and is carried over verbatim on every rewrite and every rename. If the learner deletes the marker, that note is left untouched from then on (the app can no longer tell their text from its own).
- **Live, no button.** The server watches the graph's revision (the newest ledger write, which moves on extraction, organizer accept/undo, deletion and tag edits alike) and the Settings record. A change schedules a **debounced** sync: 3 seconds after the last change, and at most 20 seconds of waiting under a steady stream. A sync rebuilds the desired notes, compares them with the vault, and writes only what differs, so renaming a node moves its note (keeping My notes) and fixes the links in every note that mentions it. A node that no longer exists has its note removed, but only a note the app wrote. If the learner had written under My notes in it, that text is kept as an ordinary note in `Removed nodes/` instead of being deleted. A sync also runs once at start-up to catch up. Settings shows what the copy is doing, what the last run changed, and a plain error when the folder is missing; "Update notes now" skips the wait.
- **Files:** `src/core/obsidian.ts` (naming, note rendering, My notes, the reconciler), `src/store/obsidian-vault.ts` (the confined vault), `src/server/obsidian.ts` (debounced live sync), `app/api/obsidian/route.ts`, `components/settings/obsidian-section.tsx`.

### B. Review mode: illness scripts

- **A third mode** beside Teach and Practice on the home composer. The learner types one illness ("acute pancreatitis") and sends it: that writes the script, with no session. The panel above the composer lists the scripts written, each marked up to date or out of date, with the **Write scripts for every illness** button, progress, and **Stop**.
- **Do-all.** One script at a time. First the illnesses in the graph are listed (a model pass over the graph in batches of 220 nodes by organ system, each illness with the nodes that belong to it; the list is kept and reused until the graph changes). Scripts that are already up to date are skipped. Progress shows the current illness, a bar, and written / already-current / failed counts. Stop cancels the script in progress (nothing of it is saved) and starts no more. Three failures in a row end the run with the error (a lost sign-in fails every script). Only one run at a time.
- **What a script is.** One long note per illness, organised by illness and not by lecture, in illness-script order: definition; who gets it (epidemiology, risk factors); pathophysiology; presentation (symptoms, signs); differentials; investigations; management; complications and prognosis; high-yield pearls. A mechanism map (a Mermaid flowchart of the learner's own connections among the script's graph notes) sits in the pathophysiology section.
- **Sources, each fact cited.** The scriptwriter reads the graph (`find_nodes`, `get_node`), the library (the existing `library_search` / `library_read`) and the Expert AI answers the learner collected (`expert_search`, `expert_read`). Each claim carries its sources: graph notes as `[[links]]`, library passages as "<lecture>, slide N" or "<book> p.N", Expert AI answers as "UpToDate Expert AI, <date>". The check is mechanical: a citation to a node, page or answer the writer was not shown in that run is refused and the writer must fix it, so a citation cannot be invented.
- **Accuracy tiers carry over.** Management (always) and anything the writer marks as changing-tier needs a library page or Expert AI answer; one resting only on a graph note is allowed but rendered "unverified"; one with no source at all is refused. Settled science may be stated from general knowledge only when plainly marked "general knowledge, not from your sources", never for the changing tier. Where the learner's sources do not cover something, the section carries a **Not in your sources** note instead of filling from memory. Same mnemonic rule as teaching (no first-letter acronyms).
- **Images, only the learner's own.** A script may embed pages or slides of library PDFs that the writer read (at most ten), rendered from the library's own PDF copy at 100 dpi, and at most two app-drawn diagrams made by the existing visual-maker (skipped when no vision model is set or the SVG is not clean). Nothing from UpToDate or the web is ever copied. Images are stored in `LearnHarness/Attachments/` and embedded with `![[file|560]]`.
- **Out of date, never automatic.** A script is marked out of date when a node it was built from changed or was removed, the connections among its nodes changed, or a new node appeared that is plainly about the same illness (named in it, or connected to its nodes). The Review panel says why and offers **Refresh**; the vault note gains an "Out of date" banner. A script is only ever written when asked or by the do-all button, because writing one spends the owner's ChatGPT allowance. Refreshing keeps the learner's My notes. Script notes are never removed by the sync.
- **Engine.** A new model role, `scriptwriter`, on the strong slot, run on the existing pi engine and the ChatGPT sign-in; no new provider, no paid key, no Google or Gemini login. Run as a foreground request (the learner just asked).
- **Where it lives.** LearnHarness keeps its own copy of each script (`data/review/`: the script, its images, the illness list) and renders the vault note from it, so a moved or emptied vault is rebuilt by the next sync without spending anything. Writing scripts needs the vault folder to be set.
- **Files:** `src/core/illness-script.ts` (checks, freshness, rendering), `src/core/contracts/review.ts`, `src/agent/subagents/scriptwriter.ts` and `src/agent/tools/review-sources.ts` (agent), `src/agent/prompts/scriptwriter/`, `src/store/review.ts`, `src/server/review.ts` (runs), `app/api/review/route.ts`, `components/review-panel.tsx`.

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
| Management principles, clinical judgement, "approach to", first-line choice and why, nuanced comparisons | **UpToDate Expert AI** (main source for management) | extension, automatic by default; manual controls available |
| Exact guideline text, thresholds, dosing tables, recent changes, Thai guidelines | Web search (Tavily free tier; the app's search backend) over open guidelines (NICE, ESC, AHA/ACC, IDSA, KDIGO, GOLD, GINA, WHO, Thai societies) | agent, automatic |
| Primary evidence, trial results, references cited in Expert AI answers | PubMed / Europe PMC official APIs | agent, automatic |

### UpToDate Expert AI loop (Phase 2 — Chrome extension)

- **Queue built ahead:** at plan time the teacher writes the lesson's Expert AI questions up front: well-formed prompts with patient context, asking for the guideline basis. Questions that come up mid-session are appended.
- **Non-blocking (owner decision):** teaching continues meanwhile. Management claims taught before their check are marked *provisional* and corrected automatically when the answer arrives.
- **Ask:** automatic mode asks queued questions one at a time in an extension-managed background tab. Manual queue clicks and the shortcut still focus Expert AI and submit a fresh question.
- **Return:** automatic mode returns the finished answer and its sources without a click. "Send to LearnHarness", "Send & ask next" and manual paste-back remain available.
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

## Models

Owner constraint: **no paid API keys**; run on existing subscriptions (Claude Pro, ChatGPT Plus, Google AI Pro).

- **ChatGPT Plus → every model role inside the app** (teacher, prober, practice, extraction, researcher, vision, organizer, scriptwriter), via the app's native ChatGPT sign-in. Usage counts against the Plus plan's limits.
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

## Open items

- Set the Obsidian vault folder, then try the live copy on the real graph, and write the first illness script in Review mode (check the slide images, the "unverified" and "Not in your sources" marks, and that My notes survive a refresh).
- Try Phase 9 in a real teaching session: confirm the probe verdict shifts time toward gaps, an emphasis request reshapes scope, and test-out works on both Mac and phone.

- Complete the first ChatGPT sign-in in the app.
- Add a free Tavily key for web search.
- Push the first reviewed cards to Anki with Anki desktop and AnkiConnect running.
- Check the first live automatic Expert AI run in a background or unfocused tab. The owner has confirmed that Send appears only after the answer finishes in the manual loop.
- Import the first PDF or SlideScribe note into the library.
