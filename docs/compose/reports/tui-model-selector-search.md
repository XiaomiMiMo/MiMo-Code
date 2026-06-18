---
feature: tui-model-selector-search
status: delivered
pr: https://github.com/XiaomiMiMo/MiMo-Code/pull/932
branch: fix/model-selector-search-ui
commits: 83ca130..ee30bc0
---

# TUI Model Selector Search — Final Report

## What Was Built

Restored the search input box in the TUI model selector dialog (`/models` command). The search box was hidden due to `skipFilter={true}` being set on the `DialogSelect` component, which suppresses the built-in filter input. Removing this prop re-enables the search UI while preserving the existing custom fuzzysort filtering logic via `onFilter`.

## Architecture

The model selector consists of two layers:

- **`DialogModel`** (`packages/opencode/src/cli/cmd/tui/component/dialog-model.tsx`) — builds the options list (favorites, recents, provider models, "+ Add model" entries) and performs custom fuzzysort filtering via a `query` signal.
- **`DialogSelect`** (`packages/opencode/src/cli/cmd/tui/ui/dialog-select.tsx`) — generic selection dialog with built-in search input, keyboard navigation, and scroll. Renders the input when `skipFilter` is not set.

Data flow:
```
User types → DialogSelect <input onInput> → props.onFilter(query)
  → DialogModel setQuery() → options() recomputes with fuzzysort
  → DialogSelect receives new props.options → re-renders filtered list
```

### Design Decisions

- **Custom filtering in DialogModel, not DialogSelect**: DialogModel uses `skipFilter` semantics — it passes pre-filtered `options` to DialogSelect rather than letting DialogSelect do the filtering. This allows model-specific logic (favorites/recents sections disappear on search, fuzzysort with weighted title/category scoring).
- **"+ Add model" entries are searchable**: Each `source === "config"` provider appends a "+ Add model" option. Searching "add" surfaces all of them — this is intentional so users can identify which provider to add to. Normal model searches are unaffected by fuzzysort scoring.

## Usage

Press `/models` in TUI or trigger via keybind. The search input auto-focuses. Type to filter models by name or provider. Press Enter to select, Escape to close.

## Verification

- `bun typecheck` passes (full turbo, 12/12 packages)
- CI: typecheck ✅, lint ✅, 8 test failures are all pre-existing (documented in #911)
- Manual: search box renders and filters correctly in `/models` dialog

## Journey Log

- [lesson] `skipFilter={true}` hides the search input entirely in `DialogSelect` — this prop should only be used when search is genuinely unwanted (e.g. short fixed-option lists like worktree creation)
- [lesson] When a component does its own filtering via `onFilter` callback, it still needs the input rendered — `skipFilter` controls UI visibility, not filtering logic
