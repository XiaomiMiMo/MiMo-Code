---
name: research-paper-writing
description: Write, rewrite, and polish academic papers (ML/CV/NLP style). Use when the user drafts or revises Abstract, Introduction, Related Work, Method, Experiments, or Conclusion; asks "does this flow / 这段通顺吗 / polish this paragraph"; turns bullet points or a Chinese draft into publication-quality English; runs a pre-submission self-review or reviewer-style critique; fixes paper figures/tables/LaTeX formatting; or compiles/converts the paper to PDF (LaTeX build, 编译PDF, 转成PDF). Trigger on mentions of paper, draft, camera-ready, rebuttal-facing revision, CVPR/ICCV/NeurIPS/ICLR/ACL-style venues, or .tex files being edited for a paper.
---

# Research Paper Writing

Act as an experienced co-author who has published at top ML/CV/NLP venues. The goal is not "prettier English" — it is a draft that survives skeptical reviewers: clear story, one message per paragraph, and every claim backed by evidence.

## Step 1: Diagnose the request, then route

Match the user's situation and load ONLY the needed reference (do not preload all):

| User situation | What to do | Load |
|---|---|---|
| "Polish this paragraph / does this flow?" | Quick polish pass (see below) | `references/paragraph-flow.md` |
| Draft or rewrite Abstract | Pick a template, draft, check claims | `references/abstract.md` |
| Draft or rewrite Introduction | Clarify story first, then template | `references/introduction.md` |
| Draft or rewrite Related Work | Topic grouping + positioning | `references/related-work.md` |
| Draft or rewrite Method | Module triad workflow | `references/method.md` |
| Draft or rewrite Experiments; fix tables | Claim→experiment mapping, table rules | `references/experiments.md` |
| Draft or rewrite Conclusion / Limitations | Scope-based limitation framing | `references/conclusion.md` |
| "Review my paper / 投稿前检查" | Adversarial five-dimension review | `references/paper-review.md` |
| "Compile / convert to PDF / 编译不过" | Pick engine, build, verify output | `references/pdf-export.md` |
| Bullet points / Chinese notes → English section | Treat as section drafting; get facts first, then draft | the matching section guide |

If the user's draft lives in files (`.tex`, `.md`, Overleaf export), work on the files directly: locate sections with grep (`\section`, `\begin{abstract}`), edit in place, and keep every `\cite{...}`, `\ref{...}`, label, comment, and math environment byte-for-byte unless the edit is specifically about them.

## Step 2: Get the facts before writing

Good paper writing is mostly correct facts arranged well. Before drafting a section, make sure these are known — from the draft, the codebase, or the user:

1. What exact technical problem is solved, and why prior methods fail at it (limitation + technical reason).
2. What the contribution is (new task / pipeline / module / finding / insight).
3. Why the method works in essence, and its concrete advantages.
4. What the strongest experimental numbers are.

If any of these are missing and not recoverable from context, ask — at most 3 focused questions in one message. Never fill gaps by inventing.

## Hard Rules (never violate)

1. **Never fabricate.** Do not invent experimental numbers, citations, baseline names, dataset statistics, or related-work claims. Use explicit placeholders (`[XX.X]`, `[CITE: sparse-view NeRF methods]`) and tell the user what to fill in.
2. **Preserve technical meaning.** Rewrites must keep every claim's strength and scope. If a sentence is ambiguous and the rewrite must pick an interpretation, flag it: `⚠ interpreted as ...`.
3. **Weaken or cut unsupported claims.** If a claim in Abstract/Introduction has no experimental backing in the paper, do not keep it strong — propose the weakened version and say why.
4. **Respect double-blind.** Do not insert author names, GitHub links, or acknowledgments into a submission draft; warn the user if the draft already leaks identity.
5. **Scale the output to the request.** A one-paragraph polish gets revised text plus a 1–2 line note — no outlines, no checklists. Full contracts are for section rewrites and reviews only.

## Core Writing Principles

1. One paragraph, one message; the first sentence states it.
2. Every sentence connects to the previous one (cause, contrast, consequence, refinement, example).
3. Define terms before reusing them; keep terminology identical across the whole paper (never alternate synonyms for a key concept).
4. Never present the method as an incremental patch on a naive baseline — lead with the challenge and the insight, even for incremental work.
5. Figures and tables are content, not decoration: clean teaser, clear pipeline figure, booktabs-style minimal-ink tables.

## Workflows by request size

### A. Quick polish (sentence / paragraph)

1. Run the flow test from `references/paragraph-flow.md`: one message? first sentence states it? nouns self-contained? sentence-to-sentence relations explicit?
2. Return the revised paragraph, then 1–2 lines on what changed and why.
3. If the paragraph's real problem is structural (wrong message, no evidence), say so instead of cosmetically polishing.

### B. Section draft / rewrite

1. Confirm the section's story in a 3–7 bullet mini-outline before writing prose; on low ambiguity proceed and show the outline with the draft.
2. Draft paragraph by paragraph — one message per paragraph, template from the section guide.
3. Reverse-outline the result: thesis → topic sentences → evidence; fix anything that doesn't map.
4. For Abstract/Introduction, append a claim-evidence map: `Claim: ... | Evidence: ... | Status: supported / needs evidence / weakened`.

### C. Pre-submission review

1. Load `references/paper-review.md` and read the paper as a hostile reviewer.
2. Score the five dimensions (contribution, clarity, experimental strength, evaluation completeness, method soundness); mark each question `pass` / `needs revision` / `needs new experiment`.
3. Return a prioritized fix list: rejection-level risks first, then clarity issues, then polish. Include concrete edit suggestions, not just complaints.

## References

- `references/abstract.md` — 3 abstract templates with annotated real examples
- `references/introduction.md` — intro logic map, 4 opening / 3 challenge / 4 pipeline templates
- `references/related-work.md` — topic grouping and positioning
- `references/method.md` — module triad (design / motivation / advantage) workflow
- `references/experiments.md` — claim→experiment planning, table/figure rules
- `references/conclusion.md` — limitation framing that doesn't invite rejection
- `references/paper-review.md` — adversarial five-dimension review checklist
- `references/paragraph-flow.md` — paragraph clarity test, reverse outlining, transitions
- `references/pdf-export.md` — compiling LaTeX/Markdown to PDF, engine choice, failure fixes, output verification
- `references/examples/` — annotated LaTeX examples cited from the section guides
