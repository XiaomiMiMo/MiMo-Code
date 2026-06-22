---
name: compose:new-skill
hidden: true
description: Use when creating new skills or editing existing skills for the project or personal skill library
---

# Writing Skills

## Overview

A **skill** is a reusable reference guide — techniques, patterns, or tools — that helps agents find and apply effective approaches.

**Skills are:** Reusable techniques, patterns, tools, reference guides

**Skills are NOT:** Narratives about how you solved a problem once

## When to Create a Skill

**Create when:**
- Technique wasn't intuitively obvious
- You'd reference this again across projects
- Pattern applies broadly (not project-specific)
- Others would benefit from this knowledge

**Don't create for:**
- One-off solutions
- Standard practices well-documented elsewhere
- Project-specific conventions (put in project config like CLAUDE.md)
- Mechanical constraints enforceable with regex/validation (automate it instead)

## Skill Types

| Type | Purpose | Examples |
|------|---------|----------|
| **Technique** | Concrete method with steps | condition-based-waiting, root-cause-tracing |
| **Pattern** | Way of thinking about problems | flatten-with-flags, test-invariants |
| **Reference** | API docs, syntax guides | tool documentation, library guides |

## SKILL.md Format

```markdown
---
name: skill-name
description: Use when [specific triggering conditions]
---

# Skill Name

## Overview
Core principle in 1-2 sentences.

## When to Use
Bullet list with symptoms and use cases.
When NOT to use.

## Core Pattern
Before/after code comparison or step-by-step process.

## Quick Reference
Table or bullets for scanning common operations.

## Common Mistakes
What goes wrong + fixes.
```

### Frontmatter Rules

- `name`: letters, numbers, hyphens only (max 64 chars)
- `description`: third-person, starts with "Use when...", max 1024 chars
- Description should ONLY describe triggering conditions — never summarize the skill's workflow

### Description: Why This Matters

Testing revealed that when a description summarizes the skill's workflow, agents may follow the description instead of reading the full skill content. A description saying "code review between tasks" caused the agent to do ONE review, even though the skill's flowchart clearly showed TWO reviews.

**The trap:** Descriptions that summarize workflow create a shortcut the agent will take. The skill body becomes documentation it skips.

```yaml
# BAD: summarizes workflow — agent may follow this instead of reading skill
description: Use when executing plans - dispatches subagent per task with code review

# BAD: too much process detail
description: Use for TDD - write test first, watch it fail, write minimal code, refactor

# GOOD: just triggering conditions
description: Use when executing implementation plans with independent tasks

# GOOD: symptoms-focused
description: Use when tests have race conditions, timing dependencies, or pass/fail inconsistently
```

### Writing Style

```yaml
# BAD: first person
description: I can help you with async tests when they're flaky

# BAD: too abstract, doesn't include when to use
description: For async testing

# GOOD: third person, starts with "Use when"
description: Use when implementing any feature or bugfix, before writing implementation code
```

## Skill Discovery Optimization (SDO)

Agents read descriptions to decide which skills to load. Make it answer: "Should I read this skill right now?"

### Keyword Coverage

Use words agents would search for:
- Error messages: "Hook timed out", "ENOTEMPTY", "race condition"
- Symptoms: "flaky", "hanging", "zombie", "pollution"
- Synonyms: "timeout/hang/freeze", "cleanup/teardown/afterEach"
- Tools: Actual commands, library names, file types

### Descriptive Naming

Use active voice, verb-first:
- `condition-based-waiting` not `async-test-helpers`
- `creating-skills` not `skill-creation`
- `root-cause-tracing` not `debugging-techniques`

## Directory Structure

```
skills/
  skill-name/
    SKILL.md              # Main reference (required)
    supporting-file.*     # Only if needed
```

**Keep inline:** Principles, concepts, code patterns (short examples).

**Separate files for:**
1. Heavy reference (100+ lines) — API docs, comprehensive syntax
2. Reusable tools — Scripts, utilities, templates

## Skill Location

Personal skills: `.mimocode/skills/<name>/SKILL.md`

## Token Efficiency

Skills load into context — every token counts.

**Target word counts:**
- Frequently-loaded skills: < 200 words total
- Other skills: < 500 words (still be concise)

**Techniques:**

```markdown
# BAD: Document all flags inline
search-conversations supports --text, --both, --after DATE, --before DATE

# GOOD: Reference --help
search-conversations supports multiple modes and filters. Run --help for details.
```

```markdown
# BAD: Repeat instructions from another skill
When searching, dispatch subagent with template...
[20 lines of repeated instructions]

# GOOD: Cross-reference
Always use subagents (50-100x context savings). REQUIRED: Use [other-skill-name] for workflow.
```

**Cross-referencing:** Use skill name only with explicit markers:
- `**REQUIRED BACKGROUND:** You MUST understand compose:tdd`
- `**REQUIRED SUB-SKILL:** Use eslint-setup`
- Never use `@` links (force-loads files, burns context)

## Code Examples

**One excellent example beats many mediocre ones.** Choose the most relevant language:
- Testing techniques → TypeScript/JavaScript
- System debugging → Shell/Python
- Data processing → Python

Don't implement in 5+ languages. Don't create fill-in-the-blank templates.

## Testing

Before deploying, verify the skill works:

1. Run a realistic scenario WITHOUT the skill — observe baseline behavior
2. Run the same scenario WITH the skill — verify improvement
3. If the skill enforces discipline, test under pressure (time + sunk cost + fatigue)

For discipline-enforcing skills (TDD, verification requirements), watch for rationalization:

| Excuse | Reality |
|--------|---------|
| "Too simple to test" | Simple code breaks. Test takes 30 seconds. |
| "I'll test after" | Tests passing immediately prove nothing. |
| "The skill is obviously clear" | Clear to you ≠ clear to other agents. |

**REQUIRED BACKGROUND:** Use compose:tdd principles for testing discipline-enforcing skills.

## Checklist

- [ ] Name uses only letters, numbers, hyphens
- [ ] Description starts with "Use when..." (third person, no workflow summary)
- [ ] Keywords throughout for search (errors, symptoms, tools)
- [ ] Content is concise — SKILL.md under 500 lines
- [ ] One excellent example (not multi-language)
- [ ] Tested with realistic scenarios
- [ ] No redundant explanations of what the agent already knows
- [ ] Supporting files only for tools or heavy reference
