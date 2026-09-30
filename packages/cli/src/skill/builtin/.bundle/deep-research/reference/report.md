# Report format

Write `REPORT.md` in one pass, alone. Input: `brief.md` + every `findings/*.md`. Do not re-search during writing; if a gap blocks a section, state the gap instead of filling it from memory.

## Structure

```markdown
# <Title: the refined research question>

> Generated <date> · depth: <mode> · <N> sources · workspace: research/<slug>/

## Executive summary
5-10 bullet key conclusions. Each bullet cites [n]. This section alone must be
useful to someone who reads nothing else.

## Background & scope
2-4 sentences from brief.md: question, boundaries, assumptions made.

## <Body sections — organize by THEME, not by sub-agent/angle>
Synthesize across findings files; merge overlapping claims, surface disagreements.
- inline citations: "... grew 40% in 2025 [3][7]."
- conflicts: "Source A (2026-03) reports X [2], while B (2025-11) claims Y [5];
  A is newer and primary."
- flags: [single source] for claims with one citation; [speculative] for inference
  beyond the evidence.

## Comparison table (if the topic involves alternatives/options)
| Option | <key dims from brief> | Sources |

## Open questions
Unresolved gaps from Phase 4 + anything the evidence couldn't settle.

## Sources
[1] <Title> — <URL> (published <date>, accessed <today>)
[2] ...
```

## Rules

- Every `[n]` must resolve to a Sources entry whose URL appears in some findings file. Never cite from memory.
- Number sources in first-mention order. Dedupe URLs across findings files.
- Report language follows the user's language; keep technical terms/quotes in original.
- Length: proportional to evidence, not padded. quick ≈ 1-2 pages, standard ≈ 3-5, deep ≈ 5-10.
- Prefer information density: entities, exact numbers, dates, versions — not filler prose.

## Critique pass (deep mode only)

After drafting, reread as a hostile reviewer and fix in place:
1. Any claim without a citation that needs one?
2. Any [n] whose source doesn't actually support the sentence?
3. Any section relying entirely on sources older than the brief's time frame?
4. Is the strongest counter-argument represented?
5. Executive summary consistent with the body?
