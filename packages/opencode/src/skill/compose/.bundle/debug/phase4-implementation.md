# Phase 4: Implementation

**Load this after completing Phase 3 (hypothesis confirmed).**

## Steps

### 1. Create Failing Test Case
- Simplest possible reproduction
- Automated test if possible
- One-off test script if no framework
- MUST have before fixing
- Use the `compose:tdd` skill for writing proper failing tests

### 2. Implement Single Fix
- Address the root cause identified
- ONE change at a time
- No "while I'm here" improvements
- No bundled refactoring

### 3. Verify Fix
- Test passes now?
- No other tests broken?
- Issue actually resolved?

### 4. If Fix Doesn't Work
- STOP
- Count: How many fixes have you tried?
- If < 3: Return to Phase 1, re-analyze with new information
- **If ≥ 3: STOP and question the architecture (step 5 below)**
- DON'T attempt Fix #4 without architectural discussion

### 5. If 3+ Fixes Failed: Question Architecture

**Pattern indicating architectural problem:**
- Each fix reveals new shared state/coupling/problem in different place
- Fixes require "massive refactoring" to implement
- Each fix creates new symptoms elsewhere

**STOP and question fundamentals:**
- Is this pattern fundamentally sound?
- Should we refactor architecture vs. continue fixing symptoms?

## Success Criteria

Bug is resolved. Test passes. No regressions.
