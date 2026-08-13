---
name: llm-endpoint-demo
description: Demo and end-to-end fixture for MiMoCode's temporary local LLM server. Use when verifying that a skill can borrow a configured model through a local base_url and a throwaway token instead of a real provider API key, or when testing the expire-and-reissue loop. Not a general-purpose skill.
---

# LLM endpoint demo

A minimal skill that needs "a model" and is given one **without ever seeing a
provider API key**. It reads exactly two environment variables and calls an
OpenAI-compatible endpoint; it knows nothing about MiMoCode's provider config or
credential store.

Its purpose is to be a black-box witness. If this skill works, the claim "a skill
can use a configured model without the secret entering the model's context or a
readable config file" is demonstrated rather than asserted.

## What this skill needs

| Variable | Meaning |
| --- | --- |
| `OPENAI_BASE_URL` | The local endpoint, e.g. `http://127.0.0.1:53854/v1` |
| `OPENAI_API_KEY` | A temporary token, NOT a provider key |
| `OPENAI_MODEL` | A `provider/model` reference, e.g. `anthropic/claude-haiku-4-5` |

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

2. **Mint a token scoped to this task.**

   ```
   <mimocode> llm-server issue --model <provider/model> --label llm-endpoint-demo --json
   ```

   The response carries `base_url`, `api_key`, `expires_at`, and — importantly —
   `renew_command` / `renew_argv`, which is the invocation to use later for a
   replacement key. Keep it: it already encodes the flags that shaped this token,
   so a renewal is equivalent rather than merely valid.

   Pass `--model` so the key cannot reach models this task has no business calling.
   Pass `--ttl none` only for a job with no natural end.

3. **Export and run.**

   ```
   OPENAI_BASE_URL=<base_url> OPENAI_API_KEY=<api_key> OPENAI_MODEL=<provider/model> \
     node summarize.mjs "one sentence about the sea"
   ```

## Handling expiry

The token has a lifetime. It slides forward on every use, so an actively working
task is not interrupted, but an idle one will age out.

`summarize.mjs` exits with a distinct code so the failure is actionable:

| Exit | Meaning | What to do |
| --- | --- | --- |
| 0 | success | completion is on stdout |
| 2 | `expired_api_key` | run `renew_argv`, replace `OPENAI_API_KEY`, retry once |
| 3 | other failure | report it; do not retry blindly |
| 4 | environment missing | go back to step 2 |

On exit code 2, `base_url` does **not** change — tokens live outside the server
process, so only the key needs replacing. Do not restart the server and do not
re-derive the endpoint.

## What must never happen

- A provider API key must never appear in `OPENAI_API_KEY`, in this skill's
  directory, or anywhere in the conversation. The whole point is that it stays
  inside MiMoCode.
- The token must not be written into a committed file. It is short-lived and
  per-task; mint a fresh one instead of persisting it.
