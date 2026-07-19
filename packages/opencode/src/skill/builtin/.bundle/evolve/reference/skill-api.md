# Skill API Reference

## File Structure

```
.mimocode/skills/<skill-name>/
├── SKILL.md              # Required — main skill document
├── supporting-file.md    # Optional — reference material
└── scripts/              # Optional — executable scripts
    └── helper.sh
```

## SKILL.md Format

```markdown
---
name: my-skill-name
description: Use when [triggering conditions]
---

# Skill Title

Content loaded into conversation when the skill is invoked.
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Unique identifier (letters, numbers, hyphens only) |
| `description` | yes | When to use — starts with "Use when..." (max ~500 chars) |
| `hidden` | no | If `true`, not shown in skill list (agent can still load by name) |

### Description Guidelines

- Start with "Use when..." — focus on **triggering conditions**, not what the skill does
- Don't summarize the workflow (agent may follow the summary instead of reading the full content)
- Include symptoms, situations, contexts that signal this skill applies
- Write in third person

```yaml
# ❌ BAD: summarizes workflow
description: Creates tools and hooks by writing files to .mimocode directories

# ✅ GOOD: triggering conditions only
description: Use when you want to evolve your own capabilities or notice repeated patterns worth automating
```

## Skill Content

The body after frontmatter is injected into the conversation when the skill is loaded. It can contain:

- Instructions and workflows
- Code examples (inline)
- Reference to supporting files via `@filename.md` (loads the file)
- Flowcharts (DOT format)
- Tables, lists, any markdown

## Referencing Supporting Files

Use `@filename` to reference files in the same skill directory:

```markdown
See @reference/detailed-api.md for the full API specification.
```

The file content is loaded on demand when the agent accesses it.

## Examples

### Simple technique skill
```markdown
---
name: retry-pattern
description: Use when implementing retry logic, handling transient failures, or dealing with flaky external services
---

# Retry Pattern

## Core Pattern
\```ts
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try { return await fn() }
    catch (e) { if (i === maxRetries - 1) throw e; await sleep(2 ** i * 100) }
  }
  throw new Error("unreachable")
}
\```

## When NOT to use
- Deterministic errors (400, 404) — retrying won't help
- Operations with side effects that can't be repeated safely
```

### Reference skill with supporting files
```markdown
---
name: project-api
description: Use when working with this project's REST API endpoints, authentication, or data models
---

# Project API Reference

See @endpoints.md for the full endpoint list.
See @auth.md for authentication flow.
See @models.md for data model schemas.
```

## Hot-Reload Behavior

- New skills appear in the available skills list on the next turn
- Modified skills are reloaded on the next turn
- The agent can invoke skills via the skill tool or `/skill-name`
