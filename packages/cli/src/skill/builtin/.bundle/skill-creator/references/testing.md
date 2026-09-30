# Testing and Iteration

Pick rigor to match the skill's audience: a personal skill needs manual spot-checks; one deployed to a whole org deserves a scripted test suite.

**Pro tip**: iterate on a single challenging task until the agent succeeds, then extract the winning approach into the skill. This gives faster signal than broad testing. Expand to multiple cases only once the foundation works.

## 1. Triggering tests

Goal: the skill loads at the right times — and only then.

Build a test suite like:

```
Should trigger:
- "Help me set up a new ProjectHub workspace"        (obvious)
- "I need to create a project in ProjectHub"          (paraphrase)
- "Initialize a ProjectHub project for Q4 planning"   (paraphrase)

Should NOT trigger:
- "What's the weather in San Francisco?"
- "Help me write Python code"
- "Create a spreadsheet"  (unless the skill handles sheets)
```

Aim for triggering on ~90% of relevant queries. Debugging: ask the agent "When would you use the [name] skill?" — it will quote the description back; adjust based on what's missing.

## 2. Functional tests

Goal: the skill produces correct outputs.

```
Test: Create project with 5 tasks
Given: Project name "Q4 Planning", 5 task descriptions
When:  Skill executes workflow
Then:  Project created; 5 tasks with correct properties;
       all tasks linked; no API errors
```

Cover: valid outputs, tool/API calls succeed, error handling works, edge cases.

## 3. Performance comparison

Goal: prove the skill beats the baseline. Run the same task with and without the skill; compare:

```
Without skill: 15 back-and-forth messages, 3 failed API calls, 12,000 tokens
With skill:    2 clarifying questions,     0 failed API calls,  6,000 tokens
```

Qualitative checks: does the user ever need to prompt for next steps? Do 3-5 runs of the same request produce structurally consistent output? Can a new user succeed on the first try?

## Iteration signals

Skills are living documents. Watch for:

| Signal | Diagnosis | Fix |
|---|---|---|
| Skill doesn't load when it should; users invoke it manually | Under-triggering | Add detail, keywords, and literal trigger phrases to the description |
| Skill loads for irrelevant queries; users disable it | Over-triggering | Add negative triggers ("Do NOT use for..."), narrow the scope |
| Inconsistent results, failed calls, user corrections | Execution issues | Sharpen instructions, add error handling, replace prose validation with a script |
| Slow or degraded responses | Context bloat | Shrink SKILL.md, move detail to `references/` |

When real sessions surface an edge case or failure, bring the transcript back and encode the fix directly: an explicit instruction, a troubleshooting entry, or a validation step. This is the highest-value iteration loop.

## Common troubleshooting

**"Could not find SKILL.md"** — file not named exactly `SKILL.md` (case-sensitive).

**"Invalid frontmatter"** — missing `---` delimiters or malformed YAML (unclosed quotes are the usual culprit).

**"Invalid skill name"** — spaces or capitals in `name`; use kebab-case.

**Skill loads but instructions are ignored** — instructions too verbose or buried. Keep them concise, put critical rules at the top under `## Important`, and move detail to `references/`. For must-pass validations, bundle a script instead of relying on prose.
