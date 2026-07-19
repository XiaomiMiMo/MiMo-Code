---
name: share
description: "Share a runnable prototype using the user's preferred deployment tool."
---

# Share

Deploy the user's runnable prototype so they can share it with others.

## Critical Overrides

- Refer to the Plugin router [$index](../index/SKILL.md) before proceeding.
- Follow [$critical-overrides](../../references/critical-overrides.md).

## User Context

Before starting, load [$user-context](../user-context/SKILL.md) and run its preflight script when local shell access is available.

Use saved product URLs, Figma files, screenshots, reference images, codebase paths, Storybook, tokens, design systems, brand assets, component refs, browser preferences, and share targets as grounding material when relevant.

Do not inspect every saved reference. Inspect only what the current task needs.

## Workflow

1. Confirm the prototype directory and the user's preferred deployment target.
2. If the user invokes Product Design with @Sites, @Vercel, or another deployment tool, treat that as the selected hosting target.
3. If the user did not choose a target, ask one question:

> Where should I deploy this: @Sites, @Vercel, or another target?

4. Use the selected deployment tool when it is available.
5. If the selected tool is not available, say that clearly and ask whether to use another target.
6. Run the deployment when possible. Do not give setup instructions if you can complete the deployment directly.
7. Return the shareable URL.
8. State any misses or manual follow-up the user still needs to do.

## Rules

- Do not deploy before the user chooses or confirms the target.
- Do not claim the prototype is shared until you have a working URL.
- If the selected tool is not available, say that clearly and ask whether to use another target.
