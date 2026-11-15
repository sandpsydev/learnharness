# What the recap holds

Read the whole transcript first. Turns are numbered `[T1]`, `[T2]`… Tables are labelled `[TABLE K1]`…`[END TABLE K1]`. Figures are labelled `FIGURE F1`… Then call `submit_recap` once.

**summary** — what the session covered, in two to five sentences. Name the topics and how far the session got. Nothing the session did not reach.

**topics** — organised by the topics the session covered, not by the order of the chat. Give each topic a clear title and its key points, in the order a learner would revise them. A point is one idea in one or two sentences, a fact the session taught or an explanation it gave, not a quotation of the chat and not a record of who said what. Merge a topic that came up in several places into one. Aim for what is worth remembering; skip greetings, plans, housekeeping and anything the session only asked about without teaching.

- Every point names the turns it comes from, in `turns` (for example `[4, 5]`). A point whose turns do not support it is wrong.
- Where a table in the session helps with a topic, give its id in `tables` (for example `["K2"]`); the table is copied into the note exactly as the teacher wrote it, so do not retype it. Where a figure helps, give its id in `figures` (`["F1"]`). A real figure keeps its own caption; for a drawn diagram (marked as drawn by the app) also give a short `caption` taken from what the teacher said about it, as `{"id": "F2", "caption": "…"}`. Use only the ids the transcript shows.
- A topic is made of points, tables and figures from the session only.

**misses** — what the learner got wrong, said they did not know, or was unsure about, taken from the check-ins and quizzes and from the learner's own messages. For each: the `question`, what the learner said (`yours`, in their words or "I didn't know"), and the `correct` answer exactly as the session gave it (the correction, explanation or teaching that followed). Skip a question the learner got right without doubt, and any miss whose correct answer the session never gave. An empty list is fine.

**selfTest** — a short list of questions to test the learner on this session's content, built only from the session's own questions and what it taught. Prefer the check-in and quiz questions as they were asked (reworded only to stand alone, and with their options written into the question when they were multiple choice), each with the answer as the session gave it. Add a question of your own only when it asks for something the session plainly taught, and keep it about that. Put the questions the learner missed first. At most about fifteen unless the session was long.

Give every miss and every self-test question its `turns`. The recap is checked when you submit: a turn, table or figure that is not in the session, or a point with no turns, is refused with the reason, and you must fix it and submit again.

**pictures** — a recap should show the visual points, not only describe them: anatomy and vascular anatomy, the shape of a stone or a lesion, imaging findings, histology, and the like.

- First use what the session already showed: put the figure ids in `figures` as above.
- Where a topic is visual and the session taught it without a picture, add an entry to that topic's `pictures`: `concept` (exactly what the picture must show, as the session described it), optionally `modality` (anatomy drawing, CT, stone photograph…), `caption` (one plain sentence for the note saying what the picture shows, using only what the session said, with no new fact, name or label), and `turns` (the turns that taught the point it illustrates). The app then looks for a real picture: the learner's own slides first, then open atlases and Radiopaedia, and puts it in the note with its credit.
- Optionally give `diagram`, a short brief for a simple labelled drawing the app can make if no real picture is found. It may use only the labels and links the session stated; leave it out when the point cannot be drawn without adding to what was taught.
- Ask for a picture only where it would genuinely help revision; at most five new pictures in the whole recap, none for a point a session figure already shows, and none for a point the session did not teach.
