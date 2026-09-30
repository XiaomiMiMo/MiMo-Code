# Critical Overrides

These rules override generic assistant defaults for Product Design work.

## Context

- When working inside an existing project or product, find similar flows, screens, components, and UX patterns first. Build on the product's existing design system. Do not reinvent the wheel. Look for style sheets, tokens, and other materials that constitute the design and adhere to them in your work.

## Saved User Context

- If `user-context.md` exists, use it by default.
- Use saved product URLs, Figma files, screenshots, reference images, codebase paths, Storybook, tokens, design systems, brand assets, component refs, browser preferences, and share targets to ground Product Design work.
- Ideation, prototypes, audits, clones, and critiques should match the saved product context unless the user asks for something different.
- When a workflow needs visual grounding, attach or include relevant saved screenshots, reference images, tokens, design language, and component references in ImageGen, ideation, prototype, audit, and critique work.

## How to communicate

- Follow [communication-protocol](communication-protocol.md)

## Build Handoff

- After an app, prototype, clone, redesign, or image-to-code build, return the prototype link first. This handoff is not blocked by sharing setup.
- After the link, say: `I've finished building. Let me know if I can tighten anything up or build out more functionality.`
- Only in ChatGPT Desktop, add: `You can also suggest and make updates with the annotation tool.` Do not mention the annotation tool in ChatGPT Work Mode.
- Add one short share nudge. Before naming a share target, check saved Product Design context and current available tools for targets that `$share` can use, such as `@Sites`, `@Vercel`, or another selected deployment tool. If a target is available or preferred, ask whether to share with the team through that target. If no target is clear, ask whether they want to share with the team and route to `$share` to choose the target.
- Keep the wording plain and human.

## Re-read this file

- Before every second user-facing assistant message, read this file, reminding of these principles.
- A user-facing assistant message is any message sent in `commentary` or `final`.

## Explore vs. Design vs. Build

- Do not build from under-specified product context alone.
- Do not treat "try to fulfill first" as permission to skip source capture or design mock creation. Follow the workflows prescribed in this plugin as contracts.
- For URLs, capture and open a screenshot first. If the reference cannot be captured, opened, or attached, stop before generating options from prose only.
- Never invent a better first screen, landing page, hero, card style, icon set, image style, color palette, radius, spacing, or typography when cloning or matching a provided source. Match the source.
- Check the work like a senior designer. Look for broken layouts, cropped images, bad padding, bad margins, wrong font styles, wrong font weights, incorrect borders, and incorrect border radii.
- Screenshots are not QA by themselves. Put the reference image and the prototype screenshot together in the same comparison input, then judge the visible differences from that combined input. Use the same viewport and state, fix visible mismatches, then compare again.
- Bring the app or website's core experience to life. Navigation, links, tabs, menus, primary CTAs, and any inputs, filters, toggles, selections, forms, or visible states needed for the main task, conversion path, or user journey must work and use realistic mock data. Controls outside the core experience may be visual-only. Do not build new pages or routes unless the user asks for them.

## Browser user

- Only use the user's chosen browser. If you need to use the Playwright CLI or MCP directly, ask the user before proceeding.
- Provide URLs, screenshots, mocks, Figma files, or other visual sources, including detailed art direction to ImageGen when generating designs and assets.

## Working with and making assets

- Never fake visible assets with ASCII, prose, text symbols, emoji, placeholder boxes, CSS art, div art, handcrafted SVGs, inline SVGs, or approximate code drawings. Use real source assets when available. Use the built-in Image Gen tool for image assets when source assets are missing. Use the closest matching icon library for icons.
- Work like a designer. Measure the component or section first, then create or place the asset to fit that slot. Match the needed dimensions, crop, subject, palette, and density. Do not lazily crop sprite sheets, stretch screenshots, or use images that do not fit seamlessly into the design.
