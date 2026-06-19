# Phase 1: Root Cause Investigation

**Load this after reading SKILL.md. Complete this phase before loading Phase 2.**

## Steps

### 1. Read Error Messages Carefully
- Don't skip past errors or warnings
- Read stack traces completely
- Note line numbers, file paths, error codes

### 2. Reproduce Consistently
- Can you trigger it reliably?
- What are the exact steps?
- Does it happen every time?
- If not reproducible → gather more data, don't guess

### 3. Check Recent Changes
- What changed that could cause this?
- Git diff, recent commits
- New dependencies, config changes
- Environmental differences

### 4. Gather Evidence in Multi-Component Systems

When the system has multiple components (API → service → database):

**Before proposing fixes, add diagnostic instrumentation:**
```
For EACH component boundary:
  - Log what data enters component
  - Log what data exits component
  - Verify environment/config propagation
  - Check state at each layer

Run once to gather evidence showing WHERE it breaks
THEN analyze evidence to identify failing component
THEN investigate that specific component
```

### 5. Trace Data Flow

When the error is deep in the call stack:
- Where does the bad value originate?
- What called this with the bad value?
- Keep tracing up until you find the source
- Fix at source, not at symptom

## Success Criteria

You understand WHAT is wrong and WHY it's wrong. You can articulate the root cause.

## When to Move On

When you have identified the root cause and can explain it, load `phase2-pattern-analysis.md`.
