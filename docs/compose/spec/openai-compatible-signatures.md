---
feature: openai-compatible-signatures
status: in-progress
updated: 2026-11-27
source: feat/openai-compatible-signatures
---

# Replay signed state on OpenAI-compatible tool turns

## Report

[Not finalized yet]

## [S1] Problem

A gateway can accept the first Chat Completions request but reject the next one after a tool runs: the client sends a valid tool result without the state the gateway returned with the preceding assistant reply. The two protocols fixed in mimo-harness (`78f74cb99`, `202798552`) put that state in different places. Neither requires a native provider or a new user setting.

MiMoCode already persists tool-call metadata and suppresses it when replaying a different model. Its pinned OpenAI-compatible SDK reads Gemini signatures into the adapter's provider namespace, but its request serializer reads `google.thoughtSignature`. The default adapter also has no extraction/persistence path for message-level `reasoning_opaque`. The dedicated Copilot adapter is not the default and is not a replacement for it.

## [S2] Design

### S2.1 Keep the default adapter; capture only the returned message state

On the bundled `@ai-sdk/openai-compatible` Chat Completions route, use the SDK's metadata extractor on raw responses. For SSE, use only `choices[0].delta.reasoning_opaque`, keeping the last nonempty string of the current response. For a non-streamed chat response, use `choices[0].message.reasoning_opaque` when present. Preserve the string exactly; ignore absent, empty, null or non-string values. Do not synthesize reasoning text, buffer the stream, or forward unrelated extension fields. A completed tool-only reply is eligible even when `content` is null. No model-name or hostname detection.

### S2.2 Replay the state on the originating assistant message

Retain just that opaque value as optional `reasoningOpaque` on the existing persisted step-finish part. One stored assistant can contain several steps: each step-start opens a new assistant block, and its finish metadata belongs only to that block. This also lets trimming a discarded step discard its state. There is no process-local map or tool argument. When projecting retained history for the same configured provider ID **and** model ID on the compatible route, give the SDK `openaiCompatible.reasoning_opaque` on the corresponding assistant **message**, alongside (not inside) its `tool_calls`. Do not send the value on tool results, user messages, adjacent assistant steps, or to another provider/model. History without the field is valid and does not gain one. Ordinary readable reasoning and interleaved field handling remain independent. A running fork has a frozen prefix already projected for its capture origin: a different destination receives a copy without either signature; switching back still uses the original prefix.

### S2.3 Replay a Gemini signature on exactly its own tool call

Reuse the SDK's existing parser, tool index handling, and wire serializer. At capture, move the nonempty string `thoughtSignature` from the producing SDK's namespace to a stable private key on that call before tool bookkeeping. Only on same-origin compatible replay, populate `google.thoughtSignature` on that retained call. Changing the SDK display/namespace option alone is not a change of configured provider or model. Existing calls still in recognizable SDK namespaces remain readable; missing or previously discarded signatures are not guessed. Preserve unrelated options; replay no extra fields just because they arrived in the same metadata object. The only new wire field for this purpose is `tool_calls[j].extra_content.google.thought_signature`. Preserve whitespace; do not invent signatures for old or unsigned calls or move them when results complete out of order. This value and the message-level opaque can occur together.

### S2.4 Verify the actual next request

Use a local Chat Completions fixture and the installed SDK, with a custom provider ID and neutral model name. Exercise session recording and reconstruction and inspect the serialized *next* request, not just SDK events. Cover tool-only replies, last valid opaque, serial calls with distinct signatures, parallel same-name calls with only one signature, and combined fields. Verify tool-result IDs still pair, and no state crosses a change of either provider or model. Include a plain unsigned exchange and ordinary `reasoning_content` as controls. No live account or external inference endpoint is required.

## [S3] Out of Scope

Changing provider routing, switching to the Copilot fork or native Gemini API, altering Responses or native adapters, arbitrary vendor-field passthrough, and adding request-time thinking controls. The reference fixes do not add Copilot's separate readable `reasoning_text` dialect or signatures on non-tool Gemini content. Historical state that was never saved cannot be recovered.

## Tasks

- [ ] T1: Capture and persist message-level opaque state — acceptance: a tool-only stream retains the last valid value without creating visible reasoning; JSON chat selects the corresponding message field (covers: S2.1).
- [ ] T2: Project opaque state back onto its assistant message — acceptance: the next same-origin HTTP request after history reconstruction contains the exact original value once, and no other message or origin gets it (covers: S2.2, S2.4; depends: T1).
- [ ] T3: Bridge tool-signature namespaces — acceptance: serial and parallel calls replay only their own exact signatures, including alongside a message opaque; unsigned history and other origins send neither spurious fields nor broken tool-result IDs (covers: S2.3, S2.4).

## Journey log

- Ordinary session restoration and a running fork use different histories: the latter reuses a prefix already projected for its capture model. Rechecking the fork's capture origin before sending prevents both signatures crossing a model switch without mutating the saved prefix.
- The compatible SDK's configurable name is not the configured provider ID. Capture tool signatures before a namespace rename or a collision with the internal `providerExecuted` flag can detach a signature from its call.
