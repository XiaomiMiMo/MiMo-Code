---
feature: compaction-replay-keep-media
status: delivered
updated: 2026-10-14
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2662
---

# Compaction Replay Keeps Media

## Report

**What was built** — After provider-overflow compaction, the replayed last user message now copies every non-`compaction` part verbatim, including media `file` parts. The replayed image keeps its `mime`, `filename`, `url` (data URL) and `source`, so the client can render and preview it and the next model turn sends the image to the provider as `image_url` content. The summarization request still strips media under overflow. Durable attachment identity in the provenance envelope is the attachment's own file name and local path (from `source.path`, or from a `file:` URL when `source.path` is absent); `[Image: <file name>]` / `[PDF: <file name>]` markers in the message text carry that same file name, so the marker text itself is session-stable identity across compaction, handoff, and restarts.

**Verification** — From `packages/cli`: `bun test test/session/prompt-effect.test.ts test/session/message-v2.test.ts --timeout 30000` passed (173 pass, 3 skip, 0 fail); `bun test test/session/prompt-effect.test.ts --timeout 30000 -t "keeps replayed media"` passed (17 assertions); `bun run typecheck` and `git diff --check` passed. The regression test drives the follow-up turn with an image-capable test model and asserts the HTTP request contains the real PNG as `image_url` and no `[Attached image/png` text; with the old placeholder substitution restored, the placeholder, `source` and wire-image assertions fail. Client end-to-end: a client build pinned to this branch ran `mimo-dev/mimo-v2.6-flash` through a local proxy that answered the first image-bearing request with a standard context-length error; the engine ran overflow compaction, the replayed message kept the same image `file` part (same data URL and `source.path`), the client rendered its thumbnail, the follow-up request carried the image, and the model described the image content. Independent review found no critical or major issues.

**Journey log**

- Overflow replay only fires when earlier user content remains after the replayed message is removed from the summarization input; a single-message session skips replay, so the test needs an earlier user message.
- Asserting on raw `sessions.messages` cannot detect replay regressions because it still contains the pre-boundary original.
- Images on send go through `prepareImage`; test fixtures must be decodable PNG/JPEG bytes, and the test model must declare image input or `ProviderTransform` replaces the image before the wire.
- A small context window (`compaction.max_context` or `MIMOCODE_COMPACTION_TRIGGER_RATIO`) only triggers threshold compaction, which never replays; reproducing replay requires the provider to reject the request as a context overflow.
- Provider requests can contain the literal `image_url` inside a tool description; detect real images on the wire with `"image_url":{"url":"data:image/`.
- Attachment identity that must survive compaction is the file name and local path already listed in the provenance envelope (the path is `source.path`, or the `file:` URL when `source.path` is absent). Paste markers (`[Image: <file name>]` / `[PDF: <file name>]`) carry the attachment's own file name, so the marker text itself is a durable key across compaction, handoff, or restarts; the envelope lists `- filename (mime)` plus path and tells the model to match a marker by that name.
- Clipboard pastes without a disk spill used to share the part name `clipboard`, so two pasted images collided in the envelope. Paste-time unique names (`mimo-paste-…`) give each attachment a distinct file name even when no local path exists.

## [S1] Problem

When the provider rejects a request as a context overflow, `SessionCompaction.process` runs with `overflow: true`. It takes the last real user message out of the compaction input, summarizes the earlier history, and then replays that user message as a new persisted user message after the summary so the model can answer it.

While copying the parts of the replayed message, the engine replaces every media `file` part (`MessageV2.isMedia`: images, PDF) with a text part `[Attached <mime>: <filename>]`. The replacement is written to the database. The original image content — a `data:` URL in `url`, plus `source.path` pointing at the local attachment file — is no longer referenced by the replayed message. As a result:

- The client renders the replayed message with the placeholder text instead of an image thumbnail, and the image cannot be previewed.
- The model never sees the image again, while the copied provenance envelope (`# Files mentioned by the user …`) still tells it to look at the attached image.

## [S2] Design

### [S2.1] Replay copies media parts verbatim

When replaying the user message after overflow compaction, every part except `compaction` is copied as-is, including media `file` parts. A copied `file` part keeps `mime`, `filename`, `url` and `source` unchanged; only `id`, `messageID` and `sessionID` are reassigned, exactly like every other replayed part. The `[Attached <mime>: <filename>]` substitution in the replay path is removed.

### [S2.2] Replayed media reaches the model

The replayed message is an ordinary user message after the compaction boundary. On the next turn its media `file` parts are converted to model `file` content by the normal `MessageV2.toModelMessages` path (no `stripMedia`), so the model receives the image.

### [S2.3] Unchanged behavior

- The summarization request itself keeps `stripMedia: true` under overflow: historical media is still dropped from the summary input.
- If the replayed message's media alone makes the next request overflow again, the existing overflow handling applies; this change adds no new retry or fallback path.

## [S3] Out of Scope

- Client rendering changes; message renderers already render persisted image `file` parts.
- The non-replay continue message and its overflow wording.
- Repairing messages already persisted with the placeholder text.

## Tasks

- [x] T1: Copy media `file` parts verbatim in the overflow replay — acceptance: after provider-overflow compaction with a replayed user message containing an `image/png` `file` part, the persisted replayed message contains a `file` part with the same `mime`, `filename`, `url` and `source` as the original, and contains no `[Attached image/png: …]` text part (covers: S2.1)
- [x] T2: Regression test for replayed media sent to the model — acceptance: in the provider-overflow compaction test, the summarization request does not contain the image data while the follow-up model request built from the replayed message contains the image data; the existing assertion on `[Attached image/png: large.png]` is replaced accordingly (covers: S2.2, S2.3; depends: T1)
