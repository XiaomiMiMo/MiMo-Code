# Product Design Setup

Use this reference when saved user context is missing, when the user asks what Product Design can remember, when the user asks to set up Product Design, or when the user provides product/design references to save.

Before beginning setup, run the persistence availability check in [$user-context](../SKILL.md). If persistent context is unavailable, do not render the onboarding prompt below. Explain that references can be used in the current conversation but cannot be saved for future conversations.

Setup is short. It is not a questionnaire and not a formal onboarding state machine.

## Step 1: Orientation

Render this first. Do not write files, inspect tools, browse URLs, open Figma, create prototypes, generate images, or run audits before this message.

```md
Product Design can remember the product surfaces and design sources you use most, so future work starts from the right place.

Useful things to save:
1. Product URLs
2. Figma files
3. Screenshots or reference images
4. Codebase paths
5. Storybook or component docs
6. Design-system refs
7. Brand and asset sources
8. Preferred tools and share targets

Send any of those now, or say `skip` and I'll work from each task's source.
```

## Step 2: Save Context

When the user provides references, save them to:

```text
$CODEX_HOME/state/plugins/product-design/user-context.md
```

Create the file first if needed:

```bash
python3 scripts/init_user_context.py
```

Use the category structure from `../SKILL.md`.

If the user provides screenshots or reference images, copy them into:

```text
$CODEX_HOME/state/plugins/product-design/assets/
```

Give saved images clear names that say what they show, such as `assets/payment-sheet-mobile-error-state.png` or `assets/account-menu-open-state.png`.

Do not save secrets, API keys, credentials, private tokens, or unsupported claims.

Use this save recap:

```md
Saved Product Design context:
- {Category}: {what was saved}

I'll use this as a starting map for future Product Design work. The source you provide in a task still wins.
```

## Step 3: Read Context

When the user asks what Product Design knows, read `user-context.md` and summarize only saved entries.

If no saved context exists, say that plainly and offer the Step 1 setup prompt.
