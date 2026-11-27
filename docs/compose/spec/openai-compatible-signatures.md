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
A compatible gateway can return a tool call that runs successfully, then reject the next request because the client omitted state attached to the preceding assistant reply. The two formats corrected in mimo-harness (`78f74cb99`, `202798552`) use different positions in the Chat Completions payload.

## [S2] Design

### S2.1 Capture message-level opaque state
The bundled OpenAI-compatible adapter extracts `choices[0].message.reasoning_opaque` for JSON or the last nonempty string at `choices[0].delta.reasoning_opaque` for SSE. Keep the string unchanged, ignore absent or invalid values, and never turn it into visible reasoning. A tool-only response with null content is eligible.

### S2.2 Replay the state on the originating assistant message
Persist the value on the completed step's optional `reasoningOpaque` field. During normal conversation with the same model, project it to `messages[i].reasoning_opaque`. A stored assistant may contain several steps: only the corresponding assistant block gets the value, not adjacent steps, tool calls, or tool results. Use the existing history metadata rules.

### S2.3 Replay each tool call's Gemini signature
The pinned SDK extracts `extra_content.google.thought_signature` into a namespace named after its configured provider, but reads `google.thoughtSignature` when serializing. Normalize the metadata on the SDK tool-call event before recording it. Use the existing tool-call history path. Never copy a signature between calls or manufacture one for unsigned history.

### S2.4 Verify the next request
Use the installed SDK and a local HTTP endpoint, with a custom provider using the default adapter. Check serial calls with distinct signatures, parallel same-name calls with one signed call, and an assistant carrying both kinds of state. The actual next request must preserve each field in the right place, preserve tool-result IDs and ordinary readable reasoning, and omit absent fields.

## [S3] Out of Scope
No support guarantees for changing providers, models, SDK names or adapters mid-conversation. Stripped signatures or service rejection in that case are expected. No special handling for forks, checkpoints or native providers; no new settings, authentication, arbitrary field passthrough or support for Copilot's readable `reasoning_text` dialect.

## Tasks
- [ ] T1: Capture opaque state — acceptance: JSON and tool-only SSE preserve the exact valid string, not invalid values or visible text (covers: S2.1).
- [ ] T2: Replay opaque state on the originating assistant message — acceptance: a multi-step history preserves the unsigned gap and each signed message's own value (covers: S2.2).
- [ ] T3: Replay each signed tool call — acceptance: the next request after tool execution preserves signatures, result IDs and the independent message-level state (covers: S2.3, S2.4).

## Journey log
- Scope was narrowed back to continuous use of the same provider. Provider switching and frozen-prefix handling are not delivery criteria.
