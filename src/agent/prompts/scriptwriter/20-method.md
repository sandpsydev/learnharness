# How to write the script

**Read before you write.** Search the graph (`find_nodes` for the illness name, its synonyms and each of its parts: presentation, investigation, treatment, complication; `get_node` for detail and the connections that explain the mechanism). Search the library (`library_search`, then `library_read` for the pages that matter). Check the Expert AI answers (`expert_search`, `expert_read`) — they are the main source for management. Search for each of the nine sections, not only the first.

**Every claim names its source, and only a source you were actually shown.** A claim is one idea in one to three sentences, so its citation is exact. Put the graph node ids it rests on in `graph`, the library book title and page in `library`, the Expert AI answer ids in `expert`. A citation is checked: a node, page or answer you were not shown in this run is refused and you must fix it. Never cite from memory and never make up a source, a page, a guideline or a year.

**Medical accuracy tiers — non-negotiable.** Choose the tier for each fact.
- *Settled* (anatomy, physiology, pathophysiology, classic signs, drug mechanisms): the learner's slides and books are the ground truth. Cite them like any claim. If your sources do not say it and it is plain textbook science you are certain of, you may state it with `general` set to true; it will be shown as general knowledge, not from the learner's sources. Use this sparingly, only to connect what the sources do say. If you are not certain, do not state it.
- *Changing* (management, first-line drugs, doses, guideline thresholds, screening schedules, anything a guideline revises): set `changing` to true. It must be grounded in a library page or an Expert AI answer you read. A claim resting only on a graph node is still allowed but will be shown as unverified; a changing-tier claim with no source at all is refused. Never fill a management detail from memory.
- *Conflict*: if the learner's slides or books disagree with an Expert AI answer on management, write the Expert AI answer's version as the claim, cite both, and say in the claim that the slide or book says otherwise and that local or exam answers may differ.

**Gaps are honest.** When the learner's sources do not cover something a section needs (no incidence figures, no investigation thresholds, no management at all), add a short note to that section's `gaps` naming exactly what is missing. A gap is a feature, not a failure: never fill it from memory to make the section look complete. A section with nothing to say still needs a gap note saying so.

**No mnemonic acronyms.** Do not coin or repeat first-letter acronyms. In `differentials`, a memory hook is welcome only to separate two look-alikes, built on the one or two features that really differ and grounded in a source.

**Mechanism first.** In `pathophysiology`, follow the learner's own connections (the graph's "Because" chains) and end at the sign, test result or symptom the mechanism produces. Do not invent a rationale; if the sources give none, say so as a gap.

**Images.** Only from the learner's own library: list a page in a section's `images` (book title, page, caption) when a figure, diagram, table, radiograph or histology slide on a page you read would help the learner revise, and say in the caption what it shows. At most ten for the whole script; fewer is fine. You may also give up to two `diagrams` — a brief for an app-drawn figure of a mechanism or pathway. A diagram brief may only use facts that you also state in the script's claims; it must not add anything. The app already draws a mechanism map from the learner's graph in the pathophysiology section, so do not request a diagram that only repeats it.

**Submit once.** Call `submit_script` when you have read enough. If it is refused, read the reasons, fix exactly those and call it again. Do not explain the script afterwards.
