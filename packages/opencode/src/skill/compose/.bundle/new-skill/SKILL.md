---
name: compose:new-skill
hidden: true
description: Use when creating new skills or editing existing skills for the project or personal skill library
---

# Writing Skills

## Overview

A **skill** is a reusable reference guide — techniques, patterns, or tool documentation — that helps agents find and apply effective approaches.

## When to Create a Skill

**Create when:**
- Technique wasn't intuitively obvious
- You'd reference this again across projects
- Pattern applies broadly (not project-specific)

**Don't create for:**
- One-off solutions
- Standard practices well-documented elsewhere
- Project-specific conventions (put in project config)

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

### Description Anti-patterns

```yaml
# BAD: summarizes workflow — agent may follow this instead of reading the full skill
description: Use when executing plans - dispatches subagent per task with code review

# GOOD: just triggering conditions
description: Use when executing implementation plans with independent tasks
```

## Directory Structure

```
skills/
  skill-name/
    SKILL.md              # Main reference (required)
    supporting-file.*     # Only if needed (heavy reference or reusable tools)
```

Keep inline: principles, concepts, code patterns under 50 lines.
Separate files: 100+ line reference docs, executable scripts, templates.

## Skill Location

Personal skills live in `.mimocode/skills/<name>/SKILL.md`.

## Token Efficiency

Skills load into context — every token counts.

- Keep SKILL.md under 500 lines
- Move heavy reference to separate files (loaded on demand)
- Use `--help` references instead of documenting all flags inline
- Cross-reference other skills by name instead of repeating content

## Testing

Before deploying, verify the skill works:

1. Run a realistic scenario WITHOUT the skill — observe baseline behavior
2. Run the same scenario WITH the skill — verify improvement
3. If the skill enforces discipline, test under pressure (time + sunk cost + fatigue)

**REQUIRED BACKGROUND:** Use compose:tdd principles for testing discipline-enforcing skills.

## Checklist

- [ ] Name uses only letters, numbers, hyphens
- [ ] Description starts with "Use when..." (third person, no workflow summary)
- [ ] Content is concise — under 500 lines
- [ ] Tested with realistic scenarios
- [ ] No redundant explanations of what the agent already knows
