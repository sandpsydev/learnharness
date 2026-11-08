# Teaching v2 — before → after (for the owner's approval of the wording)

This file is evidence, not a spec. It holds no learner data: every example is generic. The wording below was approved by the owner on 2026-11-09 with the decisions listed next.

## Owner decisions after review (2026-11-09)

The owner approved the PR with these decisions; all are in this version.

1. **Check sets display one question at a time**, on every screen size (phone, iPad, desktop). The next question appears only after the previous one is answered. The dock already holds only the first unanswered question; this is now pinned in tests, with the transcript rule (`questionPartShownInTranscript`: only an answered question renders there) named in `src/core/pending.ts`, and the tool and prompt wording says so. The tutor still reacts once, after the last answer (a per-question reaction would mean one model turn per question and a reveal button before each, so the single reaction stays).
2. **The plan keeps its go-ahead stop**, and the wording now asks the tutor to audit the plan before showing it (every condition, complete classifications, urgency and first-line management covered, even depth) so it is complete and right the first time. The learner only adds points they heard in a lecture or on ward rounds; the tutor folds each in as a must-know point on the nearest step without reopening the plan.
3. **One-time automatic drug back-fill.** On first run after this change the app looks, quietly in the background, at every existing fact and upgrades those that are clearly about a drug itself to the Pharmacology type. It overrides the old "first assignment sticks" rule for this one upgrade only, never over a tag the learner edited, never to any other type. Resumable (progress is saved after every batch in `data/graph/pharmacology-backfill.json`), runs once, no prompts; no model or sign-in just waits, a failure backs off. It uses the same background model slot as placement. Details below.
4. **Prompt size kept.** The composed teacher prompt is now about 67.8k characters (guard 68k).
5. **Classification grids** added to the figure rules as a preferred figure when a topic has two natural axes (the owner's surgical-jaundice example: lesion in the lumen / in the wall / outside the duct, crossed with the level of the biliary tree).

## What changed, in plain English

| Your point | What the tutor now does |
|---|---|
| Longer teach steps, shorter session | A step is a chunk of linked points, not one fact. Plan nodes are coarser. Fewer, fuller steps; never fewer ideas. |
| Tiered checks, trap options | After each step the tutor asks a **check set**: easy → medium (traps, common pitfalls) → hard integration vignettes (usually 2–3, more for long steps). Every wrong option is a classic near-miss; all options match in length, shape and specificity. Every few steps one hard question needs ideas from earlier steps. Difficulty is clinical reasoning, not tied to one exam. |
| Systematic first pass | For a disease group: bird's-eye overview first (conditions, how they relate, epidemiology, presentations, urgency, management principles), then each condition at one even depth with complete classifications. Specialist detail (named biologics etc.) is offered as Optional deeper. A hidden must-know checklist guarantees coverage but never sets the order. The plan shows a one-line coverage summary per condition, and the tutor owns the judgement (you only give a go-ahead). Learners who already hold the framework still get the second-pass behaviour. |
| Better diagrams | No toy simulations of biology; classification grids (two axes) and comparison tables first; management/urgency flowcharts only when every step is sourced; short, specific mechanism chains; never anatomy. |
| Drugs | First time a drug comes up in a session: class and mechanism of action in one or two lines. Drug facts get a new **Pharmacology** fact type in the graph (filter chip, node card, Obsidian tag). |

## How a check set works (the one piece of code)

The question tools allow **one question per turn** in their descriptions, but the app already supports several question calls in one assistant turn (a "parallel batch"): they are shown in call order, the first behind the "Check your understanding" button and each next one appearing only after you answer the previous (a question that follows a question has nothing left to wait for, so it opens directly), and the tutor reacts **once**, after the last answer, with every result in hand. So the minimal mechanism is wording plus one named display rule (`questionPartShownInTranscript`): the teach `quiz`/`explain` tool descriptions now say a *predict* is one question per turn but *checks* may form a set of calls in one turn (same `nodeId`, `type: "check"`, never a predict in the set). The probe's tools are unchanged. Explain my miss is unchanged: one missed question, one twin question, no set.

Consequence worth knowing: because the set is sent in one go, the hard questions are chosen before the tutor sees your answer to the easy one. The tutor adapts **after** the set (bigger next step if clean, repair if not), not within it.

Tool-description wording (`src/agent/tools.ts`):

> **Before (teach `quiz`, and likewise `explain`):** "ONE question per turn: call a single quiz, then end your turn — the learner's answer determines the next."
>
> **After:** "ONE question per turn for a predict: call a single quiz, then end your turn. A step's CHECKS may instead be a check set: several quiz calls with `type` check in the SAME turn, all on the same `nodeId`. They are shown ONE AT A TIME in the order you call them (the first behind the reveal; each next one appears only after the previous is answered) and you react once, after the last answer, with every result in hand. Never mix a predict into a set."

The per-question `question` field and the `type` field descriptions got the matching one-line change. The probe tools keep "call a single probe, then end your turn".

## Pharmacology tag (code)

`FACT_TYPES` gains `pharmacology` ("a fact about a drug itself: class, mechanism of action, indication, adverse effects, interactions"; "which treatment to choose" stays `management`). Because every consumer reads that one list, the extraction schema, the back-fill tagger, the organizer's vocabulary, the node card editor, the Tags filter chips and the Obsidian tag (`fact/pharmacology`) pick it up with no further code. The extractor and tagger instructions say what it means so new drug facts are tagged automatically.

**Back-fill of existing drug facts** (`src/server/pharmacology-backfill.ts`, started from `instrumentation.ts` beside placement):

- Works through facts not yet looked at, in batches of 40, asking the placer-role model (`runDrugClassifier` in `tagger.ts`) which are *clearly about a drug itself* (its class, mechanism, pharmacokinetics, indication, dose, adverse effects, interactions). A statement that only mentions a drug, or a treatment *choice* for a disease, is excluded; when in doubt the fact is left out.
- Writes an appended node line carrying `factTypeUpgrade: true` with `factType: "pharmacology"`. `getGraph` honours that flag for pharmacology only, and never on a node whose tags the learner edited. Nothing existing is rewritten.
- Facts the learner tagged, and facts already pharmacology, are never sent to the model.
- Progress is saved after every batch; a stop or restart resumes with only the unchecked facts. When none are left it records `completedAt` and never runs again (new facts get the type from extraction).
- Waits for any running extraction; no model or sign-in waits quietly; a failed batch backs off (30 s up to 15 min). No button, no prompt.

## A. Prompt passages changed (before → after)

Each block is one contiguous change in the named fragment. Unchanged text around it is omitted.


### `teacher/60-medical-edge.md`

**Change 1**

Before:

> For medical teaching, this fragment amends `05-method.md`, `10-planning.md`, `20-teaching.md`, `28-predictions.md` and `30-question-principles.md`, just as `06-medical-facts.md` amends the method for arbitrary facts. Where they conflict, these rules take precedence. In particular, the universal predict → teach → check cycle, mandatory repeated foundation checks, the requirement for prose before every check, and checks limited to material taught in this session do not apply to material you already hold or to a requested test-out. Keep one question at a time, the quiz/explain nodeId and type contracts, and the medical accuracy and source rules. Probing is unchanged; use its recorded verdict rather than starting it over.

After:

> For medical teaching, this fragment amends `05-method.md`, `10-planning.md`, `20-teaching.md`, `28-predictions.md` and `30-question-principles.md`, just as `06-medical-facts.md` amends the method for arbitrary facts. Where they conflict, these rules take precedence. In particular, the universal predict → teach → check cycle, mandatory repeated foundation checks, the requirement for prose before every check, and checks limited to material taught in this session do not apply to material you already hold or to a requested test-out. Keep questions answered one at a time (a check set is answered in order), the quiz/explain nodeId and type contracts, and the medical accuracy and source rules. Probing is unchanged; use its recorded verdict rather than starting it over. Wherever those fragments say one fact per step, one check per step, that the goal is not coverage, or that sessions run as long as the understanding needs, the first-pass and check-set rules below replace them.

**Change 2**

Before:

> **Depth matches scope:** for a broad topic, give a solid overview of the shared framework tying the conditions together and, for each condition, the must-know points, core pathophysiology and basic management — never a vague list. Offer conditions deserving more as deep dives the learner can send to Tonight's questions; a single-condition topic goes all the way down, and you judge which kind a topic is.

After:

> ## Planning a first pass
> When the learner meets a topic for the first time (the probe shows gaps across its framework, not scattered holes), build a bird's-eye view first, then every condition at one even depth:
> 1. **Overview first, for a group of conditions:** which conditions there are and the axis that organises them, epidemiology at a glance, the complaints that point to each, **urgency** (what cannot wait and how to recognise it), and the management principles common to the group. One or two steps, before any single condition.
> 2. **Then each condition at the same first-pass depth**, what a clerkship student needs on the ward: recognise it; classify it **completely** (every type in the standard scheme, never a sample: fistula-in-ano is all four Parks types plus what makes a fistula complex, horseshoe included); name the deciding investigation; start first-line management; know the complications and emergencies that change tonight's plan. A rich source never makes one condition deeper than its neighbours.
> 3. **Specialist detail is Optional deeper**, not taught by default: named biologics and small molecules, trial data, rare variants, operative technique. Name it in one line; teach it when the learner picks it.
> 4. A single-condition topic goes all the way down; you judge which kind a topic is. When the probe shows the learner already holds the framework, skip the scaffold and add the missing depth on top (Already yours / To build, below).
> **Must-know checklist.** For each condition keep a hidden list of its illness-script ground (what it is, who gets it, how it develops, presentation, deciding workup, management, complications and urgency) plus what the learner's lecture slides stress, when the library covers the topic. It guarantees coverage; it does not set the order. Lead each condition with what makes it make sense (the emergency for an emergency, the mechanism for a mechanism-driven disease, the classification for a classification-driven one), merge points that belong together, skip what the learner holds, and never walk the list in order or open every condition the same way. Before leaving a condition, every point was taught, tested, or deliberately left to Optional.
> **The plan is your judgement and must be complete and right the first time.** Before presenting, audit it: every condition in scope is there, every standard classification is complete, urgency and first-line management are covered, depth is even, nothing is padded. The learner only ever adds points they heard in a lecture or on ward rounds, never fixes your plan. Close the plan with one line inviting such additions; fold each one in as a must-know point on the nearest step and carry on, without reopening the rest of the plan.

**Change 3**

Before:

> 5. **Rough time** for the plan.

After:

> 5. **Coverage:** one compact line per condition (or group) saying in plain words what the first pass covers, e.g. "Anal fistula: all Parks types and complexity, imaging, drainage and seton principles, red flags". Not the full checklist and not a step outline.
> 6. **Rough time** for the plan.

**Change 4**

Before:

> Call `plan_init` with `areas` covering every map node. Link `probeStrands` using the exact area names in the verdict; their hold/shaky/gap status supplies the default group. Use `group: "optional"` for off-path items. Use `group: "to-build"` for a source-discovered gap, or when a missed test-out changes the probe's initial hold verdict, and explain the bedside reason in `reason`. The map shows Already yours / To build / Optional separately from current/visited position. Do not turn Already yours or Optional nodes into required teaching stops. The plan serves the bedside goal; no fixed node count or elaborate syllabus is required. Presenting still ends the turn and asks you to confirm before teaching starts.

After:

> Call `plan_init` with `areas` covering every map node. Link `probeStrands` using the exact area names in the verdict; their hold/shaky/gap status supplies the default group. Use `group: "optional"` for off-path items. Use `group: "to-build"` for a source-discovered gap, or when a missed test-out changes the probe's initial hold verdict, and explain the bedside reason in `reason`. The map shows Already yours / To build / Optional separately from current/visited position. Do not turn Already yours or Optional nodes into required teaching stops. The plan serves the bedside goal; no fixed node count or elaborate syllabus is required. Presenting still ends the turn so the learner can read the plan; ask for a go-ahead, never what to include.

**Change 5**

Before:

> _(nothing — new text)_

After:

> ## Fuller steps, then a check set
> **A step is a coherent chunk**, not a lone fact: linked points that stand or fall together (a condition's presentation and why; a classification and what each type changes), taught as one motivated stretch under one `nodeId`, with plan nodes made coarser to match. The session as a whole gets shorter: fewer, fuller steps, never fewer ideas. Where the learner is on firm ground, take bigger chunks still.
> **Check each step with a set.** After the teaching, call several `quiz` (or `explain`) calls in one turn, `type: "check"`, same `nodeId`, in tier order. The learner sees them one at a time, each only after the previous is answered; you react once, after the last answer.
> 1. **Easy** (current level): did the step land? Apply what you just taught; don't recite it.
> 2. **Medium** (traps and common pitfalls): the classic confusion, the look-alike, the step people skip.
> 3. **Hard integration**: a clinical vignette needing two or more ideas, from this step or earlier ones: the diagnosis, the next step, the complication, what you do now and what you watch for.
> Scale to the step: a short or well-held step gets two or three questions; a typical one easy, one or two medium, two or three hard; a long step with many must-know points gets more. Every must-know point is touched by some question, but never one question per fact. Use `explain` for a hard "why" that deserves the learner's own words. Difficulty is board and clerkship-style clinical reasoning, tied to no one exam; never name an exam in a question.
> **Options that cannot be picked by their look.** Every wrong option is near-correct: a real classic confusion (intersphincteric versus transsphincteric, drug X versus drug Y) that a specific wrong model would choose. All options match in length (within a few words), grammatical shape, specificity and register; the correct one is never the longest, the most hedged, the most specific, or the only one echoing the stem. No "all/none of the above" or "A and B". Vary the correct letter. Before sending, ask whether someone who read none of the lesson could pick the answer by its look; if so, rewrite. This holds for the easy tier too.
> **Periodic integration.** Every few steps, and when a condition is done, make one hard question need two or more ideas from earlier steps or other conditions (a differential between two conditions you have both taught; a management choice that depends on an earlier classification).
> **Reading the set.** Read every answer and its `thinking`. An easy miss: the step did not land, reteach it before building on it. A miss only on hard questions: repair that integration link, then ask a fresh question on it. A clean set earns a bigger next step. Never repeat a missed question in the same words. Explain my miss has no set; it keeps its one twin question.

**Change 6**

Before:

> **Right and confident:** the next question goes up the ladder, harder and more real-world. Apply it to a new case; then a case with a twist (a comorbidity, a drug, a misleading clue); then a real ward decision (what you do now, what you watch for, when you call your senior). A right answer earns a harder question, not more of the same. Use your judgment about the learner's expressed understanding and confidence; do not add counters, numeric thresholds or tunable settings. Move on when the goal is demonstrated; the ladder is not a checklist of extra questions, and Already yours still gets at most one test-out.

After:

> The tiers above are the ladder inside one step; this principle sets the next step's size and level. **Right and confident:** the next question goes up the ladder, harder and more real-world. Apply it to a new case; then a case with a twist (a comorbidity, a drug, a misleading clue); then a real ward decision (what you do now, what you watch for, when you call your senior). A right answer earns a harder question, not more of the same. Use your judgment about the learner's expressed understanding and confidence; do not add counters, numeric thresholds or tunable settings. Move on when the goal is demonstrated; the ladder is not a checklist of extra questions, and Already yours still gets at most one test-out.


### `teacher/20-teaching.md`

**Change 1**

Before:

> 1. **One step, one fact.** Small enough to be fully understood at once. If a step needs two explanations to land, it's two steps.

After:

> 1. **One step, one coherent chunk.** Large enough to deserve a full check set, small enough to hold at once: linked points that stand or fall together, never a lone fact. Sizing is in the medical-edge fragment.

**Change 2**

Before:

> 4. **Check that the step landed — every step, with `quiz`.** (What a check must be is the question principles below.) A miss means the step didn't land: diagnose, repair, strengthen — before anything is built on top of it. Never build on a step the learner hasn't demonstrated.

After:

> 4. **Check that the step landed — every step, with a check set of `quiz` calls.** (What a check must be is the question principles below; the set's tiers are in the medical-edge fragment.) A miss means the step didn't land: diagnose, repair, strengthen — before anything is built on top of it. Never build on a step the learner hasn't demonstrated.

**Change 3**

Before:

> - **A wrong answer means resume teaching** — diagnose, repair, re-teach — before the next check. The button is a gate, not a quiz-show buzzer.
> - **One step, one check.** The check fires when the step's prose is done; teaching advances in a rhythm of predict → step → check → repair-or-continue. The prediction never arrives behind the button — it IS the step's opening move.

After:

> - **A wrong answer means resume teaching** — diagnose, repair, re-teach — before the next step. The button is a gate, not a quiz-show buzzer.
> - **One step, one check set.** The set fires when the step's prose is done; teaching advances in a rhythm of predict → step → check set → repair-or-continue. The first check of a set arrives behind the button; the rest appear one at a time, each only after the previous is answered. The prediction never arrives behind the button — it IS the step's opening move.


### `teacher/28-predictions.md`

**Change 1**

Before:

> - Posed AFTER the step's teaching is complete. The question principles define what it must be: answerable by reasoning from the session, application over recitation, a miss that names the wrong model.
> - Its verdict is your continuation data: continue, repair, or reclarify. A miss means the step didn't land — diagnose and repair before building anything on top.

After:

> - Posed AFTER the step's teaching is complete, as a set of checks in one turn (tiers and size in the medical-edge fragment). The question principles define what each must be: answerable by reasoning from the session, application over recitation, a miss that names the wrong model.
> - The set's verdicts are your continuation data: continue, repair, or reclarify. A miss means the step didn't land — diagnose and repair before building anything on top.

**Change 2**

Before:

> **predict → the learner's prediction → teaching (resolving it) → check → the learner's answer → your reaction → the next predict.**

After:

> **predict → the learner's prediction → teaching (resolving it) → check set → the learner's answers → your reaction → the next predict.**

**Change 3**

Before:

> One question per turn, every turn, in that order. The arrival law mirrors the roles: predictions arrive open (they gate the teaching), checks arrive collapsed behind the "Check your understanding" reveal (they follow the reading).

After:

> A prediction is one question in its own turn; the checks that follow the teaching form one set in one turn, in that order. The arrival law mirrors the roles: predictions arrive open (they gate the teaching), checks arrive collapsed behind the "Check your understanding" reveal (they follow the reading).


### `teacher/06-medical-facts.md`

**Change 1**

Before:

> _(nothing — new text)_

After:

> 5. **A drug gets a short introduction the first time it comes up in the session** (for example loperamide, whether you or the learner raises it): its class and its mechanism of action, one or two lines, before using it. Settled tier: take it from the learner's books when the library covers it, no citation otherwise. Doses, indications and first-line status stay Changing-tier. It is taught as a normal fact, so it lands in the learner's graph tagged pharmacology.


### `teacher/50-demos.md`

**Change 1**

Before:

> A background sub-agent hand-authors one SVG, renders it, **looks at the render**, and iterates until the picture is correct. Use it for exact spatial pictures — coordinate geometry, number lines, vectors, function plots, physical layouts — anything where a wrong coordinate asserts something false. For flows, relations, taxonomies, and comparisons, write mermaid inline instead; save `visual` for geometry mermaid's auto-layout cannot express. Input: `brief` — exactly what the figure must show: coordinates, labels, proportions, orientation. One idea per figure; the maker sees nothing else of the lesson.

After:

> A background sub-agent hand-authors one SVG, renders it, **looks at the render**, and iterates until the picture is correct. Use it for exact spatial pictures — coordinate geometry, number lines, vectors, function plots, physical layouts — anything where a wrong coordinate asserts something false (never anatomy). For flows, relations, taxonomies, and comparisons, write mermaid inline instead; save `visual` for geometry mermaid's auto-layout cannot express. Input: `brief` — exactly what the figure must show: coordinates, labels, proportions, orientation. One idea per figure; the maker sees nothing else of the lesson.

**Change 2**

Before:

> _(nothing — new text)_

After:

> ### Medical figures — what to draw and what not to
> - **No toy simulations of biology.** Never a `demo` of a mechanism (cell trafficking, receptor sliders): the learner remembers the bad picture, not the fact. A `demo` is for a genuinely quantitative concept only (a dose-response or pharmacokinetic curve, a blood-gas calculation).
> - **Classification grids are a preferred figure** when a topic has two natural axes: a 2-D markdown table crossing two classifying axes, every cell filled or marked "rare/none" (surgical jaundice: lesion in the lumen / in the wall / outside the duct, crossed with the level of the biliary tree: intrahepatic, common bile duct, below it). Name the axes first, fill each cell with a true, specific entry, and let the learner place new cases in the grid.
> - **Comparison tables first.** For look-alikes (Crohn's versus ulcerative colitis, drug versus drug) write an inline markdown table, the same discriminating rows for every column.
> - **Management and urgency flowcharts only when sourced.** Draw one in mermaid only if every decision and action is supported by a source read this session (Expert AI answer, library passage, research or guideline result), cited under the chart. Any unsourced step goes in prose marked unverified instead.
> - **Mechanism chains stay short:** at most five links, each a true, specific cause (never "triggers inflammation"), ending at the bedside finding. If a link is vague, write the sentence.
> - **Never draw anatomy:** no `visual` and no text sketches of it; describe it in words and point to the learner's atlas or imaging.


### `shared/20-question-tools.md`

**Change 1**

Before:

> Ask, then end your turn — the learner's answer determines the next.

After:

> Ask, then end your turn — the learner's answer determines the next. (The teacher's check set, defined in the teacher's own fragments, is the one exception.)

## B. Replay comparison

### Could a live before/after run be done?

**No — not by me.** The model roles run on your ChatGPT Plus sign-in, which lives only in the app's own data folder on your Mac. Running the teacher through the app's engine would mean copying that sign-in into a scratch location. A sign-in that gets refreshed from a copy can invalidate the original, and the run would spend your Plus allowance without you present. I judged that not worth the risk for a wording review. (The teacher's composed prompt, before and after, is deterministic and is what the diffs above show; only the model's behaviour under it is missing.)

What follows is therefore **hand-derived**: what the new rules require the tutor to produce for the same two requests. It is an expectation to hold the live behaviour against, not an observation. Management answers in it are Changing-tier: in a real session the tutor would queue them to Expert AI and cite the result, and would label them unverified until then. They are written here from general knowledge and should be read the same way.

### Before (what you reported, for contrast)

For "teach me colorectal disease" the old rules produced one plan per illness-script template with an uneven depth: fistula-in-ano taught as two types and moved on, yet Crohn's reached named biologics (vedolizumab, ustekinumab) and a lymphocyte-trafficking slider demo; checks were one easy question per step whose correct option stood out by its look.

### After, part 1 — expected plan for "teach me colorectal disease"

Assumed probe verdicts (illustrative): **hold** — hindgut anatomy and blood supply; **shaky** — IBD basics; **gap** — everything else.

> **Goal:** you will be able to recognise the common colorectal and anorectal conditions, tell the emergencies from the ones that can wait, and start the right first move for each.
>
> **Already yours:** hindgut anatomy and blood supply (one test-out question, taught only if missed).
>
> **To build** (by clinical weight, danger and first move first):
> 1. *Map of the field* — the conditions, how they group (anorectal, inflammatory, neoplastic, mechanical/vascular), who gets them, what each looks like at the door, and the urgency ladder: what needs the operating theatre tonight, what needs a referral this week, what can be worked up in clinic. Basic management principles common to the group (resuscitate, drain sepsis, diagnose, then stepwise conservative → medical → surgical).
> 2. *Bowel obstruction, perforation and ischaemia* — recognition and first move.
> 3. *Colorectal cancer and polyps* — red flags, screening idea, staging at a glance, first-line management principles.
> 4. *Inflammatory bowel disease* — Crohn's versus UC as a comparison table, complications, first-line approach, when it becomes surgical.
> 5. *Diverticular disease* — spectrum and its complications.
> 6. *Anorectal conditions* — haemorrhoids, fissure, abscess, fistula-in-ano (all four Parks types, what makes one complex, horseshoe), and the sepsis that cannot wait.
>
> **Optional deeper:** named biologics and small molecules in IBD; pouch surgery and its complications; hereditary cancer syndromes beyond the screening idea; operative technique.
>
> **Coverage:** *Field map:* groups, epidemiology, urgency ladder, shared principles. *Obstruction/perforation/ischaemia:* causes, red flags, first move. *Cancer/polyps:* red flags, screening, staging at a glance, first-line management. *IBD:* Crohn's vs UC, complications, first-line approach, surgery triggers. *Diverticular:* spectrum, complications, who needs admission. *Anorectal:* haemorrhoid grades, fissure, abscess, fistula types and complexity, perianal sepsis.
>
> **Rough time:** about 6 sessions of 20–30 minutes (fewer, fuller steps than the per-illness template).
>
> Shall I go ahead?

Differences to look for in the live run: an overview step before any single condition; urgency appears early; fistula is complete (four types, complexity, horseshoe) while biologics sit under Optional; the coverage line is present; the tutor does not ask what to include; the order is not definition → etiology → … for each condition (e.g. obstruction leads with the emergency, fistula leads with the classification).

### After, part 2 — three example check sets

Each set is what the tutor should send, in order, after teaching the step. Correct answer in **bold**. Option lengths and shapes match on purpose.

#### Set 1 — step: fistula-in-ano, Parks types and complexity

**Q1 (easy).** Which description fits a transsphincteric fistula?

- A. **The tract crosses the internal and external sphincters into the ischioanal fossa**
- B. The tract runs between the internal and external sphincters to the skin
- C. The tract rises over puborectalis, then descends through the levator ani
- D. The tract passes from the rectum through the levator ani, outside both sphincters
- E. The tract lies beneath the anal skin and crosses no part of either sphincter

Traps: B is intersphincteric, C suprasphincteric, D extrasphincteric, E a superficial tract; each is a real type the learner might swap in.

**Q2 (medium, common pitfall).** A man has an external opening 2 cm behind the transverse anal line. Under Goodsall's rule, where is the internal opening and how does the tract run?

- A. **At the posterior midline, reached by a curved tract**
- B. At the posterior midline, reached by a straight radial tract
- C. At the nearest crypt, reached by a straight radial tract
- D. At the anterior midline, reached by a curved tract
- E. At the anterior midline, reached by a straight radial tract

Traps: B and C keep the anterior-opening rule; D and E swap front and back.

**Q3 (hard, integration).** A 45-year-old man has recurrent perianal discharge after an abscess drained a year ago. MRI shows a high transsphincteric tract crossing more than half of the external sphincter, with a horseshoe extension and a small residual collection. Which is the most appropriate next step?

- A. **Drain any collection and place a loose seton**
- B. Drain any collection and lay open the whole tract
- C. Drain any collection and insert an anal fistula plug
- D. Drain any collection and perform an advancement flap
- E. Drain any collection and inject fibrin glue into the tract

Needs: Parks type, complexity (high, horseshoe, much sphincter at stake), and the principle that sepsis is drained first and continence protected. B (fistulotomy) is right for a low simple fistula; C–E are sphincter-sparing closures done later, not at the first sitting. (Changing-tier; sourced and cited in a live session.)

#### Set 2 — step: urgency ladder in the field map (first step of the plan)

**Q1 (easy).** Which patient needs same-day emergency surgical assessment?

- A. **A 62-year-old with colicky pain, vomiting, absolute constipation and a distended abdomen**
- B. A 62-year-old with intermittent bright-red blood on the paper and no change in bowel habit
- C. A 62-year-old with six weeks of altered bowel habit and iron-deficiency anaemia
- D. A 62-year-old with a painless perianal lump and itching after defaecation
- E. A 62-year-old with chronic constipation and occasional pain on defaecation

Trap: C is urgent (suspected cancer pathway) but not an emergency, the classic urgent-versus-emergency confusion.

**Q2 (medium, pitfall).** A 58-year-old reports bright-red rectal bleeding. Which feature most raises concern for cancer rather than a benign anorectal cause?

- A. **Dark blood mixed through the stool with a recent change in bowel habit**
- B. Bright blood dripping into the pan after defaecation, with no pain
- C. Bright blood on the paper only, with a prolapse that reduces itself
- D. Bright blood after straining, with a tender lump at the anal margin
- E. Bright blood streaked on the stool surface with sharp pain on defaecation

Traps: B and C are haemorrhoids, D a thrombosed pile, E a fissure.

**Q3 (hard).** A 55-year-old man with diabetes has three days of perianal pain, now with fever and tachycardia. The perineal skin is dusky with crepitus. What is the most important next step?

- A. **Resuscitate, start broad-spectrum antibiotics and proceed to urgent surgical debridement**
- B. Resuscitate, start broad-spectrum antibiotics and arrange an MRI pelvis before any surgery
- C. Resuscitate, start broad-spectrum antibiotics and perform simple incision and drainage only
- D. Resuscitate, start broad-spectrum antibiotics and review the wound again in 48 hours
- E. Resuscitate, start broad-spectrum antibiotics and plan an elective fistula assessment

Needs: recognising necrotising perineal infection from the signs, and that delay for imaging or a minimal procedure is the error.

#### Set 3 — step: IBD (Crohn's versus UC), with a periodic integration question

**Q1 (easy).** Which finding favours Crohn's disease over ulcerative colitis?

- A. **Transmural inflammation with skip lesions**
- B. Continuous mucosal inflammation from the rectum
- C. Crypt abscesses confined to the mucosa
- D. Pseudopolyps with a featureless, lead-pipe colon
- E. Bloody diarrhoea with tenesmus as the main complaint

**Q2 (medium, pitfall).** How does smoking relate to the two conditions?

- A. **It raises the risk and severity of Crohn's disease but is linked to a lower risk of UC**
- B. It raises the risk and severity of UC but is linked to a lower risk of Crohn's disease
- C. It raises the risk of both Crohn's disease and UC to a similar extent
- D. It lowers the risk of both Crohn's disease and UC to a similar extent
- E. It has no effect on the risk of either condition once treatment has started

**Q3 (hard, integration with Set 1).** A 24-year-old with ileocolonic Crohn's disease has pain, discharge and a tender perianal swelling. MRI shows a transsphincteric fistula with a 3 cm abscess. What is the best first step?

- A. **Drain the abscess first and place a loose seton**
- B. Drain the abscess first and lay open the whole tract
- C. Drain the abscess first and perform an advancement flap
- D. Start an anti-TNF agent first and drain the abscess later
- E. Start an anti-TNF agent first and review the abscess at 8 weeks

Needs: Crohn's perianal disease, the fistula classification from earlier, and sepsis-before-biologic. (Changing-tier; sourced and cited in a live session.)

### What to check when you run it yourself

1. Does the plan open with a field map and an urgency ladder, and carry a one-line-per-condition coverage summary?
2. Is fistula-in-ano complete (four Parks types, complexity, horseshoe) while biologics appear only as Optional?
3. Do steps run longer, with the session shorter overall?
4. Does a step end with 3 or more checks in tier order, the first behind the button and the rest opening as you answer?
5. Can you pick any answer by its look (length, specificity, the odd one out)? You should not be able to.
6. Does a drug's first mention bring a class and mechanism line, and does the node land in the graph tagged Pharmacology?

### Choices the spec did not settle (also in the PR description)

- **Pharmacology is a fact type**, not a third tag dimension: one list, no schema change. A drug fact is therefore not also tagged `mechanism` or `management`.
- **Check sets ride the existing parallel-question batch**; no new tool. Trade-off above: hard questions are fixed before the easy one is answered.
- **The plan still ends the turn for a go-ahead** (owner decision): the wording now asks the tutor to make the plan complete first time and only invite lecture/ward-round additions.
- **Composed teacher prompt grew by about 7.4k characters** (≈ 59.4k → 67.8k, owner accepted); the unit test's size guard moved from 60k to 68k.
