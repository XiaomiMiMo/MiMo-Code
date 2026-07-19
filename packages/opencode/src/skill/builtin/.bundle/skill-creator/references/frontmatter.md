# YAML Frontmatter Reference

The frontmatter is always loaded into the agent's system prompt. It is the first level of progressive disclosure and the only thing the agent sees when deciding whether to load the skill.

## Required fields

```yaml
---
name: skill-name-in-kebab-case
description: What it does and when to use it. Include specific trigger phrases.
---
```

### name

- kebab-case only: `notion-project-setup` — no spaces, underscores, or capitals
- Should match the folder name
- Reserved: names containing "claude" or "anthropic" are rejected

### description

- MUST include both WHAT the skill does and WHEN to use it (trigger conditions)
- Under 1024 characters
- No XML angle brackets
- Include specific tasks/phrases users might say; mention file types if relevant

Structure: `[What it does] + [When to use it] + [Key capabilities / negative triggers]`

## Optional fields

```yaml
license: MIT                     # for open-source skills
compatibility: Requires network access and Python 3.10+   # 1-500 chars, environment requirements
allowed-tools: "Bash(python:*) Bash(npm:*) WebFetch"      # restrict tool access
metadata:                        # any custom key-value pairs
  author: Company Name
  version: 1.0.0
  mcp-server: server-name
  category: productivity
  tags: [project-management, automation]
```

## Security restrictions

Frontmatter is injected into the system prompt, so:

- No XML angle brackets anywhere
- Safe-YAML parsing only — no code execution
- No "claude"/"anthropic" in the name (reserved)

## Description examples

### Good

```yaml
# Specific and actionable
description: Analyzes Figma design files and generates developer handoff
  documentation. Use when user uploads .fig files, asks for "design specs",
  "component documentation", or "design-to-code handoff".

# Includes trigger phrases
description: Manages Linear project workflows including sprint planning, task
  creation, and status tracking. Use when user mentions "sprint", "Linear
  tasks", "project planning", or asks to "create tickets".

# Clear value proposition + scope
description: End-to-end customer onboarding workflow for PayFlow. Handles
  account creation, payment setup, and subscription management. Use when user
  says "onboard new customer", "set up subscription", or "create PayFlow
  account".
```

### Bad

```yaml
# Too vague — will never trigger reliably
description: Helps with projects.

# Missing triggers — the agent can't tell when to load it
description: Creates sophisticated multi-page documentation systems.

# Too technical, no user-facing phrases
description: Implements the Project entity model with hierarchical relationships.
```

### Controlling over-triggering

```yaml
# Negative triggers
description: Advanced data analysis for CSV files. Use for statistical
  modeling, regression, clustering. Do NOT use for simple data exploration
  (use data-viz skill instead).

# Scope clarification
description: PayFlow payment processing for e-commerce. Use specifically for
  online payment workflows, not for general financial queries.
```
