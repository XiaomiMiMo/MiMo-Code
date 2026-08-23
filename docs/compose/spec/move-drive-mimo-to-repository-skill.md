---
feature: move-drive-mimo-to-repository-skill
status: in-progress
updated: 2026-08-23
branch: codex/move-drive-mimo
commits: TBD
---

# Move Drive MiMo to a Repository Skill

## Report

## [S1] Problem
`drive-mimo` is packaged and presented as a MiMoCode built-in skill even though it is repository-specific tooling for exercising MiMoCode. This makes it available outside the repository and gives it bundled-only TUI metadata.

## [S2] Design
Move the complete `drive-mimo` skill directory to the repository root at `.mimocode/skills/drive-mimo/`, where the project skill discovery path loads it as a non-bundled repository skill. Remove the built-in bundle copy and bundled-only README and localization entries. Preserve the skill name, frontmatter, instructions, helper script, and normal slash invocation behavior.

## [S3] Out of Scope
Do not change the skill instructions, helper behavior, skill discovery implementation, or other built-in skills.

## Tasks
- [ ] T1: Relocate the skill files to `.mimocode/skills/drive-mimo/` — acceptance: the repository contains the complete skill and no built-in bundle copy (covers: S2)
- [ ] T2: Remove bundled-only documentation and localization references — acceptance: README and TUI locale catalogs no longer identify `drive-mimo` as bundled (covers: S2)
- [ ] T3: Verify repository discovery and absence from the built-in bundle — acceptance: focused tests/checks show the skill is discovered from the project path with `bundled` unset and absent from the extracted built-in bundle (covers: S2)
