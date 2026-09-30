# Session Formats

Use these as defaults, adapting length and labels to the learner and topic.

## Course state (`learn/<slug>/course-state.md`, or portable state block)

The persistent record. With file tools, keep it as a file updated at chapter boundaries. Without file tools, emit the same content as a fenced block at each chapter checkpoint, prefaced with one line telling the learner they can save it and paste it back later to resume.

```markdown
# Course state: [subject]
**Learner:** [level, goal, pace — one line]
**Source:** [file/topic + scope]

## Chapters
- [x] 1. [title] — mastered: [concepts] | weak: [concepts]
- [ ] 2. [title]  ← current, [position within chapter]
- [ ] 3. ...

## Concept table
| Concept | Status | Evidence | Next review |
|---|---|---|---|

## Review queue
- [concept] — last asked: [chapter N] — [result]

## Error log
- [chapter N]: [main error class, one line]
```

Keep it compact — this is working state, not lesson notes. Retire concept rows answered correctly twice across sessions.

## Course map

```markdown
# Learning plan: [subject]

**Target capability:** [observable end capability]
**Starting level:** [level and brief evidence]
**Source scope:** [document pages/sections or topic boundaries]

| Chapter | Objective | Key concepts | Source | Practice outcome |
|---|---|---|---|---|
| 1. ... | ... | ... | pp. ... | ... |

**How we will work:** We will study one chapter at a time. You will attempt practice before solutions are shown.

## Start
[Diagnostic or Lesson 1 opening]
```

## Lesson

```markdown
# Chapter [N]: [title]

**Why it matters:** ...
**By the end, you can:**
- ...
- ...

## 1. [concept]
[Explanation]

### Worked example
[Reasoned example]

### Common trap
[Misconception or boundary]

## Check
[One short active-recall question]
```

Continue with the next explanation or practice after the learner responds when the material is dense.

## Practice prompt

```markdown
## Practice [N]
**Skill tested:** [concept/cognitive level]
**Task:** ...
**Success criteria:** ...

Reply with your reasoning, not only the final answer.
```

Do not include solution text in the same response.

## Feedback

```markdown
**Verdict:** [Correct / Mostly correct / Partially correct / Needs revision]

**What worked:** ...
**Key gap:** ...
**Correction:** ...

**Next step:** [revision request, follow-up question, or advancement]
```

## Chapter checkpoint

```markdown
## Chapter checkpoint
- Completed: ...
- Strong concepts: ...
- Needs review: ...
- Next chapter: ...

### Cumulative recall
1. ...
2. ...
3. ...
```

## Progress report

```markdown
# Progress
**Course:** ...
**Completed:** [x/y chapters]
**Current:** ...
**Mastered:** ...
**Practicing:** ...
**Review needed:** ...
**Recommended next action:** ...
```