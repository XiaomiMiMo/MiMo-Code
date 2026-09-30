# Capability API — lending this instance's models

Every MiMoCode server already serves an OpenAI-compatible surface over the models this
project has configured, mounted at `/v1`. There is no separate LLM server to start and no
daemon to manage: if a MiMoCode process is listening, the endpoints are there.

The point is to stop handing real provider keys to things that only need "a model". A task,
skill, or subprocess gets this instance's base URL plus a throwaway scoped token; the real
credential never leaves the provider layer. It lives on the instance server rather than in a
listener of its own because plugin-authenticated providers get their credentials from a
`chat.headers` hook — a separate process could not reach them.

The surface serves chat models.

## Where the endpoint is

Every session binds a loopback listener on a random port at startup, so the endpoints
exist without anyone asking for one. Two consequences:

- **The port changes every session** and belongs to that process — it is gone when the
  session exits. Never cache a base URL across runs.
- **A listener nobody asked for is credential-closed.** It generates a password kept in
  memory (never printed, never put in the environment), so `/session`, `/file`, `/pty` and
  every other instance route require HTTP Basic auth that only that process knows. `/v1`
  is carved out: a minted token gets through. Containment also stays in force, so an
  implicit listener serves exactly one project.

Pass a network flag when a *fixed* port is wanted instead. That is the explicit case and
behaves as it always did, credential-free on loopback — it is what `mimo attach` over SSH
uses:

```bash
mimo --port 4096                 # TUI plus a listener on a port you chose
mimo serve --port 4096           # headless, same endpoints
```

Launch from the project directory either way: the instance directory is the process's cwd,
and a request naming a directory outside it is refused with 403.

Each serving process advertises itself at
`<state>/llm-server/<sha1 of the resolved directory>/server-<pid>.json` — one file per
process, filtered on read by whether that pid is still alive. That is how
`mimo llm-server issue` can print a base URL. A spawned child should be **told** its
endpoint by whoever spawned it rather than picking one out of that directory.

## Minting a token

`mimo llm-server` only mints and manages credentials; it starts nothing.

```bash
mimo llm-server issue --json --label my-skill
mimo llm-server issue --model anthropic/claude-haiku-4-5 --ttl 12h
mimo llm-server list [--json]
mimo llm-server revoke <id> | --all
```

Run it in the same directory the server was launched from — a token is bound to a directory
(and to nothing else: not a session, not a pid, not a port).

- `--model` (repeatable, `provider/model`) restricts the token to those models. Without it
  the token reaches every configured model.
- `--ttl` is a sliding lifetime measured from last use (default `1d`); `--max-age` is an
  absolute ceiling from issue; both accept `30m` / `12h` / `7d` / `none`.
- `--json` prints `api_key`, `id`, `base_url`, `expires_at`, `models`, plus `renew_argv` /
  `renew_command` already resolved for this installation, so a consumer can recover from
  expiry without knowing how MiMoCode was invoked. `base_url` is `null` when nothing is
  serving this directory.
- Issuing repeatedly is normal: each call adds a token, so one consumer per token with its
  own scope, label and lifetime. `list` shows them all, `revoke <id>` removes one.
- The plaintext token is shown once; only its SHA-256 is stored.

## Endpoints

Base path `<base_url>/v1`. Auth is `Authorization: Bearer <token>`; `x-api-key` and `api-key`
are accepted too. These routes **always** authenticate with a minted token, independent of
`MIMOCODE_SERVER_PASSWORD`.

Model ids are always `providerID/modelID` — pass them through verbatim, never split.

| Endpoint | Shape |
| --- | --- |
| `GET /v1/models` | Lists the models this token can reach |
| `POST /v1/chat/completions` | OpenAI chat, incl. `input_audio` content parts; `stream:true` yields SSE ending in `[DONE]` |

Fields that cannot be honoured are **refused with 400 rather than ignored**, so a caller never
silently gets the wrong shape of answer: `response_format`, `n > 1`, `logprobs`,
`top_logprobs`, `logit_bias`, and `verbosity`. Unknown fields are ignored,
so a stock OpenAI client works by changing `base_url` alone. Provider-native knobs go in a
**flat** `provider_options` map keyed by the SDK's own camelCase option names.

## Error codes a consumer must distinguish

| Status | `error.code` | Meaning |
| --- | --- | --- |
| 401 | `expired_api_key` | Reissue and retry against the same base URL |
| 401 | `invalid_api_key` | Missing, invalid, or revoked — stop retrying |
| 400 | — | The request asked for something unsupported |
| 404 | `model_not_found` | No such model in this instance |
| 502 | — | The upstream provider failed, not MiMoCode |
