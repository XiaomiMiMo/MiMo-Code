---
name: simplify
description: >
  Simplifies code for clarity without changing behavior. Use for readability,
  maintainability, and complexity reduction after behavior is understood.
  Trigger: "simplify", "clean up code", "refactor for readability".
---

# Code Simplification

Simplify code by reducing complexity while preserving exact behavior.
Goal: code that is easier to read, understand, modify, and debug.
Test: "Would a new team member understand this faster than the original?"

## When to Use

- After a feature is working and tests pass, but implementation feels heavy
- During code review when readability/complexity issues flagged
- Deeply nested logic, long functions, or unclear names
- Refactoring code written under time pressure
- Consolidating related logic scattered across files
- After merging changes that introduced duplication

**When NOT to use:**

- Code is already clean — don't simplify for sake of it
- Don't understand what code does yet — comprehend first
- Performance-critical and "simpler" version would be measurably slower
- About to rewrite module entirely — simplifying throwaway code wastes effort

## Five Principles

### 1. Preserve Behavior Exactly

Don't change what code does — only how it expresses it.
All inputs, outputs, side effects, error behavior, edge cases must remain identical.

Before every change ask:
- Same output for every input?
- Same error behavior?
- Same side effects and ordering?
- All existing tests still pass?

### 2. Follow Project Conventions

Simplification = making code more consistent with codebase, not imposing external preferences.

Before simplifying:
1. Read `AGENTS.md` / project conventions
2. Study how neighboring code handles similar patterns
3. Match project's style for imports, naming, function style, error handling

### 3. Prefer Clarity Over Cleverness

Explicit > compact when compact requires mental pause to parse.
- Replace nested ternaries with readable control flow
- Replace dense inline transforms with named intermediate steps when they clarify intent
- Keep helpful names even if they cost a few extra lines

### 4. Maintain Balance

Watch for over-simplification:
- Don't inline away names that carry meaning
- Don't merge unrelated logic into one larger function
- Don't remove abstractions that serve testability or extensibility
- Don't optimize for line count over comprehension

### 5. Scope to What Changed

Default to simplifying recently modified code.
Avoid unrelated drive-by refactors unless explicitly asked.

## Process

### Step 1: Understand Before Touching

Before changing/removing anything, understand why it exists.
Answer: responsibility, callers/callees, edge cases, tests, why written this way.
If can't answer these, read more context first.

### Step 2: Look for Simplification Opportunities

Signals:
- Deep nesting
- Long functions with mixed responsibilities
- Nested ternaries
- Boolean flag arguments
- Repeated conditionals
- Generic or misleading names
- Duplicated logic
- Dead code
- Wrappers/abstractions that add no value

### Step 3: Apply Changes Incrementally

Make one simplification at a time.
For each: make change → run tests → keep only if behavior preserved.
Separate refactoring from feature work when possible.

### Step 4: Verify the Result

After simplifying, confirm:
- Code is genuinely easier to understand
- Diff is clean and reviewable
- Project conventions still match
- No behavior, error handling, or side effects changed

## Verification Checklist

- [ ] Existing tests pass without modification
- [ ] Build/typecheck/lint still pass
- [ ] No unrelated files were refactored
- [ ] No error handling weakened or removed
- [ ] Result is simpler to review than original
