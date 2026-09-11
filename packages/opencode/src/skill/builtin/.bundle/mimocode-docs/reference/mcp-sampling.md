# MCP Client-Side Sampling

MiMoCode implements the MCP client `sampling` capability
([spec](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling)).
An MCP server can ask MiMoCode to run a model call on its behalf via
`sampling/createMessage`, so **the server never needs its own API key** — it
borrows the model connection the user already configured.

## The motivating use case

The MiMo Cut MCP server extracts a video's audio track to a 16 kHz mono WAV and
needs a transcript. Instead of shipping its own provider credentials, it sends
the WAV to MiMoCode as MCP `AudioContent` and asks for a completion:

```json
{
  "method": "sampling/createMessage",
  "params": {
    "messages": [
      { "role": "user", "content": [
        { "type": "text", "text": "Transcribe this audio verbatim." },
        { "type": "audio", "data": "<base64 wav>", "mimeType": "audio/wav" }
      ]}
    ],
    "systemPrompt": "You are a verbatim transcription engine.",
    "maxTokens": 2048,
    "modelPreferences": { "hints": [{ "name": "mimo-v2.5" }] }
  }
}
```

MiMoCode picks a configured, audio-capable model (preferring the hinted
`mimo-v2.5`), asks the user to approve, runs the call, and returns the model's
text unchanged. `MIMO_API_KEY` is never read or needed by the server.

## Capability negotiation

MiMoCode declares `capabilities.sampling = {}` during `initialize`.

`sampling.tools` and `sampling.context` are deliberately **not** declared,
because they are not implemented. Per the spec a client must error when a server
sends `tools`/`toolChoice` without the `sampling.tools` declaration, and
MiMoCode does exactly that. `includeContext` defaults to `none`: MiMoCode never
ships your session history to an MCP server.

## Model selection

MCP publishes no model list and no modality discovery, so selection is driven by
the **Model Capability Registry** (`src/provider/capability-registry.ts`). The
order is **filter, then rank** — and never the other way round:

1. **Derive** the required modalities from the actual content (text / image /
   audio, plus each item's MIME type and decoded byte size).
2. **Filter** to models that are *both* capability-compatible *and* have
   configured credentials. Compatibility ANDs two gates:
   - the model's own declared input modalities (`capabilities.input.*`, from
     models.dev metadata or your `/modalities` config), and
   - whether the provider adapter behind it can actually serialize that media.
3. **Rank** the survivors using `modelPreferences.hints`, in the server's stated
   order, exact model id first and substring second.
4. If no hint matches an eligible model, fall back to the ordinary model
   selection strategy — but only if its answer is itself eligible.

A hint is a *preference*, never an authorization: it can reorder eligible models
but can never make an ineligible one eligible. A server also cannot supply an
API key, base URL, or any other provider credential.

When nothing is eligible, MiMoCode returns a **structured error** naming every
configured model and why it was rejected. It never drops the audio, never
downgrades it to a text description, and never sends it to a model that cannot
accept it.

### Declared adapter support

Audio support per adapter, and the evidence for each verdict (locked in by
`test/provider/capability-registry-wire.test.ts`, which drives the real adapter
and asserts the serialized request body):

| Adapter | Audio | Accepted MIME | Evidence |
|---|---|---|---|
| `@ai-sdk/openai-compatible` | supported | `audio/wav`, `audio/mp3`, `audio/mpeg` | serializes these as `input_audio`; `audio/flac` and `audio/ogg` throw `functionality not supported` |
| `@ai-sdk/google` | supported | any `audio/*` | passes any audio MIME through as `inlineData` |
| `@ai-sdk/google-vertex` | supported | any `audio/*` | shares the `@ai-sdk/google` content conversion |
| `@ai-sdk/anthropic` | **unsupported** | — | an `audio/wav` part throws `'media type: audio/wav' functionality not supported`, while `image/png` serializes fine |
| `@ai-sdk/google-vertex/anthropic` | **unsupported** | — | shares the `@ai-sdk/anthropic` content conversion |
| `@ai-sdk/amazon-bedrock` | **unsupported** | — | excluded from every audio route in `src/session/tool-attachment.ts` (no direct wire probe) |
| anything else | **unknown** | — | no declaration; support is unproven, not disproven |

`unknown` is a distinct third state on purpose. A provider whose audio support we
cannot substantiate is reported as unproven rather than guessed either way. Both
`unsupported` and `unknown` are ineligible (fail closed), but the error message
distinguishes them so you can tell "this cannot work" from "we do not know".

## Permission model

The default policy is **ask**. The approval prompt shows:

- which MCP server asked,
- the model that will actually run,
- the content types present, and the size of any audio,
- previews of the system prompt and the user text prompt.

Two independent controls, and a `deny` from **either** one refuses the request:

- `permission.mcp_sampling` — standard permission rule, keyed by MCP server name
  (`{ "*": "ask", "mimo-cut": "allow" }`).
- `mcp.<server>.sampling` — per-server policy: `deny` | `ask` | `allow`
  (default `ask`).

`deny` refuses before any prompt, model selection, or provider call. `allow`
skips the prompt but is **not** a bypass: request size caps, the request
timeout, and model capability checks all still apply — and it does **not**
override a `permission.mcp_sampling` deny. Because `allow` skips the approval
step entirely, the handler evaluates the permission ruleset itself rather than
relying on the prompt to surface a deny; the error names which control refused
(`data.deniedBy`).

If a sampling request arrives while no turn is in flight for that server, the
`ask` policy fails closed rather than raising a prompt no UI is listening to.

## Limits

| Limit | Value |
|---|---|
| Media (image/audio) per item, decoded | 20 MiB |
| Text per item, and `systemPrompt` | 1 MiB |
| No output from the model (stall) | the provider's `chunkTimeout` — 8 min by default |

That is the whole list of time bounds, and it is inherited rather than chosen.
There is **no total bound** on a sampling request, **no bound on the model call**
end to end, and **no bound on the approval wait**. Sampling sets one number of its
own — the 15 s liveness interval — and that one is a keepalive cadence, not a
deadline.

### Why there is no total bound

The main conversation path settles it. `src/session/llm.ts` puts no wall-clock
ceiling on a model call at all: its retry schedule is "intentionally NOT capped",
its own worst case is ~97 minutes, and it states the design in one line —
*"bounding per-attempt latency via `chunkTimeout` is the primary lever for
hang-time control"*. For a streaming call this repo's position is that **elapsed
total is not a health signal; silence is.** Sampling calls the same provider
through the same SDK, so a 2-minute total budget made it roughly 48× more
impatient than ordinary chat for no stated reason. It is gone, along with the
absolute ceiling that sat behind it.

### Why there is no approval bound

The same reason, measured in `src/permission/index.ts`: **an ordinary interactive
permission prompt has no timeout.** Only a *forwarded* ask and a forced-ask under
skip-permissions are bounded, and a sampling approval is neither. A TUI prompt
waits as long as the operator needs, so sampling giving up at 30 s was stricter
than anything comparable in the repo. The wait now ends when the operator answers,
when the peer cancels (its own request timeout is what produces that), or when the
MCP client closes.

### The stall bound, and what it is not

The model call **streams**, so "has this hung?" is answerable from evidence rather
than guessed: no output at all is a symptom, not a policy choice about how patient
MiMoCode is. It fails with `sampling stalled: the model produced no output` and
`data.phase: "stall"`. Its clock covers both the wait for the first chunk and every
gap between later chunks, and **every arriving chunk resets it** — a stream that
produces slowly for ten minutes never stalls, while one that goes quiet does.

The error also carries `data.chunks` and `data.characters`, which separate the two
failures a server author would otherwise have to guess between: `chunks: 0` means
the provider never produced anything, and a non-zero count means it started and
then died.

**Its value is the provider layer's `chunkTimeout`, not a sampling-specific
number.** Set `chunkTimeout` for a provider in `mimocode.json` and it governs
sampling exactly as it governs ordinary chat; leave it unset and both get the 8
minute default. Sampling used to carry its own 45 s bound for the same question,
which disagreed with the provider layer by 10× — and in the wrong direction, since
`chunkTimeout` is tuned to tolerate a real cold-path first token that can be ~5
minutes silent. A tighter number would have failed calls ordinary chat survives.

What is deliberately **not** covered, stated rather than implied: a stream that
trickles just often enough never to look stalled and never finishes, and the
stretch before the model call (model selection, provider initialisation). Both are
unbounded here — and both are equally unbounded on the main chat path, which is the
basis for accepting them rather than inventing a number to cover them.

Reaching this bound aborts the provider call as well as MiMoCode's wait
for it. That is not automatic: interrupting the Effect fiber does not cancel an
HTTP request already in flight inside it, so the handler hands the provider the
union of its own fiber's abort signal and the MCP request signal. Both a timeout
and a client teardown therefore reach the provider.

### Keeping a server's own timer alive

While the model call is in flight MiMoCode emits periodic
`notifications/progress` — every 15 s — so a server that asked for progress does
not abandon a request that is still being worked on. Without them a server on the
SDK's 60 s default gives up at 60 s while MiMoCode is still working, since
MiMoCode imposes no deadline of its own on the model call.

What it does and does not claim:

- **It reports observed output, but it is still not a fraction.** The model call
  streams, so the notification says how many chunks and characters the provider has
  actually produced — which is what lets a server tell "MiMoCode is alive" from
  "the model is producing", a distinction a timer-driven tick cannot make. `total`
  is still deliberately omitted, because streaming does not reveal how much output
  is coming either, so no percentage can be read out of it. `progress` remains a
  monotonic tick rather than the chunk count, since a chunk count does not advance
  during exactly the quiet stretch a notification is most needed for.
- **It never carries the model's text.** Partial content is deliberately withheld:
  a request that later stalls, times out or is cancelled returns **no** text at all,
  so streaming a prefix over the progress channel would disclose in the failure case
  precisely what the response contract says was never delivered. `onprogress` is
  also how a peer asks to be told a request is alive — MCP has no partial-result
  channel, and treating `message` as one would be MiMoCode deciding that on the
  server's behalf. The running length is metadata and is disclosed; the text is not.
- **It is necessary, not sufficient.** Resetting the timer is the *requester's*
  choice: the SDK's `resetTimeoutOnProgress` defaults to `false`, so a server
  that did not pass it ignores these notifications entirely and still times out at
  its own deadline. MiMoCode cannot make that decision for it.
- **It cannot extend MiMoCode's own bounds.** The notifications reset the peer's
  timer only. The model call is still cut off at its own bound no matter how many
  went out, so a hung provider cannot be kept alive by its own keepalive.

Nothing is sent unless the server asked for it. The progress token belongs to the
requester — the SDK mints one only when its caller passed `onprogress`, and
MiMoCode reads it back off the request's `_meta`. No token means no notifications
at all.

The media cap is a **client-side safety limit**, not a claim about any
provider's real limit. It exists so a buggy or hostile server cannot push an
unbounded payload through the sampling path. For scale: 30 s of 16 kHz mono
16-bit PCM WAV is about 0.92 MiB.

## Concurrency, cancellation and cleanup

A sampling request normally arrives **while MiMoCode is still waiting for that
same server's `tools/call` to return**. This does not deadlock, for two
independent reasons:

1. The MCP SDK dispatches inbound requests from the transport's `onmessage`
   without awaiting the handler, so serving a sampling request never blocks the
   read loop that must later deliver the tool result.
2. MiMoCode runs the work on a fresh root Effect fiber, which shares no fiber,
   lock, or scope with the fiber parked on `callTool`.

Requests are served concurrently. A cancelled request unwinds through the
handler's abort signal, which is threaded into the approval wait and, composed
with the handler fiber's own signal, into the provider call. Closing or replacing
a client interrupts any sampling still in flight for it and aborts its provider
call, so an orphaned model call cannot outlive its transport.

> **Upstream caveat.** In `@modelcontextprotocol/sdk` 1.27.1 a cancellation whose
> JSON-RPC `requestId` is `0` is silently dropped
> (`if (!notification.params.requestId) return` in `shared/protocol.js`), because
> `0` is falsy. The *first* server-initiated request on a connection is therefore
> uncancellable upstream; later ones cancel correctly. The stall bound is what keeps
> even that case from leaking, and it is the ONLY thing that does — which is why it
> is not gated on the server having asked for progress. Because it aborts the
> provider call it ends the model call rather than merely stopping us waiting for it.
>
> MiMoCode does not work around this, because it cannot: the id at risk belongs to
> the **server's** outgoing request counter, which only the server can advance.
> Spending an id from the client side — a ping at connection setup, say — advances
> the client's own counter and leaves the server's at `0`, so the server's
> cancellations still do not land. Measured, together with the failing and working
> cases, in `test/mcp/sampling-e2e.test.ts`; those tests fail if an SDK upgrade
> changes this behaviour.
>
> The residual, stated plainly: **when a server abandons the first sampling request
> it issues on a connection, MiMoCode does not learn of it, so that request keeps a
> model call running — and a paid one — until one of MiMoCode's own bounds aborts
> it — which happens once the provider goes quiet for its `chunkTimeout`. If the
> provider instead keeps trickling output indefinitely, nothing here stops it; that
> is the same exposure ordinary chat carries, and it is accepted on the same terms.**
> The bound caps the waste; it does not avoid it.

## Security boundaries

- API keys, `Authorization` headers, and provider configuration never appear in a
  sampling response, in logs, or in any error payload.
- Logs record only the server, model, content types, sizes, duration, and result
  status. Never the audio bytes, and never a full prompt — prompt previews are
  whitespace-collapsed and truncated.
- The model's text is returned **verbatim**. MiMoCode does not summarise or
  rewrite it.
- Session context is never forwarded to an MCP server.

## Result and error mapping

Success returns the spec's `CreateMessageResult`: `role`, `content`, `model` (the
model actually used, as `provider/model`), and `stopReason`
(`endTurn` / `stopSequence` / `maxTokens`).

| Situation | JSON-RPC code |
|---|---|
| Malformed params, bad base64/MIME, oversize, no compatible model | `-32602` InvalidParams |
| Policy `deny`, user declined, no session for an `ask` | `-1` |
| Cancelled or timed out | `-32001` |
| Provider failure, model init failure | `-32603` InternalError |

`-32001` cannot be read alone: it is the SDK's own `RequestTimeout`, which the
SDK's request timeout raises too, with a `data.timeout` our bound also sets. Only
our errors carry `data.server`, so that field is what says whose deadline fired.

Once it is ours, `data.phase` has exactly one possible value — `"stall"` — because
that is now the only deadline MiMoCode imposes; the `"approval"`, `"model"` and
`"total"` phases went away with the bounds that produced them. A `"stall"` carries
`data.chunks` and `data.characters`, so a server can tell a provider that never
produced anything from one that stopped part way. A cancellation carries
`data.server` with no `phase`, because nothing expired.
