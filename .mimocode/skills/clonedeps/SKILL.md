---
name: clonedeps
description: >
  Clone important project dependency source code into an ignored local workspace
  so you can inspect library internals. Use when user asks to clone dependencies,
  inspect dependency/source internals, understand SDK/framework behavior from source,
  or debug library implementation details.
  Trigger: "clone deps", "inspect dependency source", "clonedeps".
---

# Clonedeps Skill

Make important dependency source repositories locally readable for inspection.

## When to Use

- User asks to clone dependencies or inspect dependency source
- Need to understand SDK/framework behavior from source code
- Debugging library implementation details
- Making core dependency repos locally readable

**When NOT to use:**
- Ordinary API/docs questions — use webfetch or grep instead
- Tiny utilities or transitive dependencies

## Workflow

### Step 1: Check Existing State

Check if `.mimocode/clonedeps.json` exists.

If exists:
1. Read it before planning new clones
2. Check each listed `path` exists under `.mimocode/clonedeps/repos/`
3. Reuse existing clones when they satisfy the task
4. Only plan new clones if manifest is missing, stale, or insufficient

### Step 2: Plan Dependencies to Clone

Analyze the project to recommend repos worth cloning:

1. Read `package.json` / `go.mod` / `requirements.txt` / `Cargo.toml` etc.
2. Identify 3-5 core dependencies (frameworks, SDKs, ORMs, runtime APIs)
3. Skip: tiny utilities, transitive deps, dev-only tools

For each recommendation:
- dependency name
- repo URL (HTTPS only)
- tag/commit/ref to check out
- why cloning source helps
- caveats (huge repo, missing tag, etc.)

### Step 3: Verify and Confirm

Before cloning:
1. Verify refs with `git ls-remote` where practical
2. Prefer pinned tags or commit SHAs
3. Only use HTTPS GitHub/GitLab-style URLs
4. Present plan to user with dependency, URL, ref, reason, caveats
5. Ask for confirmation before network operations

### Step 4: Clone Sources

Create folder per repo under:

```text
.mimocode/clonedeps/repos/<safe-repo-name>/
```

Derive safe name from repo owner/name:
- `https://github.com/opencode-ai/opencode.git` → `opencode-ai__opencode`
- Replace `/` with `__`, strip `.git`, replace unsafe chars with `_`

Clone pattern:
1. `git ls-remote <repoUrl> <ref>` to verify
2. Clone without submodules
3. Prefer shallow clone
4. Clone into temp dir, move after checkout succeeds
5. Remove failed temp clones

Do NOT run dependency install/build/test scripts from cloned repos.

### Step 5: Write State

Write `.mimocode/clonedeps.json`:

```json
{
  "version": "1.0.0",
  "updatedAt": "2026-01-01T00:00:00.000Z",
  "dependencies": [
    {
      "name": "example-lib",
      "resolvedVersion": "1.2.3",
      "repoUrl": "https://github.com/user/example-lib.git",
      "ref": "v1.2.3",
      "path": ".mimocode/clonedeps/repos/user__example-lib",
      "reason": "Core SDK source for debugging"
    }
  ]
}
```

### Step 6: Update Ignore Files

Add to `.gitignore`:

```gitignore
# BEGIN mimocode-clonedeps
.mimocode/clonedeps/repos/
# END mimocode-clonedeps
```

Add to `.ignore` (so MiMo Code can read cloned source):

```
# BEGIN mimocode-clonedeps
!.mimocode/
!.mimocode/clonedeps.json
!.mimocode/clonedeps/
!.mimocode/clonedeps/repos/
!.mimocode/clonedeps/repos/**
.mimocode/clonedeps/repos/**/.git/
.mimocode/clonedeps/repos/**/.git/**
# END mimocode-clonedeps
```

### Step 7: Register in AGENTS.md

Update root `AGENTS.md` with:

```markdown
## Cloned Dependency Source

Read-only dependency source repositories are available under
`.mimocode/clonedeps/repos/` for inspection. Do not edit these clones.

- `.mimocode/clonedeps/repos/<safe-name>/` — `<repo>` at `<ref>`; <why useful>.
```

## Cleanup

When user asks to clean cloned dependencies, remove:
- `.mimocode/clonedeps/repos/`
- managed marker blocks from `.gitignore` and `.ignore`

Ask before removing `.mimocode/clonedeps.json` or `AGENTS.md` section.
