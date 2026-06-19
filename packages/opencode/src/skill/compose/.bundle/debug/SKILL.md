---
name: compose:debug
hidden: true
description: Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes
---

# Systematic Debugging

## Overview

**Core principle:** ALWAYS find root cause before attempting fixes. Symptom fixes are failure.

## The Iron Law

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

If you haven't completed Phase 1, you cannot propose fixes.

## The Four Phases (Loaded On Demand)

Each phase has a detailed guide in this directory. Read the phase file when you reach that phase.

| Phase | File | Key Activities | When to Load |
|-------|------|---------------|-------------|
| **1. Root Cause** | `phase1-root-cause.md` | Read errors, reproduce, check changes, trace data flow | Always first |
| **2. Pattern Analysis** | `phase2-pattern-analysis.md` | Compare working/broken, identify differences | After root cause found |
| **3. Hypothesis & Testing** | `phase3-hypothesis.md` | Form theory, test minimally | After pattern analysis |
| **4. Implementation** | `phase4-implementation.md` | Create test, fix, verify | After hypothesis confirmed |

**Always start with Phase 1.** Load each subsequent phase only when the current one is complete.

## When to Use This Skill

Use for ANY technical issue:
- Test failures, bugs, unexpected behavior, performance problems
- Build failures, integration issues

**Don't skip** when the issue seems simple — simple bugs have root causes too.

## Quick Reference

| Phase | Key Activities | Success Criteria |
|-------|---------------|------------------|
| **1. Root Cause** | Read errors, reproduce, check changes, gather evidence | Understand WHAT and WHY |
| **2. Pattern** | Find working examples, compare | Identify differences |
| **3. Hypothesis** | Form theory, test minimally | Confirmed or new hypothesis |
| **4. Implementation** | Create test, fix, verify | Bug resolved, tests pass |

## Red Flags — If You Catch Yourself Thinking Any of These, Stop

- "Quick fix for now, investigate later"
- "Just try changing X and see if it works"
- "Add multiple changes, run tests"
- "It's probably X, let me fix that"
- Proposing solutions before tracing data flow

**All of these mean:** STOP. Return to Phase 1 by loading it.

## Supporting Techniques

- `phase1-root-cause.md` — Trace bugs backward through call stack
- `defense-in-depth.md` — Add validation at multiple layers after finding root cause
- `condition-based-waiting.md` — Replace arbitrary timeouts with condition polling

**Related skills:**
- `compose:tdd` — For creating failing test case (Phase 4)
- `compose:verify` — Verify fix worked before claiming success
