# Code Quality Reviewer Prompt Template

Use this template when dispatching a code quality reviewer subagent.

**Purpose:** Verify implementation is well-built (clean, tested, maintainable)

**Only dispatch after spec compliance review passes.**

Dispatch a `general` subagent via the `actor` tool, following the syntax in that
tool's own description. Build the prompt from
`<compose:review>/code-reviewer.md`, filling in:

- DESCRIPTION: [task summary, from implementer's report]
- PLAN_OR_REQUIREMENTS: Task N from [plan-file]
- BASE_SHA: [commit before task]
- HEAD_SHA: [current commit]

If the work was done in an isolated worktree, also tell the reviewer to `cd` there before running git/tests (see `code-reviewer.md`'s Git Range note). Skip this if there's no separate worktree.

**In addition to standard code quality concerns, the reviewer should check:**
- Does each file have one clear responsibility with a well-defined interface?
- Are units decomposed so they can be understood and tested independently?
- Is the implementation following the file structure from the plan?
- Did this implementation create new files that are already large, or significantly grow existing files? (Don't flag pre-existing file sizes — focus on what this change contributed.)

**Code reviewer returns:** Strengths, Issues (Critical/Important/Minor), Assessment
