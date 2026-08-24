---
feature: move-drive-mimo-to-repository-skill
status: delivered
updated: 2026-08-23
branch: codex/move-drive-mimo
commits: b7ff175e..dca3d16f
---

# Move Drive MiMo to a Repository Skill

## Report

**What was built** — Moved the complete `drive-mimo` skill from the built-in bundle to the repository-level `.mimocode/skills/drive-mimo/` path. Removed its built-in README entries and bundled-only TUI localization metadata while preserving the skill behavior and helper script. Updated the helper invocation note to match the repository-managed executable bit.

**Verification** — `bun ci` PASS; `bun test test/skill/skill.test.ts test/skill/bundle-discovery.test.ts test/skill/builtin.test.ts test/skill/skill-description.test.ts` PASS (34 tests); `bun typecheck` PASS; scope and `git diff --check` checks PASS. Independent review PASS for spec compliance, correctness, and codebase consistency.

**Journey log** — The initial review found a translated README table entry missed by the first cleanup; it was removed and covered by re-review. A repository discovery regression test was added to assert `bundled` remains unset for project skills.

## [S1] Problem
`drive-mimo` is packaged and presented as a MiMoCode built-in skill even though it is repository-specific tooling for exercising MiMoCode. This makes it available outside the repository and gives it bundled-only TUI metadata.

## [S2] Design
Move the complete `drive-mimo` skill directory to the repository root at `.mimocode/skills/drive-mimo/`, where the project skill discovery path loads it as a non-bundled repository skill. Remove the built-in bundle copy and bundled-only README and localization entries. Preserve the skill name, frontmatter, behavior, helper script, and normal slash invocation behavior; update documentation where the repository-managed file mode differs from the extracted bundle.

## [S3] Out of Scope
Do not change the skill behavior, helper behavior, skill discovery implementation, or other built-in skills. Documentation corrections required by the new repository-managed layout are in scope.

## Tasks
- [x] T1: Relocate the skill files to `.mimocode/skills/drive-mimo/` — acceptance: the repository contains the complete skill and no built-in bundle copy (covers: S2)
- [x] T2: Remove bundled-only documentation and localization references — acceptance: README and TUI locale catalogs no longer identify `drive-mimo` as bundled (covers: S2)
- [x] T3: Verify repository discovery and absence from the built-in bundle — acceptance: focused tests/checks show the skill is discovered from the project path with `bundled` unset and absent from the extracted built-in bundle (covers: S2)
