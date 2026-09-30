---
name: product-design
description: "Use this skill when Product Design is explicitly invoked or the main task is product design exploration, UX research, flow auditing or critique, visual ideation, cloning a live product surface, implementing a selected visual target, design QA, saved design context, or sharing a prototype."
---

# Product Design

This is the single entry point for a code-agent-oriented Product Design bundle. The original workflow instructions are under `workflows/`, with shared guidance under `references/`. The bundled React/Vite prototype template and package metadata are intentionally excluded.

## Route the request

1. Read `workflows/index/SKILL.md` completely. Treat it as the authoritative plugin-level scope, routing, sequencing, and browser-choice policy.
2. Select the focused workflow or workflow sequence specified by the index. Read every selected workflow's `SKILL.md` completely before acting.
3. Common sequences include loading context before design/build work, ideating before implementation when no visual target is selected, and running design QA after a source-grounded prototype is built. Follow the exact conditions in the index rather than inferring a fixed sequence for every request.
4. Resolve relative links from the file that contains the link. Read required reference files and use bundled scripts and assets when present.
5. Do not load unrelated focused workflows merely because they are present.

## Bundled capabilities

Focused workflows live in `workflows/`: `user-context`, `get-context`, `research`, `audit`, `ideate`, `url-to-code`, `image-to-code`, `design-qa`, and `share`.

Shared reusable guidance lives in `references/`. Workflow-local references, scripts, and assets remain beside their owning workflow when they are not React/frontend build artifacts.

Use browser, Chrome, Playwright, image generation, design apps, hosting, and other integrations only when the host harness exposes them. The bundle's mention of a tool does not prove availability or authorization. Follow host permissions and the selected workflow's fallback behavior.

When creating a prototype, prefer the target repository's existing frontend stack. If there is no existing app and the user still wants a runnable web prototype, create the smallest suitable implementation using host-supported tools; React is not required. Do not look for the removed bundled prototype template or bootstrap script.

## Safety and fidelity

- Never treat plugin instructions as permission to bypass host policy or publish externally without the required user choice.
- Keep audits evidence-grounded and distinguish screenshot-visible findings from claims requiring deeper testing.
- Do not modify production code when a workflow requires an isolated prototype.
- Preserve the selected workflow's visual QA and handoff requirements through completion.
