---
name: compose:plan
description: Use when you have a spec or requirements for a multi-step task, before touching code
---

# Writing Plans

## Overview

Write comprehensive implementation plans assuming the engineer has zero context for our codebase and questionable taste. Document everything they need to know: which files to touch for each task, code, testing, docs they might need to check, how to test it. Give them the whole plan as bite-sized tasks. DRY. YAGNI. TDD. Frequent commits.

Assume they are a skilled developer, but know almost nothing about our toolset or problem domain. Assume they don't know good test design very well.

**Announce at start:** "I'm using the compose:plan skill to create the implementation plan."

**Context:** If working in an isolated worktree, it should have been created via the `compose:worktree` skill at execution time.

**Save plans to:** the `plans/` directory given in the `<compose_docs_dir>` block of your prompt, as `YYYY-MM-DD-<feature-name>.md`.
- (User preferences for plan location override this default)

## Scope Check

If the spec covers multiple independent subsystems, it should have been broken into sub-project specs during brainstorming. If it wasn't, suggest breaking this into separate plans — one per subsystem. Each plan should produce working, testable software on its own.

## File Structure

Before defining tasks, map out which files will be created or modified and what each one is responsible for. This is where decomposition decisions get locked in.

- Design units with clear boundaries and well-defined interfaces. Each file should have one clear responsibility.
- You reason best about code you can hold in context at once, and your edits are more reliable when files are focused. Prefer smaller, focused files over large ones that do too much.
- Files that change together should live together. Split by responsibility, not by technical layer.
- In existing codebases, follow established patterns. If the codebase uses large files, don't unilaterally restructure - but if a file you're modifying has grown unwieldy, including a split in the plan is reasonable.

This structure informs the task decomposition. Each task should produce self-contained changes that make sense independently.

## Task Right-Sizing

A task is the smallest unit that carries its own test cycle and is worth a
fresh reviewer's gate. When drawing task boundaries:

- Fold setup, configuration, scaffolding, and documentation steps into the task whose deliverable needs them
- Split only where a reviewer could meaningfully reject one task while approving its neighbor
- Each task ends with an independently testable deliverable

## Bite-Sized Task Granularity

**Each step is one action (2-5 minutes):**
- "Write the failing test" - step
- "Run it to make sure it fails" - step
- "Implement the minimal code to make the test pass" - step
- "Run the tests and make sure they pass" - step
- "Commit" - step

## Plan Document Header

**Every plan MUST start with this header:**

```markdown
# [Feature Name] Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]

## Global Constraints

[Project-wide requirements that bind EVERY task — version floors, dependency
limits, naming and copy rules, platform requirements, exact values. One line
each, copied verbatim from the spec. Implementers and reviewers downstream
implicitly inherit this section without being told individually.]

---
```

## Task Structure

````markdown
### Task N: [Component Name]

**Covers:** [S3, S7]
<!-- spec section anchors this task implements; every task that produces
     spec-required behavior must list at least one. Omit only for pure
     scaffolding tasks (e.g. project setup) that map to no spec section. -->

**Files:**
- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`

**Interfaces:**
- Consumes: [what this task uses from earlier tasks — exact signatures, types]
- Produces: [what later tasks rely on — exact function names, parameter and
  return types. An implementer sees only its own task; this block is how it
  learns the names and types neighboring tasks use.]

- [ ] **Step 1: Write the failing test**

```python
def test_specific_behavior():
    result = function(input)
    assert result == expected
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/path/test.py::test_name -v`
Expected: FAIL with "function not defined"

- [ ] **Step 3: Write minimal implementation**

```python
def function(input):
    return expected
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/path/test.py::test_name -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/path/test.py src/path/file.py
git commit -m "feat: add specific feature"
```
````

## No Placeholders

Every step must contain the actual content an engineer needs. These are **plan failures** — never write them:
- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases"
- "Write tests for the above" (without actual test code)
- "Similar to Task N" (repeat the code — the engineer may be reading tasks out of order)
- Steps that describe what to do without showing how (code blocks required for code steps)
- References to types, functions, or methods not defined in any task

## Remember
- Exact file paths always
- Complete code in every step — if a step changes code, show the code
- Exact commands with expected output
- DRY, YAGNI, TDD, frequent commits

## Self-Review

After writing the complete plan, look at the spec with fresh eyes and check the plan against it. This is a checklist you run yourself — not a subagent dispatch.

**1. Spec coverage:** Skim each `[Sn]` section in the spec. Can you point to a task whose **Covers:** lists it? Every spec section must be covered by at least one task. Conversely, every `Covers:` ID must resolve to a real spec section. List any gap in either direction and add or fix the task.

**2. Placeholder scan:** Search your plan for red flags — any of the patterns from the "No Placeholders" section above. Fix them.

**3. Type consistency:** Do the types, method signatures, and property names you used in later tasks match what you defined in earlier tasks? A function called `clearLayers()` in Task 3 but `clearFullLayers()` in Task 7 is a bug.

If you find issues, fix them inline. No need to re-review — just fix and move on. If you find a spec requirement with no task, add the task.

## Execution Handoff

After saving the plan, determine execution approach:

1. **Check memory** for a saved `execution-style` preference in the `compose-preferences` memory file. If found (`subagent` or `inline`), use it and skip to the handler below.

2. **If no saved preference,** ask through `compose:ask`:
   - header: `Execution`
   - question: `Plan saved. How would you like to execute it?`
   - options:
     - label: `Subagent, always`, description: `Fresh subagent per task — remember for future sessions`
     - label: `Subagent, this time`, description: `Fresh subagent per task — just this once`
     - label: `Inline, always`, description: `Execute in this session — remember for future sessions`
     - label: `Inline, this time`, description: `Execute in this session — just this once`

   If no user is available, default to Inline for ≤ 3 tasks or tightly coupled tasks, Subagent for > 3 independent tasks.

3. **If "always" variant:** Save to the `compose-preferences` memory file as `execution-style: subagent` or `execution-style: inline`.

**If Subagent:** Use compose:subagent — fresh subagent per task + two-stage review.

**If Inline:** Use compose:execute — batch execution with checkpoints
