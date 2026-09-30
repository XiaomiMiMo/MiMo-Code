---
name: index
description: "Use when Product Design is explicitly invoked, or when the user's main goal is to explore a design, research UX, audit or critique a flow, faithfully clone a visual source, check a built design, or share a prototype. Do not use Product Design for ordinary implementation unless the user explicitly asks for it."
---

# Skill Purpose

Route Product Design requests to the right Product Design skill. Use this plugin for an `@Product Design` mention, a direct Product Design request, or a request mainly about design exploration, faithful source cloning, audits, research, critique, or sharing. A request is not Product Design just because it mentions UI, a prototype, or visual style.

# Plugin Purpose

The Product Design plugin helps designers and other non-coders close the gap between product ideas and working software.

The Product Design plugin equips you with the following set of skills to:

- Research ideas and pain points related to your product.
- Conduct product-flow audits.
- Generate distinctly new ideas for your product with ImageGen.
- Clone existing product apps into lightweight prototypes.
- Build lightweight or interactive prototypes to share with your team.

## Communication Style

Speak to the user in a warm, fun, and collaborative way, prioritizing pithy explanations over long walls of text and numerous bullet points. Refer to the [communication-protocol](../../references/communication-protocol.md) for relaying Product Design plugin progress updates and handoff.

## Critical Overrides

- Follow [$critical-overrides](../../references/critical-overrides.md).

## Router Only

This index chooses the next Product Design skill. It does not do that skill's work.

If the user names a focused skill, read that exact skill first. Do not replace it with a related skill.

When a request matches `$user-context`, `$get-context`, `$research`, `$ideate`, `$image-to-code`, `$url-to-code`, `$audit`, `$design-qa`, or `$share`, load the focused skill and follow it.

For requests to audit, review, critique, inspect, assess, analyze, evaluate, or give feedback on an existing product experience, load `$audit` directly; do not load `$get-context` first. If the same request also asks to build, fix, redesign, or implement afterward, run `$audit` first, then continue through the appropriate normal workflow.

For visual ideation, `$ideate` is the focused workflow. Use `$get-context` to resolve the minimum brief and play back any defaults before `$ideate` starts.

For clone or recreation of a live URL, load `$url-to-code` directly.

For a redesign, improvement, or new site based on a URL, use `$get-context` to confirm the redesign brief. `Like <URL>` means redesign, not clone. Capture the current site with screenshots, attach those screenshots to the `$ideate` Image Gen calls, then execute `$ideate`.

## Standard Chat Mode

If Product Design is invoked in standard ChatGPT chat without Work Mode tools, do not start the workflow. Tell the user once:

```text
Chat isn't supported by the Product Design plugin. Please switch to the Work tab and paste this prompt in for the full experience.
```

Do not ask design-brief questions, generate options, or begin build work until the user moves to Work Mode.

## Browser Choice

In ChatGPT Work Mode, always use the cloud browser available to that chat. If it is not initially visible, load the Browser skill and follow its setup instructions before concluding it is unavailable.

In Codex Desktop, use `@Browser` and explicitly select the in-app surface with `agent.browsers.get("iab")`.

In Codex Desktop, use Chrome only when the user asks for it, the task needs an existing Chrome tab/login/profile/extension, or the in-app Browser is unavailable or blocked.

If ChatGPT Work Mode does not expose both the cloud browser and `@Sites` after preflight, tell the user once:

```text
Cloud browser and Sites are not available in this chat. I can still build a single-page HTML prototype, but I cannot visually verify it or publish a live checkpoint, so fidelity and interaction polish may be lower. Continue with that fallback?
```

Only proceed after the user agrees. Do not claim the fallback is verified, open, hosted, or ready to share. This fallback applies to image-to-code and new prototypes. It does not apply to URL-to-code when browser capture is required.

## No Visual Target, No Build

For new app, prototype, redesign, or UI build requests without a URL, screenshot, Figma frame, mockup, source image, or existing code target:

- `$ideate` is the focused workflow.
- Use `$get-context` to resolve the minimum brief.
- Once the target and intended user outcome are clear, play back the assumptions and run `$ideate` in the same turn.
- Show exactly three visual options and wait for the user to choose one.
- Do not scaffold, edit files, or start a server before a visual option is selected.

`Full working version`, `no refs`, `go for it`, `make an assumption`, or a complete brief do not waive this.

## User Context

Use [$user-context](../user-context/SKILL.md) when the user asks to:

- Set up Product Design
- Get started with Product Design
- Onboard with Product Design
- Save product or design sources
- See what Product Design remembers
- Update saved product or design context
- Remember a Product Design preference
- Setup my plugin

Adjust the context-gathering request to match the user's request. First-time setup differs from updating existing context.

For setup-only requests, do not inspect the workspace, install dependencies, scaffold a prototype, generate images, run audits, or start implementation.

When answering "what can you do?", "how do I get started?", or similar broad Product Design questions, load `$user-context` and follow its persistence availability check before offering saved-context onboarding.

Before routing to Product Design workflows, load [$user-context](../user-context/SKILL.md) and run its preflight script when local shell access is available.

## Browser Annotation Updates

Treat annotations as scoped edits to the current prototype.

Read the annotation, its target, and the surrounding screen before changing code. Preserve the existing prototype by default: layout, style, content, routes, assets, interactions, and working behavior stay the same unless the annotation asks to change them.

Do not redesign nearby UI or rebuild the prototype just because an annotation touches that area. If the annotation is ambiguous and the choice would materially change the prototype, ask first.

## Skills

Use this as the root routing guidance for Product Design plugin work. If several focused skills apply, sequence them in the order that creates the most useful design workflow. Keep this index as a router; do not perform focused workflow logic here.

### $user-context

Preflight, save, or answer from Product Design setup context. Route here before Product Design workflows to load saved product and design sources, and for direct setup, get-started, onboarding, save, remember, recall, inspect, or customization requests. This skill owns Product Design plugin-scoped context and preference policy.

### $get-context

Route here first for design, build, prototype, redesign, extend, or UI exploration work. Require only a clear design target and intended user outcome. Ask one targeted question only when one of those is missing; otherwise play back the brief and defaults, then continue without waiting for approval.

### $research

Run fast, source-grounded UX research on current user problems for a named digital product. Route here for researching user pain, UX friction, onboarding issues, docs/help problems, developer experience friction, support pain, product workflow issues, or current user complaints.

### $audit

Capture and review a product flow, journey, screen, or multi-step product experience from screenshots. Route here for user-facing audit, review, critique, inspect, assess, analyze, evaluate, or feedback requests. It reports UX, design, and accessibility findings tied to captured evidence; do not use `design-qa` for user-facing audits.

### $ideate

Generate image-based visual alternatives, remixes, or concept directions for a component, screen, feature, workflow, or product idea. Route here after `get-context` has played back the minimum brief and the user needs visual exploration, design variants, alternatives to an existing design, or idea discovery before choosing a visual target. Prefer this over prose-only ideation unless the user asks for prose.

### $url-to-code

Clone a live URL as a runnable frontend-only local app using the Browser Choice rule above. Load this alongside `get-context` when the user provides a production URL for a faithful local prototype or clone, but do not execute it until the minimum brief has been played back. It should not modify production code; stay in `get-context` when source selection is still unclear.

### $image-to-code

Implement a selected visual target as a faithful, responsive, interactive frontend. Route here after `get-context` has played back the minimum brief and the user has chosen an ImageGen mock, screenshot, Figma frame, mockup, reference image, or other visual source. Do not start here when no visual target has been selected; use `get-context` and `ideate` first.

### $share

Deploy a runnable prototype and return a shareable URL using the user's preferred target when available. Route here when the user asks to share, deploy, publish, host, create a link, or make a prototype shareable with `@Sites`, `@Vercel`, or another deployment tool.

### $design-qa

Compare a coded Product Design prototype against its source visual target before handoff. Route here only as an internal helper after a prototype, URL-to-code build, or image-to-code build has both a source visual and rendered implementation. Do not route broad UX critiques, audits, or product-flow reviews here; use `audit` instead.
