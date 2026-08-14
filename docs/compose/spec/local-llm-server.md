---
feature: local-llm-server
status: delivered
updated: 2026-08-13
branch: feat/llm-server
commits: c2059d510..25b9a9c51
---

# Temporary local LLM server (`mimo llm-server`)

## Report

**What was built** — `mimo llm-server` starts a loopback-only, OpenAI-compatible
HTTP server in front of the models the running MiMoCode instance is already
configured for. A caller receives a `base_url` and a 256-bit process-scoped bearer
token; the real provider credential never leaves `Provider.Service`, so it never
enters a prompt, a transcript, or a file a skill can read. Three routes:
`GET /v1/models`, `POST /v1/chat/completions` (streaming and not, with tools), and
`POST /v1/audio/speech`. Repeatable `--model provider/model` forms an allowlist
enforced on every path, and one server per task is the isolation boundary — two
servers cannot replay each other's token.

Model kind is derived from the modality capabilities that already existed rather
than from a new schema field, which is what let TTS land without touching the
config schema: a model absent from models.dev is declarable today via per-model
`modalities`. `Provider` gained `getSpeech`, mirroring `getLanguage`.

The starting point was a 967-line draft from two earlier sessions that had never
been typechecked or executed. It typechecked clean on first run, and live testing
then found five real defects — the request schema's `.strict()` rejecting the
fields every stock OpenAI client sends, `x-api-key` demanding a `Bearer` prefix no
client adds, duplicated SSE error frames with content after `[DONE]`, an
unguarded `temperature`, and opaque failures when a model met the wrong endpoint.
Independent review then found two more: `provider_options` nested one level too
deep and silently dropped, and an unparseable `image_url` returning 502 instead of
400.

**Verification**

- `bun typecheck` from `packages/opencode` — PASS (clean). Confirmed it actually
  covers the new files by injecting a deliberate type error and seeing it caught.
- `bun test test/llm-server/` — PASS, 64 tests across 3 files.
- `bun test` (full suite, ~23 min) — 5007 pass. Every failure sits outside
  `test/llm-server/`. Four were reproduced on a pristine `origin/main` worktree and
  are therefore PRE-EXISTING: WorkflowRuntime "8 agents under cap=2",
  checkpoint-splitover "CheckpointContext producer", checkpoint-splitover
  "parentSessionID end-to-end", prompt-effect "failed subtask preserves metadata".
  `test/agent/orchestrator.test.ts` is load-sensitive — it fails under full-suite
  parallelism and passes alone in 40s. Failure counts differed between two runs of
  identical code (6 then 11), which is itself the signature of timing flakiness.
- Live, against real providers: auth 401 paths, `/v1/models` (88 models),
  non-streaming and streaming completions, tool calls, an OAuth-credentialed
  provider (`codex/gpt-5.6-sol`, which also hit the prompt cache), allowlist
  enforcement, cross-token isolation in both directions, raw `x-api-key`, a stock
  OpenAI-client payload, wrong-endpoint 400, unparseable `image_url` 400,
  unauthenticated `OPTIONS` 401, and a pre-first-byte streaming failure returning a
  real status.
- Independent review of `6343b8c62` against this document: all ten acceptance
  criteria met; two major and several minor findings, all addressed above except
  those explicitly recorded as out of scope.

**Journey log**

1. Two prior sessions had already written the whole draft and left it uncommitted
   in a stale worktree. Reading it before deciding was worth more than either
   rewriting or trusting it: the design was sound and the code typechecked, but
   nothing had ever run. "Unverified" and "wrong" are different problems.
2. Live testing beat reasoning repeatedly. The `.strict()` and `x-api-key` defects
   were both invisible in review and obvious on the first curl.
3. Attribution discipline paid off three times. `eager_input_streaming` on
   `haiku-4-5`, `Token refresh failed: 401` on `openai/*`, and four test failures
   all looked like regressions and were all reproduced on an untouched baseline.
   The cheap move each time was to run the same thing on `origin/main` rather than
   argue from the code.
4. A truncated upstream body does NOT produce an SDK error — the AI SDK treats a
   severed connection as a clean end-of-stream. Testing a mid-stream failure
   requires the upstream to emit an actual error frame.
5. Researching alternatives before building saved nothing and confirmed plenty:
   upstream opencode has an open feature request for exactly this and no
   implementation, `@ai-sdk-tool/proxy` has no model routing at all (the request's
   `model` is a decorative echo), and the external-proxy route cannot cover
   `oauth`-credentialed providers because there is no static key to export.

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
- `POST /v1/audio/transcriptions`

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

- speech: `output.audio && !output.text`
- transcription: `input.audio && !input.text && output.text`
- language: everything else

Both tie-breaks are load-bearing against real registry data. Audio AND text output is a
live/multimodal chat model (Gemini live, `lyria-3-pro`), not a synthesizer, so text
output wins. Audio input WITH text input is a multimodal chat model that happens to hear
— `mimo-v2.5` declares `input: [text, image, audio, video]` and every Gemini does the
same — not a transcriber; only audio-in-without-text-in is ASR, which is exactly how
`whisper-large-v3` is declared. Without the second guard the entire multimodal fleet
would be routed away from chat.

That guard tracks a protocol fact rather than a taxonomy preference: a dedicated ASR
endpoint REFUSES text parts (MiMo answers 400 "ASR request must not include text parts;
text prompt is injected by the gateway") while a multimodal chat model REQUIRES an
instruction to know what to do with the audio. One request builder cannot serve both — so
the kind selects the SHAPE, not who is allowed in.

`/v1/audio/transcriptions` therefore serves both: a dedicated ASR model with the shape it
demands, and a multimodal model that can hear by instructing it. Measured on
`mimo-v2.5`, whose verbatim output was actually CLEANER than `mimo-v2.5-asr` under
`language: "en"`. The multimodal half goes through the SDK — an audio file part becomes
`input_audio` on the wire — so it needs no raw HTTP and works for any package the SDK
supports.

A reasoning model asked to transcribe emits the transcript as `reasoning_content` with
`content: null` some of the time, which no consumer can rely on. Reading reasoning as the
transcript is NOT safe either — on other calls that same field held "The user wants a
verbatim transcription… The audio contains the phrase: …".

The fix is to suppress thinking, and doing so decides which path carries the request:

- **Raw, for OpenAI-shaped providers.** `thinking: {type: "disabled"}` is MiMo's control
  for it. Measured: three consecutive runs then returned the transcript in `content` with
  `reasoning_tokens: 0`. This is the preferred path because it makes the contract stable.
- **SDK, for everything else.** An audio file part becomes `input_audio` on the wire, so
  any package the SDK supports still works — without thinking control.

`thinking` cannot go out through the SDK, and the reason is worth recording: it is an
ANTHROPIC-style field on an OPENAI-shaped endpoint. `@ai-sdk/anthropic` models it (54
references), but `@ai-sdk/openai-compatible` validates provider options against a closed
schema that has no `thinking` and offers no extra-body escape. The SDK is not wrong about
either protocol; MiMo's combination falls between them.

When thinking cannot be suppressed and `content` still comes back empty, the answer is a
legible 502 naming what happened and recommending a dedicated model — not a guess and not
a silent retry.

The chat route also accepts `input_audio` parts now, which is the right home for the
other audio task: reasoning ABOUT audio ("what did they agree to?") rather than
transcribing it, which returns an answer instead of the words.

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
- `verbosity`, which changes the answer and has no provider-agnostic mapping

### [S2.6.1] Reasoning

Reasoning is carried in BOTH directions, because a proxy that drops it turns a
reasoning model into a worse ordinary one.

Outbound: `reasoning_content` on the non-streaming message and on streaming deltas,
plus `completion_tokens_details.reasoning_tokens` in usage.

Inbound, request parameter: `reasoning_effort` is HONORED, not ignored, by looking up
`Model.variants[effort]` — the table `ProviderTransform.variants` already fills in with
each provider's own spelling (`reasoningEffort` for OpenAI, a `thinking` budget for
Anthropic, `thinkingConfig.thinkingBudget` for Google). No mapping is invented here, so
effort behaves exactly as it does in a session. It is deliberately not a fixed enum:
providers extend the set (`none`, `xhigh`, `max`), so the check happens where the model
is known. An effort the model does not offer is a 400 listing what it does, because a
silent downgrade is undetectable by the caller.

Inbound, conversation history: an assistant message may carry `reasoning_content`, which
is replayed as the SDK's `ReasoningPart` and placed BEFORE text and tool calls. Providers
that interleave thinking with tool use read the order, not just the set. The field name
matches what the server emits, so a client can hand back verbatim what it received.

Documented no-op defaults (`n: 1`, zero penalties) are accepted, because an
untouched client sends them without requesting anything.

Structural validity is still enforced, and enforced IN the schema rather than in
the handler. An unparseable `image_url` is the case that motivates the
distinction: `new URL` throwing inside the handler surfaces as a 502, dressing a
permanent client mistake as a retryable outage.

`provider_options` is FLAT — keyed by the provider-native option name, not by
provider. `ProviderTransform.options()` produces a flat map and
`ProviderTransform.providerOptions()` is what nests it under the SDK's namespace,
matching the order `session/llm.ts` uses. Both routes take the same flat shape and
nest through the same helper, so one field name never means two shapes.

Keys are the SDK's own provider-option names, which are camelCase
(`reasoningEffort`, not `reasoning_effort`). Verified reaching the wire through an
`@ai-sdk/openai-compatible` provider. An unrecognised key is discarded silently,
which is inherent to an open passthrough — prefer `reasoning_effort` where a
portable spelling exists.

An earlier revision of this document claimed the escape hatch was inert for
`@ai-sdk/openai-compatible` because of `sdkKey()`. That was wrong: the probe behind
the claim used a snake_case key the SDK does not read. Recorded here because the
false claim also reached the pull request description.

### [S2.7] Error taxonomy

- validation → 400, OpenAI-shaped `error` body
- unknown model, or model outside the allowlist → 404 `model_not_found`
- wrong endpoint for the model's kind → 400 naming the correct endpoint, so a
  caller that sends a speech model to `/v1/chat/completions` learns where to go
  instead of receiving an opaque upstream error
- model real, request well formed, provider package incapable → 501
  `unsupported_capability`, naming the package. Neither a 404 (which would send
  the caller hunting for a typo) nor a 5xx implying an outage
- upstream provider failure → 502, not 500, so a caller can distinguish
  "MiMoCode broke" from "the provider broke"
- mid-stream failure, where the status line is already sent → exactly ONE in-band
  SSE error frame followed by the `[DONE]` sentinel, and nothing after `[DONE]`

The last rule applies only once a frame has actually been emitted. `streamText` is
lazy, so the streaming route drains ONE frame before committing a status line;
until then a failure is reported with a real status code. Otherwise an expired
credential and a stream that died at token 500 would be indistinguishable — both
`200` with an error frame.

### [S2.7.1] Two audio conventions behind one façade

Providers carry audio two incompatible ways, and a skill must not have to know which
one its configured model uses:

- **OpenAI's dedicated endpoints.** `POST /v1/audio/speech` returns raw bytes and
  `POST /v1/audio/transcriptions` takes multipart. The AI SDK models this, and
  `Provider.getSpeech` covers it.
- **Audio inside chat completions.** MiMo's TTS/ASR, `gpt-4o-audio-preview`, Gemini's
  audio-out models. Synthesis text goes in an ASSISTANT message and audio returns
  base64 in `message.audio`; transcription sends an `input_audio` content part and the
  transcript arrives as ordinary `message.content`.

The AI SDK cannot carry the second one: `@ai-sdk/openai-compatible`'s response schema
has no `audio` field, so any audio a provider returns is dropped before `streamText`
yields anything. Measured against the live MiMo endpoint before the fallback existed: a
model declared with audio output was refused by BOTH routes (chat sent it to the audio
route, the audio route answered 501), and declared with text output it produced an
opaque 502.

So `src/llm-server/audio-chat.ts` talks HTTP directly when the provider package has no
native audio factory AND its endpoint is known to speak OpenAI chat completions
(`@ai-sdk/openai`, `@ai-sdk/azure`, `@ai-sdk/openai-compatible`). The second condition
is not decoration: "no speech factory" only means the SDK cannot help, and says nothing
about the protocol. `@ai-sdk/google`, `@ai-sdk/anthropic`, and `@ai-sdk/amazon-bedrock`
also lack one while speaking `:generateContent`, `/v1/messages`, and a signed AWS API
respectively — and `google/gemini-2.5-pro-preview-tts` is declared `output: ["audio"]`
in the registry, so an operator with a Google provider would reach that path. Without
the gate they would get a 404 reported as the provider's fault instead of ours. Outside
the list the answer is 501 naming the package.

A provider that IS OpenAI-shaped but does not use the audio-in-message convention fails
differently: the call succeeds and answers with text. That case reports what was
attempted rather than a bare "no audio", so a convention mismatch does not read as the
provider misbehaving. That is a deliberate, contained exception to "always go through
the SDK", and it does not weaken the credential boundary: the key is read from the
provider's own config INSIDE this process and never travels to the caller, exactly as
when the SDK builds the request.

Verified end to end against `api.xiaomimimo.com`: `mimo-v2.5-tts` returned a 130 KB
`audio/wav` body through `/v1/audio/speech`, and feeding that audio back through
`/v1/audio/transcriptions` with `mimo-v2.5-asr` recovered the sentence.

Two upstream findings recorded because they cost real debugging time:

- `File` reports a wav upload as `audio/x-wav` on some platforms and MiMo rejects that
  spelling outright, so upload media types are normalised to canonical form.
- `asr_options.language: "en"` makes `mimo-v2.5-asr` prefix the transcript with
  `think>\n<chinese> `. Reproduced three times in a row; `auto`, `zh`, and omitting the
  field are all clean. Left un-stripped on purpose: silently rewriting a transcript
  would hide an upstream bug and risks corrupting legitimate text.

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
`stream_format: sse` is therefore refused with a 400 rather than ignored, which
would strand a client waiting to read frames.

The response content type prefers what the provider determined, but `audio/mp3`
is deliberately treated as NO answer: `generateSpeech` reports
`detectMediaType(bytes) ?? "audio/mp3"`, and a successfully sniffed mp3 is spelled
`audio/mpeg`, so that exact string means sniffing failed. Honouring it would
relabel a flac the caller explicitly requested. In that case the requested format
wins, because it is what was actually sent upstream.

### [S2.8.1] Declaring a capability instead of a model

A skill that names `mimo-v2.5-tts` is bound to one installation. `llm-server issue
--capability speech|transcription|chat` resolves what a skill NEEDS to whatever this
installation HAS, mints a token scoped to that single model, and reports the model it
picked so the skill can fill its own env var. `Provider` already resolves by capability
internally — `getVisionModel`, `getSmallModel` — so this follows an existing shape.

Three properties make it more than sugar:

- **It fails before the skill starts.** No speech model configured answers with what to
  declare, rather than letting the skill fail deep in its own code with a 501.
- **It distinguishes absent from unreachable.** A speech model on `@ai-sdk/google` is
  declared but has no transport here, and offering it would hand out a token that cannot
  work. That case names the package.
- **It reports a fallback as a fallback.** `fallback: true` means a multimodal chat model
  is standing in for a dedicated one — measured on this machine, `transcription` resolves
  to `mimo/mimo-v2.5` because no dedicated ASR is configured.

The chosen model is the configured DEFAULT where one qualifies, because the alternative is
whatever sorts first: on a real installation that was
`anthropic-mify/ppio/pa/claude-haiku-4-5`, which is alphabetical noise rather than a
decision. `--capability` and `--model` are mutually exclusive, since accepting both would
leave the caller guessing which won.

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
- [x] T2: Accept unknown request fields; keep the semantic-guard rejections — acceptance: a payload carrying `parallel_tool_calls`/`store`/`metadata`/`service_tier` returns 200; `response_format` and `n: 2` still return 400 (covers: S2.6)
- [x] T3: Accept a raw `x-api-key` token — acceptance: `x-api-key: <token>` returns 200 and `x-api-key: wrong` returns 401 (covers: S2.2; depends: T1)
- [x] T4: Emit exactly one SSE error frame, with nothing after `[DONE]` — acceptance: a forced mid-stream failure yields one error frame then `[DONE]` and no trailing `event: error` (covers: S2.7; depends: T1)
- [x] T5: Gate `temperature` on `capabilities.temperature` — acceptance: a model whose capability is false receives no temperature even when the caller sends one (covers: S2.5; depends: T1)
- [x] T6: Derive model kind from modalities and reject cross-endpoint misuse — acceptance: a speech model posted to `/v1/chat/completions` returns 400 naming `/v1/audio/speech`, and vice versa (covers: S2.4, S2.7; depends: T1)
- [x] T7: Add `Provider.getSpeech` — acceptance: resolves a speech model through `resolveSDK` with the constructed model cached, and maps an unknown id to `ModelNotFoundError` (covers: S2.8; depends: T6)
- [x] T8: Add `POST /v1/audio/speech` — acceptance: returns audio bytes with a matching `Content-Type`, enforces the allowlist, and 404s an unknown model (covers: S2.8; depends: T7)
      Verified end to end, including the success path: `test/llm-server/e2e-speech.test.ts`
      drives the demo skill's `speak.mjs` as a real subprocess against a real
      listener, with an `@ai-sdk/openai` provider aimed at a local fake vendor. The
      audio is asserted byte-exact. Still NOT verified against a live vendor, since
      no TTS model is configured in this environment.
- [x] T9: Tests for protocol conversion, auth, validation policy, model-kind gating, and SSE framing — acceptance: `bun test` passes from `packages/opencode` (covers: S2.2, S2.4, S2.5, S2.6, S2.7)
- [x] T10: Verify and review — acceptance: `bun typecheck` and `bun test` clean, live smoke test of every route, and an independent review with no unresolved critical findings (covers: S2)
