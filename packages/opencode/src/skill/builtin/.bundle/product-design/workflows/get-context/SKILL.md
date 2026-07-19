---
name: get-context
description: "Mandatory design-brief gate for clarifying the product and outcome. Use before ideation, image-to-code builds, redesigns, or product UI work to clarify missing product information and play back the brief before proceeding."
---

# Get Context


Run this skill at the start of Product Design requests that ask to design, build, prototype, clone, redesign, extend, or generate product UI directions.

Use question mode to clarify the following:

- what product, site, feature, workflow, component, or screen is being designed, redesigned, or extended
- what the feature, change, app, or website should help the user do

Do not re-ask answered questions. When both are clear, play back the brief and defaults in one pithy note, name the next workflow, and continue in the same turn. Playback is not a request for approval. The user can course-correct style, scope, or interactivity at any point.

Hard boundary: do not implement UI, scaffold a prototype, start a server, or create files while the design target or intended user outcome is still missing.

## Critical Overrides

- Refer to the Plugin router [$index](../index/SKILL.md) before proceeding.
- Follow [$critical-overrides](../../references/critical-overrides.md).

## User Context

Before starting, load [$user-context](../user-context/SKILL.md) and run its preflight script when local shell access is available.

Use saved product URLs, Figma files, screenshots, reference images, codebase paths, Storybook, tokens, design systems, brand assets, component refs, browser preferences, and share targets as grounding material when relevant.

Do not inspect every saved reference. Inspect only what the current task needs.

## Handoff To The Next Workflow

1. When the next workflow is already clear, read that skill before sending the brief playback. Do not only name a skill you have not read.

2. Before executing `$ideate`, `$url-to-code`, or `$image-to-code`, play back the minimum brief and any defaults in one pithy user-visible note.

3. If the target and intended user outcome are clear, continue to the next workflow in the same turn. Do not wait for explicit confirmation. If the user provides feedback, incorporate it and course-correct.

4. Before starting an involved app, prototype, clone, redesign, or build, send one short expectation-setting note and continue. Example:

```text
This kind of build usually takes about 10-15 minutes, and ambitious ones can take longer. Good moment to grab coffee or tend to something else; I’ll keep moving and bring the prototype back when it is ready.
```

Do not send this note for tiny static changes, quick audits, simple research, setup-only, or share-only requests.

Done means the design target and intended user outcome are clear, defaults have been played back, and any already-determined next skill has been read.
