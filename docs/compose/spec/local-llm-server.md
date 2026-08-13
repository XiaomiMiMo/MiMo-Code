---
feature: local-llm-server
status: in-progress
updated: 2026-08-13
branch: feat/llm-server
commits: 42dcbf34f..HEAD
---

# Temporary local LLM server (`mimo llm-server`)

## Report

## [S1] Problem

A skill (or any subprocess) that needs "a model" has no way to borrow the models
MiMoCode is already configured for. Today the options are:

1. the user hand-configures a provider key into the skill, or
2. the user asks MiMoCode to read a provider api key and write it into skill
   config — which drags the secret through the agent's context, into the
   transcript, and into a file the skill can read.

Option 2 leaks the credential. Option 1 duplicates it per skill. Both break when
the credential rotates.

Two further constraints make "just export the key" unworkable in general:

- **Some providers have no static key to export.** MiMoCode stores `oauth`-typed
  credentials (`provider.ts:687` `if (auth?.type === "oauth") return auth.access`)
  whose value is a short-lived access token MiMoCode itself refreshes. Handing
  that to an external process yields a credential that dies on expiry.
- **Provider compatibility knowledge lives in MiMoCode.** `ProviderTransform` and
  the `chat.params`/`chat.headers` plugin hooks encode per-provider quirks. An
  external proxy given a raw key does not get any of it.

## [S2] Design

A separate, loopback-only, OpenAI-compatible HTTP server in front of the models
the running instance is already configured for. A caller receives a `base_url`
and a process-scoped bearer token; the real credential never leaves
`Provider.Service`.

### [S2.1] Capability boundary

A SEPARATE Hono app and listener in `src/llm-server/`, never a route added to
`server/server.ts`. That server composes control-plane, instance, and UI routes,
so any token accepted there would reach filesystem, session, config, and
auth-management APIs. A task-scoped model credential must not be an
all-of-MiMoCode credential.

Routes, and nothing else:

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/audio/speech`

The instance is pinned to the startup directory. Unlike the control server's
`InstanceMiddleware` there is no `?directory=` override: a task token must not be
able to repoint the server at another project's provider config.

### [S2.2] Credential and isolation model

- Token is 256 bits from `crypto.getRandomValues`, base64url, held only in
  memory. Killing the process is the revocation mechanism.
- One server per task is the isolation boundary; two servers cannot replay each
  other's token.
- Accepted as `Authorization: Bearer <token>` or as `x-api-key: <token>`. The
  `x-api-key` form carries the RAW token with no `Bearer ` prefix, matching the
  convention of clients that send that header.
- Comparison via `timingSafeEqual` behind a length pre-check, because
  `timingSafeEqual` throws on length mismatch. Token length is not secret.
- Loopback-only with no override flag. A reachable port would proxy paid model
  access to whoever found it.
- Port: pre-resolve a free ephemeral port and pass it explicitly. The shared
  adapter treats `port: 0` as "try 4096, then random", and 4096 is the CONTROL
  server's default — landing there silently is the worst available outcome.

### [S2.3] Model reference and allowlist

Models are addressed as `provider/model`. `Provider.parseModel` splits on the
FIRST `/` only, so `openrouter/anthropic/claude-x` parses correctly.

`--model provider/model` is repeatable and forms an allowlist. It is enforced in
BOTH `/v1/models` and model resolution, so the listing never advertises what the
token cannot call.

### [S2.4] Model kind derivation

There is no `type` field on `Provider.Model`; every model is otherwise assumed to
be a language model. Kind is DERIVED from the existing modality capabilities
(`provider.ts:990-991`, fed from models.dev or the user's own per-model
`modalities` config at `config/provider.ts:47-52`):

- speech model: `capabilities.output.audio && !capabilities.output.text`
- language model: `capabilities.output.text`

This deliberately adds no schema field. A model absent from models.dev (OpenAI's
`tts-1` and `gpt-4o-mini-tts` are both absent) is declared by the user as:

```json
{ "modalities": { "input": ["text"], "output": ["audio"] } }
```

Consequence, accepted knowingly: embedding models are NOT distinguishable this
way — `text-embedding-3-small` reports `output: ["text"]`, same as a chat model.
Misusing one still fails at the provider, not at our validation.

`/v1/models` continues to list every configured model regardless of kind. This
matches OpenAI, whose `/v1/models` also lists `tts-1`, `text-embedding-3-*`, and
image models. The requirement is not to hide them but to fail comprehensibly when
one is misused (see [S2.7]).

### [S2.5] Chat completions behaviour

One code path for both response modes: `start()` always uses `streamText`;
`collect()` drains `fullStream` into a single `chat.completion`. This avoids
wiring the transform middleware twice and keeps behaviour identical across modes.

- Provider compatibility reuses `ProviderTransform` (`message`, `tools`,
  `temperature`/`topP`/`topK`, `maxOutputTokens`, `providerOptions`, `options`)
  around the resolved language model rather than re-deriving per-provider quirks.
- `temperature` is only sent when `model.capabilities.temperature` is true,
  matching `session/llm.ts:498`. That capability defaults to FALSE
  (`provider.ts:1320`), so sending it unconditionally would contradict the
  session path.
- Tools are registered schema-only (no `execute`). The SDK emits `tool-call`
  parts and stops; the caller owns the tool loop, per the OpenAI contract.
- `maxRetries: 0`. A proxy that retries silently turns one client request into
  several billed upstream calls with no way for the caller to observe it.
- A synthetic per-request id stands in for a sessionID in
  `ProviderTransform.options`, scoping any provider prompt-cache key to one
  request instead of sharing it across unrelated callers.
- Non-streaming tool arguments are read from completed `tool-call` parts, never
  reassembled from `tool-input-delta`, so a partial-JSON stream cannot leak a
  truncated `arguments` string.
- Streaming emits both tool paths: `tool-input-start`/`-delta` for providers that
  stream arguments, and a synthesized whole entry for providers that deliver a
  call in one piece.

### [S2.6] Request validation policy

Unknown request fields are IGNORED, not rejected. Real OpenAI client libraries
send fields like `parallel_tool_calls`, `store`, `metadata`, and `service_tier`
unconditionally; rejecting them breaks the primary use case — pointing a stock
OpenAI client at the local `base_url` — for callers who asked for nothing
unsupported.

A field is rejected with 400 only when honouring it is impossible AND ignoring it
would silently produce a result in the wrong shape or quantity:

- `n` other than 1
- `logprobs`, `top_logprobs`
- non-empty `logit_bias`
- any `response_format`

Documented no-op defaults (`n: 1`, zero penalties) are accepted, because an
untouched client sends them without requesting anything.

### [S2.7] Error taxonomy

- validation → 400, OpenAI-shaped `error` body
- unknown model, or model outside the allowlist → 404 `model_not_found`
- wrong endpoint for the model's kind → 400 naming the correct endpoint, so a
  caller that sends a speech model to `/v1/chat/completions` learns where to go
  instead of receiving an opaque upstream error
- upstream provider failure → 502, not 500, so a caller can distinguish
  "MiMoCode broke" from "the provider broke"
- mid-stream failure, where the status line is already sent → exactly ONE in-band
  SSE error frame followed by the `[DONE]` sentinel, and nothing after `[DONE]`

### [S2.8] Speech synthesis

`Provider.getSpeech(model)` mirrors `getLanguage` (`provider.ts:1754-1788`):
reuse `resolveSDK`, cache the constructed model, and map `NoSuchModelError` to
`ModelNotFoundError`. The standard provider interface names the factory
`speechModel?(id)` (`@ai-sdk/provider:3453`) while `@ai-sdk/openai` names it
`speech(id)` (`:1101`), so both names are attempted.

`POST /v1/audio/speech` accepts OpenAI's shape (`model`, `input`, `voice`,
`response_format`, `speed`, `instructions`) and returns the audio bytes with the
matching `Content-Type`.

Not supported, stated rather than implied: streaming TTS. The AI SDK exposes
`generateSpeech` and no `streamSpeech`, so audio is returned as one complete
body. Long inputs will show the full synthesis latency as time-to-first-byte.

### [S2.9] CLI

`mimo llm-server` with `--port`, repeatable `--model`, `--token`, and `--json`.
`--json` prints one machine-readable line so a wrapper can set `OPENAI_BASE_URL`
and `OPENAI_API_KEY` without scraping prose. SIGINT/SIGTERM stop the listener.

## [S3] Out of Scope

- **Anthropic Messages API (`/v1/messages`).** Decided against for this
  iteration: no consumer exists in the repo, and it is a second full protocol
  (top-level `system`, content blocks, required `max_tokens`, `input_schema`, and
  a six-event streaming model with block-index bookkeeping) rather than a variant
  of the OpenAI layer. Revisit when a named consumer appears — driving Claude
  Code or another Messages-only tool would make it required.
- `/v1/embeddings`, `/v1/responses`, transcription, image generation.
- Streaming TTS (no SDK support, see [S2.8]).
- `response_format` / structured output.
- Running the `chat.params` / `chat.headers` plugin hooks. `session/llm.ts:488,507`
  triggers them; this proxy does not. Four plugins rely on them
  (`copilot.ts:342` `toolStreaming=false`, `codex.ts` `maxOutputTokens=undefined`
  plus `originator`/`session_id` headers for `openai/*`, `cloudflare.ts`
  reasoning-model `max_tokens` drop, `mimo.ts` `X-Mimo-Source`). Wiring a
  session-shaped hook payload from a session-less proxy is its own design
  question. Recorded as a known gap.
- TUI `/llm-server` start/stop/copy dialog.
- Automatic hand-off of `base_url` + token to a skill. The server closes the
  "secret enters context" hole; it does not yet close "distribute the endpoint
  automatically". Deferred pending a decision on the delivery mechanism.
- Token TTL, idle auto-shutdown, concurrency caps, spend caps.
- CORS response headers.

Pre-existing defects confirmed to reproduce on the normal session path, therefore
NOT addressed here:

- `@ai-sdk/anthropic@3.0.82` defaults `toolStreaming: true`, emitting
  `eager_input_streaming` on every function tool; the configured MiMo Router
  rejects it for `anthropic/claude-haiku-4-5` (Bedrock-backed). `mimo run
  --model anthropic/claude-haiku-4-5` with tools fails identically.
- `openai/*` fails with `Token refresh failed: 401` in this environment.
  `mimo run --model openai/gpt-4o-mini` fails identically.

## Tasks

- [x] T1: Create a worktree on latest `origin/main` and migrate the prior draft — acceptance: `bun typecheck` clean in `packages/opencode` (covers: S2)
- [ ] T2: Accept unknown request fields; keep the semantic-guard rejections — acceptance: a payload carrying `parallel_tool_calls`/`store`/`metadata`/`service_tier` returns 200; `response_format` and `n: 2` still return 400 (covers: S2.6)
- [ ] T3: Accept a raw `x-api-key` token — acceptance: `x-api-key: <token>` returns 200 and `x-api-key: wrong` returns 401 (covers: S2.2; depends: T1)
- [ ] T4: Emit exactly one SSE error frame, with nothing after `[DONE]` — acceptance: a forced mid-stream failure yields one error frame then `[DONE]` and no trailing `event: error` (covers: S2.7; depends: T1)
- [ ] T5: Gate `temperature` on `capabilities.temperature` — acceptance: a model whose capability is false receives no temperature even when the caller sends one (covers: S2.5; depends: T1)
- [ ] T6: Derive model kind from modalities and reject cross-endpoint misuse — acceptance: a speech model posted to `/v1/chat/completions` returns 400 naming `/v1/audio/speech`, and vice versa (covers: S2.4, S2.7; depends: T1)
- [ ] T7: Add `Provider.getSpeech` — acceptance: resolves a speech model through `resolveSDK` with the constructed model cached, and maps an unknown id to `ModelNotFoundError` (covers: S2.8; depends: T6)
- [ ] T8: Add `POST /v1/audio/speech` — acceptance: returns audio bytes with a matching `Content-Type`, enforces the allowlist, and 404s an unknown model (covers: S2.8; depends: T7)
- [ ] T9: Tests for protocol conversion, auth, validation policy, model-kind gating, and SSE framing — acceptance: `bun test` passes from `packages/opencode` (covers: S2.2, S2.4, S2.5, S2.6, S2.7)
- [ ] T10: Verify and review — acceptance: `bun typecheck` and `bun test` clean, live smoke test of every route, and an independent review with no unresolved critical findings (covers: S2)
