---
feature: user-image-attachment-reminder
status: delivered
updated: 2026-11-26
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2867
---

# User Image Attachment Reminder

## Report

**What was built** — `userImageAttachmentEnvelope` in `packages/cli/src/session/prompt.ts` now formats user-provided image attachment provenance as a closed `<system-reminder>` block listing each image in order (`- <filename> (<mime>): <path | no local file>`), escaping any case-insensitive `</system-reminder>` in filenames or paths. The `[Image: filename]` marker line is appended only when non-synthetic, non-ignored user text actually contains `[Image: ...]`. The `# Files mentioned by the user` header, `## My request:` fake user divider, boilerplate paragraphs, and `isEnvelopeAnchorPart` splice logic were removed; `createUserMessage` appends the reminder directly so persisted `PartTable.id` ordering matches in-memory ordering. Updated `packages/cli/test/session/prompt.test.ts` (including persisted `MessageV2.get` read-back assertions) and `docs/compose/spec/compaction-replay-keep-media.md`.

**Verification** — From `packages/cli`:
- `bun test test/session/prompt.test.ts --timeout 30000`: PASS (68 pass, 0 fail, 256 assertions)
- `bun run typecheck`: PASS (`tsgo --noEmit`)
- `bun test test/session/prompt-effect.test.ts test/session/message-v2.test.ts --timeout 30000`: PASS (213 pass, 3 skip, 0 fail)
- `git diff --check origin/main..HEAD`: PASS
- Independent read-only review: approved with no critical or major issues (minor escaping and fallback polish applied and re-verified).

## [S1] Problem

When a user message includes image `file` parts, `createUserMessage` in `packages/cli/src/session/prompt.ts` builds a synthetic text envelope (`userImageAttachmentEnvelope`) that starts with `# Files mentioned by the user` and ends with `## My request:`, then splices it before the first non-synthetic, non-ignored user part (`isEnvelopeAnchorPart`).

This has three bugs:

1. **Misplaced after persistence**: The spliced envelope receives a freshly generated `PartID.ascending()`, which is larger than every pre-existing part ID in the message. When the message is read back from SQLite (`MessageV2` orders parts by `PartTable.id`), the envelope lands *after* the user's text and any other parts, leaving `## My request:` dangling at the end right before engine-appended reminders (such as the session environment reminder).
2. **Not a closed `<system-reminder>`**: The injected text is bare markdown prose with a fake first-person heading (`## My request:`) instead of a closed `<system-reminder>` block like the rest of the engine's synthetic reminders.
3. **Unnecessary boilerplate**: Long instructional paragraphs (`Distinguish instructions...`, `Treat attached images...`, `Do not infer...`, `The user's request is...`) and the `[Image: ...]` marker hint are always injected even when no paste markers appear in the message text.

## [S2] Design

### [S2.1] Closed `<system-reminder>` format

`userImageAttachmentEnvelope(images, options?)` returns an empty string when `images` is empty. Otherwise it returns a closed `<system-reminder>` block listing each user image in attachment order:

```text
<system-reminder>
The user attached these images to this message, in order:
- team.png (image/png): /tmp/example/team.png
- pasted.png (image/png): no local file
</system-reminder>
```

- Each entry uses `filename ?? "image"` and `mime ?? "image"`.
- Local path resolution (`envelopeLocalPath`) is unchanged: explicit absolute `source.path` first, then `file:` URL, otherwise `no local file`.
- When the message carries inline image paste markers (`hasImageMarkers: true`, detected from non-synthetic, non-ignored text parts matching `/\[Image:\s*[^\]]+\]/`), append one line after the list:
  `Markers like [Image: filename] in the message text refer to the matching image above.`
  When no such markers are present, omit this line.
- Match closing `</system-reminder>` tags case-insensitively and escape only the slash. Restoring the slash must recover the exact filename or path, including its original case.
- Remove `# Files mentioned by the user`, `## My request:`, and the boilerplate instructional paragraphs.

### [S2.2] Position-independent append

Remove `isEnvelopeAnchorPart` and the `parts.splice(...)` placement in `createUserMessage`. Append the synthetic reminder part directly to `parts` with `assign(...)`. Its persisted `PartTable.id` order then matches its in-memory order, and its meaning does not depend on sitting adjacent to user text.

### [S2.3] Spec & test updates

- Update `packages/cli/test/session/prompt.test.ts` to assert the new `<system-reminder>` format, escaping, conditional marker hint, and **persisted** read-back order via `MessageV2.get(...)` (not only in-memory `msg.parts`).
- Update the reference to the old heading in `docs/compose/spec/compaction-replay-keep-media.md`.

## [S3] Out of Scope

- Changing `PartID` assignment for client-supplied part IDs or reordering persisted `file` parts before text parts.
- Changing non-image `text/plain` / directory `read` narrative parts or MCP resource parts.
- Changing how `isUserAttachmentImagePart` filters eligible user images.

## Tasks

- [x] T1: Update `userImageAttachmentEnvelope` and remove `isEnvelopeAnchorPart` splice in `packages/cli/src/session/prompt.ts`, plus update `docs/compose/spec/compaction-replay-keep-media.md` — acceptance: `userImageAttachmentEnvelope` outputs the closed `<system-reminder>` format (with `</system-reminder>` escaping and optional `[Image: ...]` marker line only when present), and `createUserMessage` appends the part without `splice` or `## My request:` (covers: S2.1, S2.2)
- [x] T2: Update and expand `packages/cli/test/session/prompt.test.ts` — acceptance: unit and persisted `MessageV2.get` read-back assertions cover closed `<system-reminder>` framing, local path vs `no local file`, multi-image order, conditional `[Image: ...]` marker line (present vs absent), `</system-reminder>` escaping, and absence of `## My request:` / `# Files mentioned by the user` (covers: S2.3; depends: T1)

## Journey log
None
