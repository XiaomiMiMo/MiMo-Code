---
name: llm-endpoint-demo
description: Demo and end-to-end fixture for MiMoCode's temporary local LLM server. Use when verifying that a skill can borrow a configured chat or text-to-speech model through a local base_url and a throwaway token instead of a real provider API key, or when testing the expire-and-reissue loop. Not a general-purpose skill.
---

# LLM endpoint demo

A minimal skill that needs "a model" — for chat and for speech — and is given one
**without ever seeing a provider API key**. It reads a handful of environment
variables and calls an OpenAI-compatible endpoint; it knows nothing about
MiMoCode's provider config or credential store.

Its purpose is to be a black-box witness. If this skill works, the claim "a skill
can use a configured model without the secret entering the model's context or a
readable config file" is demonstrated rather than asserted.

## What this skill needs

| Variable | Meaning |
| --- | --- |
| `OPENAI_BASE_URL` | The local endpoint, e.g. `http://127.0.0.1:53854/v1` |
| `OPENAI_API_KEY` | A temporary token, NOT a provider key |
| `OPENAI_MODEL` | Chat: a `provider/model` reference, e.g. `anthropic/claude-haiku-4-5` |
| `OPENAI_TTS_MODEL` | Speech: a `provider/model` whose output modality is audio |
| `OPENAI_TTS_OUT` | Speech: where to write the audio file |
| `OPENAI_TTS_VOICE` | Speech, optional. Default `alloy` |
| `OPENAI_TTS_FORMAT` | Speech, optional. `mp3`/`opus`/`aac`/`flac`/`wav`/`pcm`. Default `wav` |

A speech model has to be **declared** as one. Model kind is derived from output
modality, and the models OpenAI ships for TTS are absent from the public registry,
so give them modalities in config:

```json
{ "provider": { "openai": { "models": {
  "tts-1": { "modalities": { "input": ["text"], "output": ["audio"] } }
} } } }
```

Without that, the endpoint treats `tts-1` as a chat model and the request is
refused with a 400 that names the right route.

## Setting it up

1. **Make sure a server is running for this project.** Ask it:

   ```
   <mimocode> llm-server status --json
   ```

   `<mimocode>` is however THIS installation is invoked. Do not assume `mimo` is
   on `PATH` — it frequently is not, for example under `npx` or a source checkout.
   If nothing is running, start one in the background:

   ```
   <mimocode> llm-server &
   ```

   Prefer a fixed `--port` if the endpoint has to survive a restart, because the
   default port is chosen at random and `base_url` would otherwise change.

2. **Mint a token scoped to this task.** Ask by CAPABILITY, not by model name:

   ```
   <mimocode> llm-server issue --capability speech --label llm-endpoint-demo --json
   <mimocode> llm-server issue --capability transcription --json
   <mimocode> llm-server issue --capability chat --json
   ```

   The response includes the `model` it resolved, so set your own env var from that
   rather than hard-coding an id — a skill that names `mimo-v2.5-tts` only runs where
   that model happens to be configured. `fallback: true` means a multimodal chat model
   is standing in for a dedicated one, which works but has a looser contract.

   If nothing can serve the capability the command FAILS before your script starts, with
   a message saying what to declare. That is the point: failing here beats failing deep
   inside your own code with a 501.

   To pin an exact model instead, use `--model <provider/model>`. The two are mutually
   exclusive.

   The response carries `base_url`, `api_key`, `expires_at`, and — importantly —
   `renew_command` / `renew_argv`, which is the invocation to use later for a
   replacement key. Keep it: it already encodes the flags that shaped this token,
   so a renewal is equivalent rather than merely valid.

   Pass `--model` so the key cannot reach models this task has no business calling.
   One key may carry several `--model` flags, so a task that both writes and speaks
   gets one token covering the chat model and the speech model.
   Pass `--ttl none` only for a job with no natural end.

3. **Export and run.** Chat:

   ```
   OPENAI_BASE_URL=<base_url> OPENAI_API_KEY=<api_key> OPENAI_MODEL=<provider/model> \
     node summarize.mjs "one sentence about the sea"
   ```

   Speech:

   ```
   OPENAI_BASE_URL=<base_url> OPENAI_API_KEY=<api_key> \
   OPENAI_TTS_MODEL=<provider/model> OPENAI_TTS_OUT=out.wav \
     node speak.mjs "one sentence about the sea"
   ```

   `speak.mjs` prints `<bytes> <content-type> <path>`. Trust the reported content
   type over the format you asked for: the provider decides what it actually
   produced.

   Speech is returned as one complete body — there is no streaming TTS, because the
   SDK offers no streaming speech call. Long input shows the whole synthesis time as
   time-to-first-byte, so keep requests short or expect the wait.

## Handling expiry

The token has a lifetime. It slides forward on every use, so an actively working
task is not interrupted, but an idle one will age out.

Both scripts exit with a distinct code so the failure is actionable:

| Exit | Meaning | What to do |
| --- | --- | --- |
| 0 | success | completion on stdout, or the audio file written |
| 2 | `expired_api_key` | run `renew_argv`, replace `OPENAI_API_KEY`, retry once |
| 3 | other failure | report it; do not retry blindly |
| 4 | environment missing | go back to step 2 |
| 5 | `unsupported_capability` (speech only) | this provider package cannot synthesize; choose a different model. Retrying and re-keying both fail |

On exit code 2, `base_url` does **not** change — tokens live outside the server
process, so only the key needs replacing. Do not restart the server and do not
re-derive the endpoint.

## What must never happen

- A provider API key must never appear in `OPENAI_API_KEY`, in this skill's
  directory, or anywhere in the conversation. The whole point is that it stays
  inside MiMoCode.
- The token must not be written into a committed file. It is short-lived and
  per-task; mint a fresh one instead of persisting it.
