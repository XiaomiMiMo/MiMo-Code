---
name: user-context
description: Load or manage Product Design's saved user context. Use when the user asks to set up Product Design, get started, onboard, save product or design sources, see what Product Design remembers, update saved context, or remember Product Design preferences. Examples include product URLs, Figma files, screenshots, reference images, codebase paths, Storybook, tokens, design systems, brand assets, and general product/design notes.
---

# User Context

User Context stores the product and design references a designer uses often, so future Product Design work starts from the right sources.

Use this skill when the user asks to:

- set up Product Design
- get started with Product Design
- onboard with Product Design
- save product or design sources
- see what Product Design remembers
- update saved product or design context
- remember a Product Design preference
- setup my plugin

## Critical Overrides

- Refer to the Plugin router [$index](../index/SKILL.md) before proceeding.
- Follow [$critical-overrides](../../references/critical-overrides.md).
- Before offering onboarding or saving context for future conversations, confirm that local shell access is available, `$CODEX_HOME` can be resolved, and `$CODEX_HOME/state/plugins/product-design/` exists and is writable or can be created in a writable parent directory. If `user-context.md` already exists, confirm that it is writable too.
- If any check cannot be completed or fails, persistent context is unavailable. Do not offer saved-context onboarding or claim that new context was saved for future conversations. If the user asks to save something, explain that it can be used in the current conversation but not saved for future conversations.

## Saved User Context

If `user-context.md` exists, use it by default.

Use saved product URLs, Figma files, screenshots, reference images, codebase paths, Storybook, tokens, design systems, brand assets, component refs, browser preferences, and share targets to ground Product Design work.

Ideation, prototypes, audits, clones, and critiques should match the saved product context unless the user asks for something different.

When a workflow needs visual grounding, attach or include relevant saved screenshots, reference images, tokens, design language, and component references in ImageGen, ideation, prototype, audit, and critique work.

## State File

Saved context lives here:

```text
$CODEX_HOME/state/plugins/product-design/user-context.md
```

Saved screenshots and reference images live next to it:

```text
$CODEX_HOME/state/plugins/product-design/assets/
```

If the file does not exist, continue normally unless the user asks to set up Product Design, save context, or the current task is blocked by missing product/design context.

## Preflight

When any Product Design workflow needs saved context, run:

```bash
python3 scripts/user_context_preflight.py
```

Use the returned saved entries as the starting context for the task.

If the script reports that no saved context exists, continue from the current user prompt unless setup context is required.

Do not browse, open, or inspect every saved reference during preflight. Inspect only the saved references needed for the current task.

## Setup

Use [references/onboarding.md](references/onboarding.md) when the user asks to set up Product Design, asks what Product Design can remember, asks what Product Design knows about their product, or provides product/design references to save.

For setup-only requests, explain what Product Design can remember and ask for useful sources.

Adjust the context-gathering request to match the user's request. First-time setup differs from updating existing context.

Do not inspect the workspace, install dependencies, scaffold a prototype, generate images, run audits, or start implementation during setup.

After the user provides references to save, run:

```bash
python3 scripts/init_user_context.py
```

Then add the references to the created `user-context.md`.

## Save

Save useful, durable Product Design context:

- Product URLs
- Figma files
- Screenshots and reference images
- Codebase paths
- Storybook and component docs
- Design tokens and theme sources
- Brand, logo, icon, illustration, image, and asset sources
- Preferred browser, capture tools, and share targets
- Team conventions that make future Product Design work more accurate

When the user provides screenshots or reference images to save, copy them into `assets/` next to `user-context.md` and link them from the saved entry.

Give each saved image a clear, descriptive filename that says what the image shows. Use names future Product Design runs can understand without opening the file.

Good image names:

```text
assets/chatgpt-settings-modal-dark-mode.png
assets/payment-sheet-mobile-error-state.png
assets/product-dashboard-sidebar-navigation.png
assets/storybook-primary-button-states.png
assets/brand-logo-lockup-purple-gradient.png
assets/onboarding-flow-welcome-step.png
assets/checkout-confirmation-screen.png
assets/account-menu-open-state.png
```

Do not save secrets, credentials, API keys, private tokens, copied customer data, or anything that should not persist.

Use this structure:

```md
# {Category}

- Description: {what this category is and when future Product Design runs should use it}

## Saved Links And Context

{Saved reference or fact}
- Date Added: YYYY-MM-DD.
- File: assets/{clear-descriptive-name}.png
- Useful Context: {what this reference represents}
- Future Use: {how future Product Design work should use it}
```

Include `File:` only when the saved entry has a local image file.

When a category has no saved references yet, use exactly:

```md
status: not provided
```

Keep saved context curated. Prefer a few high-value references over a dump of every possible URL or file.

## Read

- Do not treat `status: not provided` as a fact.
- Read through `scripts/user_context_preflight.py` when local shell access is available.
- Use saved context as default grounding, then inspect only what the current task needs.
