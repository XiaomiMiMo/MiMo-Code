---
name: skill-creator
description: "Interactive guide for creating, reviewing, and improving agent skills (SKILL.md folders). Use when the user wants to build a new skill ('create a skill', 'make a skill for X', 'write a SKILL.md', 'turn this workflow into a skill'), review or improve an existing skill, fix a skill that never triggers or triggers too often, or validate a skill folder before sharing it. Do NOT use for general prompt writing, MCP server development, or editing arbitrary markdown files."
version: 1.0.0
license: MIT
platforms: [linux, macos, windows]
---

# Skill Creator

A skill is a folder that teaches an agent how to handle a specific task or workflow:

```
your-skill-name/
├── SKILL.md       # Required — YAML frontmatter + Markdown instructions
├── scripts/       # Optional — executable code (Python, Bash, ...)
├── references/    # Optional — docs loaded only when needed
└── assets/        # Optional — templates, fonts, icons used in output
```

Skills rely on **progressive disclosure**: the frontmatter is always in context (so it decides *when* the skill loads), the SKILL.md body loads when relevant, and linked files load only on demand. Keep each level as small as it can be.

## Workflow: Creating a New Skill

### Step 1: Define 2-3 concrete use cases

Before writing anything, pin down with the user:

- What does the user want to accomplish? (outcome, not feature)
- What triggers it? Collect literal phrases users would say.
- What steps does the workflow require, in order?
- Which tools are needed (built-in, scripts, MCP servers)?
- What domain knowledge or best practices must be embedded?

Write each use case as: **Trigger → Steps → Result**. If the user is vague, propose use cases and confirm rather than guessing silently.

Identify the category — it shapes the structure:

1. **Document & asset creation** — embed style guides, templates, quality checklists.
2. **Workflow automation** — step-by-step process with validation gates.
3. **MCP enhancement** — orchestrate MCP tool calls in sequence with domain expertise.

### Step 2: Plan the folder structure

- Folder name: kebab-case only (`my-skill` — no spaces, capitals, or underscores) and it should match the frontmatter `name`.
- `SKILL.md` must be named exactly that, case-sensitive.
- Never put a `README.md` inside the skill folder.
- Keep SKILL.md under ~5,000 words; move detail to `references/` and link to it.
- For critical validations, prefer a bundled script over prose — code is deterministic, language interpretation isn't.

### Step 3: Write the frontmatter

The frontmatter is the single most important part — it alone decides whether the skill ever loads.

```yaml
---
name: your-skill-name
description: [What it does] + [When to use it, with literal trigger phrases] + [negative triggers if needed]
---
```

Rules (hard requirements):

- `description` MUST state both WHAT the skill does and WHEN to use it, under 1024 characters.
- Include specific phrases users would actually say, and file types if relevant.
- No XML angle brackets anywhere in frontmatter (it is injected into the system prompt).
- `name` must not use reserved prefixes ("claude", "anthropic").

Weak: `description: Helps with projects.`
Strong: `description: Manages Linear sprint workflows including planning, task creation, and status tracking. Use when the user mentions "sprint", "Linear tasks", or asks to "create tickets".`

For all optional fields (`license`, `compatibility`, `metadata`, `allowed-tools`) and more good/bad examples, read `references/frontmatter.md`.

### Step 4: Write the instructions

Recommended body structure:

```markdown
# Skill Name

## Instructions
### Step 1: [First major step]
Exact commands / tool calls, with expected output described.

## Examples
User says X → actions → result.

## Troubleshooting
Error → cause → fix.
```

Best practices:

- Be specific and actionable: give exact commands with flags and expected output, not vibes ("validate the data").
- Put critical instructions at the top; use `## Important` headers for must-not-skip rules.
- Include error handling for the failures users will actually hit.
- Reference bundled resources explicitly ("Before writing queries, read the API-patterns file in references/").
- Number steps that must happen in order; state data dependencies between steps.

For proven structural patterns (sequential orchestration, multi-MCP coordination, iterative refinement, context-aware tool selection, domain-specific intelligence), read `references/patterns.md`.

### Step 5: Validate

Run the bundled validator on the skill folder:

```bash
python scripts/validate_skill.py /path/to/your-skill-name
```

It checks naming, frontmatter format and length, forbidden content, missing linked files, and body size. Fix every ERROR; treat WARNINGs as review prompts. Expected output on success: `PASS` with 0 errors.

### Step 6: Test and iterate

Iterate on a single challenging task until it succeeds, then extract the winning approach into the skill — this gives faster signal than broad testing. Then cover:

1. **Triggering**: obvious phrasing loads it, paraphrases load it, unrelated queries don't.
2. **Function**: outputs correct, tool calls succeed, edge cases handled.
3. **Baseline comparison**: fewer corrections / tool calls / tokens than without the skill.

Debugging trick: ask the agent "When would you use the [name] skill?" — it will paraphrase the description back; fix what's missing.

Full test-case templates and iteration signals are in `references/testing.md`.

## Workflow: Reviewing an Existing Skill

When asked to review or improve a skill:

1. Read its SKILL.md and run `python scripts/validate_skill.py <folder>`.
2. Diagnose against the common failure modes:
   - **Never triggers** → description too generic or missing user-facing trigger phrases. Rewrite with literal phrases and keywords.
   - **Triggers too often** → add negative triggers ("Do NOT use for...") and narrow the scope.
   - **Loads but instructions ignored** → instructions too verbose, buried, or ambiguous. Move critical rules to the top, replace prose validations with a script.
   - **Slow / degraded responses** → SKILL.md too large; move detail into `references/`.
3. Propose concrete edits (before/after for the description), not general advice.
4. If the user brings failure examples from real sessions, encode the fix as an explicit instruction or troubleshooting entry — that is the highest-value iteration loop.

## Quick Checklist

Before delivering a skill, verify:

- [ ] Folder is kebab-case and matches frontmatter `name`
- [ ] `SKILL.md` exact filename; no `README.md` inside the folder
- [ ] Frontmatter has `---` delimiters, `name`, and a WHAT+WHEN `description` under 1024 chars
- [ ] No XML angle brackets in frontmatter
- [ ] Instructions specific and actionable, with examples and error handling
- [ ] Every referenced `scripts/`, `references/`, `assets/` file actually exists
- [ ] `validate_skill.py` passes with 0 errors
- [ ] Triggering tested: fires on target phrasings, silent on unrelated ones
