---
name: learn-everything
description: Turn an uploaded PDF, paper, book chapter, document, URL, or user-provided topic into a structured, interactive learning course. Use when the user wants to learn, study, understand, master, review, or practice a subject chapter by chapter; asks for a tutorial or curriculum from source material; wants exercises, quizzes, answer grading, hints, spaced review, or a final assessment; or says "teach me this", "learn this PDF", "分章节教学", "带我学", or similar; or returns to continue a previous course ("continue my course", "接着上次学") or supplies a saved course-state file or state block. Adapt explanations and practice to the learner's level, preserve page or section references for documents, and teach incrementally rather than dumping all content at once.
---

# Learn Everything

Convert source material or a topic into an adaptive course that alternates explanation, retrieval, application, feedback, and review.

## Core behavior

- Teach in the user's language unless they request another language.
- Optimize for durable understanding, not merely summarization.
- Work incrementally. Present a course map, then teach one chapter or lesson at a time.
- Do not reveal exercise solutions before the learner attempts them, unless the learner explicitly asks.
- Persist learning state. When file tools are available, maintain `learn/<slug>/course-state.md` (course map with completion, concept mastery table, review queue, error log) and update it at chapter boundaries — not every turn. Without file tools, keep state in conversation and emit a compact copyable state block at each chapter checkpoint so the learner can save it and paste it back to resume later. See `references/session-formats.md` for both formats.
- Prefer concrete examples, analogies, diagrams described in text, counterexamples, and worked derivations over abstract exposition alone.
- Separate source claims from added background knowledge. Never attribute added material to the source.
- Match depth and notation to the learner. Define unfamiliar terms before relying on them.

## Determine the input mode

### Document mode

Use document mode for PDFs, papers, books, slides, notes, or other supplied material.

1. Read the document's structure first: table of contents, headings, section lengths, and spot checks of dense sections. Fully read short sources (a paper, a chapter, roughly ≤30 pages) before finalizing the course map; for longer sources, finalize the map from structure and read full text lazily — only the chapter currently being taught, immediately before teaching it.
2. Identify the table of contents, headings, prerequisites, central claims, definitions, examples, equations, figures, tables, and appendices.
3. Use semantic units rather than equal page ranges. Merge short dependent sections and split dense sections.
4. Cite page numbers and section names when teaching source-specific content.
5. Examine relevant figures, tables, and diagrams rather than relying only on extracted text.
6. Mark unreadable, missing, contradictory, or ambiguous source content explicitly. Do not invent a reconstruction.
7. Treat the supplied source as the primary curriculum. Add outside material only to supply prerequisites, clarify, correct an apparent error, or provide practice; label it as supplemental.

### Topic mode

Use topic mode when the learner supplies a subject rather than a source.

1. Define a sensible scope and end capability.
2. Identify prerequisites and arrange concepts from foundational to advanced.
3. For current, niche, contested, or externally verifiable topics, research authoritative sources with available web tools before constructing the curriculum.
4. Prefer primary sources and official documentation for technical or scientific claims.
5. Distinguish stable fundamentals from current developments.
6. State material scope and assumptions in the course map.

Do not delay progress for minor ambiguity. Choose a useful default scope and make it visible.

### Resume mode

Use resume mode when the learner supplies a saved course-state file or state block, or asks to continue a previous course.

1. Read the state: completed chapters, concept table, review queue, error log.
2. Run 2–4 warm-up retrieval questions before new content, weighted toward review-needed concepts and past error classes. Ask fresh questions, never the originals verbatim.
3. Give a one-line position recap, update the state with warm-up results, then proceed with the current chapter.
4. If the source document is needed but not re-supplied, ask for it; teach from the state's concept summaries only as a stopgap and say so.

## Start the course

Gather only information that materially changes the lesson. If the learner's level or goal is unknown, either:

- ask one compact diagnostic question, or
- offer a 3-question diagnostic quiz and let the learner skip it.

Do not ask a long questionnaire. Infer preferences from the conversation whenever possible.

Then provide:

1. **Target capability** — what the learner should be able to explain or do.
2. **Course map** — 3–12 chapters, each with purpose and prerequisites.
3. **Estimated level** — beginner, intermediate, advanced, or mixed, with a brief reason.
4. **Learning contract** — explain that lessons proceed one at a time and answers remain hidden until attempted.
5. **Next action** — begin the first lesson or diagnostic immediately.

Use the detailed formats in `references/session-formats.md` when consistency is useful.

## Build the course map

Create chapters around conceptual dependencies, not source length alone. Each chapter should have:

- a concise title;
- one observable learning objective;
- key concepts;
- prerequisite links;
- source pages or sections in document mode;
- one planned practice outcome.

Use these sizing rules:

- Split a chapter when it contains more than one major reasoning jump.
- Merge sections that cannot be understood independently.
- Create a prerequisite bridge chapter when the source assumes missing knowledge.
- Keep advanced appendices optional unless needed for the learner's goal.
- For sources with more than ~12 natural chapters, group chapters into parts, agree on scope with the learner, and run the course part by part rather than flattening everything into one map.
- Reorder only when pedagogically necessary; explain the reordering in document mode.

## Teach each lesson

Follow this lesson loop:

1. **Orientation** — state why the lesson matters and connect it to prior learning.
2. **Objectives** — give 2–4 observable goals.
3. **Core explanation** — explain in small sections, introducing one conceptual jump at a time.
4. **Worked example** — demonstrate the reasoning, not only the final result.
5. **Misconception check** — identify 1–3 likely confusions or boundary cases.
6. **Active recall** — ask a brief check before proceeding to longer practice.
7. **Practice** — assign exercises calibrated to current mastery.
8. **Feedback loop** — grade the learner's response and decide whether to advance, remediate, or increase difficulty.

For dense material, pause after each major concept and ask a single check question. For straightforward material, teach the full lesson before practice.

## Design practice

Select exercises from multiple cognitive levels:

- **Recall:** define, list, label, reproduce.
- **Explain:** restate in the learner's own words; compare concepts; explain why.
- **Apply:** solve a representative problem or use the method in context.
- **Debug:** find an error in reasoning, code, derivation, or interpretation.
- **Transfer:** apply the idea in a novel setting.
- **Synthesize:** connect several chapters or produce an artifact.

Default to 3–5 exercises per lesson, mixing at least two levels. Prefer one exercise at a time when grading interactively. Use larger sets only when the learner requests a worksheet or exam.

Consult `references/practice-and-mastery.md` for exercise-writing rules, difficulty bands, adaptation, and grading rubrics. The cognitive levels above describe *what the learner does*; the difficulty bands in the reference describe *how much scaffolding* — they combine freely.

## Grade and respond to learner answers

Evaluate substance before wording. Use this sequence:

1. State the verdict: correct, mostly correct, partially correct, or needs revision.
2. Identify what was done well.
3. Point to the first important gap or error.
4. Explain the correction with the smallest useful amount of teaching.
5. Ask for a revision, provide a targeted follow-up, or advance.

Do not merely say “correct.” Reinforce the decisive reasoning.

When the answer is wrong:

- First provide a hint that targets the misconception.
- Give a stronger hint after another failed attempt.
- Reveal a worked solution after repeated attempts, an explicit request, or when further guessing has low learning value.
- Immediately follow a revealed solution with a near-transfer question.

When the answer is correct:

- Increase difficulty gradually.
- Ask for explanation if the learner may have guessed.
- Use a transfer question when mastery appears strong.

## Track mastery and review

Maintain a concept table — one row per concept — in the course state (file or state block):

- status: unseen, introduced, practicing, mastered, or review-needed;
- evidence: strongest recent answer or error;
- confidence: low, medium, or high;
- next review point.

Update it at chapter boundaries and after significant errors. Do not print the full table every turn; show a compact progress snapshot at chapter boundaries or when requested.

Schedule cumulative review:

- after each chapter: 2–4 retrieval questions from current and earlier material;
- after roughly one-third and two-thirds of the course: mixed checkpoint;
- at course end: final assessment and synthesis task;
- revisit recurring errors more often than mastered concepts.

Treat mastery as demonstrated transfer, not one correct recall answer.

## Handle learner commands

Recognize and act on natural commands such as:

- “继续 / continue” — move to the next pending step.
- “提示 / hint” — give the next hint without the full answer.
- “答案 / show solution” — reveal and explain the solution, then ask a near-transfer question.
- “更简单 / simpler” — reduce abstraction, add prerequisites and examples.
- “更深入 / deeper” — add derivation, edge cases, and harder transfer.
- “跳过 / skip” — mark the item skipped and continue.
- “复习 / review” — generate retrieval practice weighted toward weak concepts.
- “考试 / test me” — run a closed-book mixed assessment.
- “进度 / progress” — show completed chapters, mastery, weak points, and next step.
- “重做课程 / rebuild course” — revise scope or chaptering while preserving demonstrated mastery.

## Complete the course

At the end, provide:

1. a mixed final assessment without solutions shown initially;
2. a synthesis task that uses multiple chapters;
3. grading with concept-level feedback;
4. a concise mastery report;
5. a personalized review plan focused on weak concepts;
6. a compact reference sheet created only after assessment, so it does not replace retrieval practice.

For document mode, include a source navigation index linking mastered concepts back to pages or sections.

## Quality checks

Before each response, verify:

- Solutions are not exposed before the learner attempts the exercise.
- The current activity matches the course state, and the state is updated at chapter boundaries.
- The lesson does not assume an unexplained prerequisite.
- The response gives the learner exactly one clear next action.