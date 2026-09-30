# MiMoCode Models and Providers

Read this reference whenever a request involves a provider, model, API key, base URL, authentication, or an OpenAI-/Anthropic-compatible endpoint.

## Sign-in options (TUI login dialog / `/connect`)

- **Xiaomi MiMo Platform** — OAuth device flow (recommended).
- **Codex (ChatGPT Pro/Plus)** — OpenAI OAuth login.
- **Import from Claude Code** — reads API keys from `~/.claude/settings*.json`.
- **xAI (Grok)** — OAuth login, provider id `xai`.
- **Other catalog providers** — API-key entry (e.g. OpenRouter), plus **+ Custom provider** for any OpenAI-compatible endpoint.

## Choose the target config

- Use `.mimocode/mimocode.jsonc` or `.mimocode/mimocode.json` only when the user explicitly wants project-local behavior.
- Otherwise use the global config directory (normally `~/.config/mimocode/`). Global files merge in this order: `config.json`, `mimocode.json`, then `mimocode.jsonc`; later files win. Edit the existing highest-precedence file, or create `mimocode.jsonc` when none exists.
- Inspect these exact candidates directly. Do not recursively glob or search the entire home directory.
- If both JSON and JSONC exist, account for the merged result before editing so a higher-precedence file cannot silently override the change.

## Custom OpenAI-compatible endpoint

Given a base URL, API key, and model ID, configure a provider that does not depend on the built-in catalog:

```jsonc
{
  "$schema": "https://mimo.xiaomi.com/mimocode/config.json",
  "model": "custom/MODEL_ID",
  "provider": {
    "custom": {
      "name": "Custom",
      "npm": "@ai-sdk/openai-compatible",
      "only_configured_models": true,
      "models": {
        "MODEL_ID": {
          "name": "MODEL_ID"
        }
      },
      "options": {
        "baseURL": "BASE_URL",
        "apiKey": "API_KEY"
      }
    }
  }
}
```

Use the exact package and camel-case field names shown above:

- `@ai-sdk/openai-compatible` is the adapter implemented and shipped by MiMoCode. Do not substitute `@ai-sdk/compatible-openai`.
- `baseURL` and `apiKey` are valid; `base_url`, `base-url`, and `api_key` are not.
- The key under `models` is the exact ID sent upstream. Preserve its case, punctuation, and `/` characters. `name` is only the display label.
- The top-level selection is `<provider-id>/<model-id>`. MiMoCode treats only the first `/` as the separator, so a model ID may contain `/`.
- Preserve the base URL exactly. Do not add, remove, or normalize `/v1` unless the user requests it.
- A non-OpenAI wire protocol needs its provider-specific adapter. A base URL, key, and model name do not by themselves change protocol semantics.

## Custom Anthropic-compatible endpoint

For a service that implements Anthropic's Messages API rather than OpenAI Chat Completions or Responses, use the native Anthropic adapter:

```jsonc
{
  "$schema": "https://mimo.xiaomi.com/mimocode/config.json",
  "model": "custom-anthropic/MODEL_ID",
  "provider": {
    "custom-anthropic": {
      "name": "Custom Anthropic",
      "npm": "@ai-sdk/anthropic",
      "only_configured_models": true,
      "models": {
        "MODEL_ID": {
          "name": "MODEL_ID"
        }
      },
      "options": {
        "baseURL": "BASE_URL",
        "apiKey": "API_KEY"
      }
    }
  }
}
```

MiMoCode ships `@ai-sdk/anthropic`; its SDK constructs Anthropic Messages API requests, including the Anthropic authentication/version headers and the `/messages` request path. Configure `baseURL` as the API base (commonly ending in `/v1`), not as the full `/v1/messages` endpoint, because the adapter appends `/messages`.

Choose the adapter from the endpoint's documented wire protocol, not the model name:

- Use `@ai-sdk/openai-compatible` for OpenAI-compatible Chat Completions/Responses, even when the upstream model ID contains `claude`.
- Use `@ai-sdk/anthropic` when the endpoint implements Anthropic Messages semantics such as `POST /v1/messages`, `x-api-key`, and `anthropic-version`.
- If the user explicitly states the format, follow it. If they provide only a URL, key, and Claude-like model name, do not infer the protocol from the name; inspect authoritative endpoint documentation or ask which API format it implements.
- Do not add OpenAI-only settings to an Anthropic provider or Anthropic-only headers to an OpenAI-compatible provider unless the gateway documentation requires them.

## Reuse or create a provider

Provider options, including credentials and base URL, are shared by every model under that provider. Choose deliberately:

- Reuse a provider and append the model when its endpoint and credential already match.
- If the endpoint matches but the supplied credential differs, create a distinct provider ID unless the user explicitly wants to rotate the existing provider's key. Overwriting it would silently change every existing model under that provider.
- If the desired provider ID already exists with different options, choose an unused short lowercase ID or a meaningful suffixed ID. Update `model` and allowlists consistently.
- If `enabled_providers` is present, add the new provider ID. If `disabled_providers` contains it and the user wants to use the model, remove only that entry.
- Set the top-level `model` when the user says configure, use, select, switch, or make default. When the user only asks to add/register a model, preserve the current selection.

## Do not invent model metadata

The model's display name is enough to register it. Do not guess `limit.context`, `limit.output`, `reasoning`, `tool_call`, `modalities`, cost, or other capabilities from the model name. Internal routers often expose aliases whose behavior differs from similarly named public models.

Add optional metadata only when the user supplied it or a current authoritative source verifies it. If limits are important but unknown, omit them and state that they remain unspecified; MiMoCode will apply its runtime fallback and log a warning for an unknown context window.

For input modalities specifically, the user can set them in the TUI with `/modalities` (multi-select image/audio/video/pdf; persists to `provider.<id>.models.<id>.modalities` in global config) — prefer pointing them there over hand-editing.

## Credential handling

- Treat any API key as a secret even when the user pasted it into the prompt. Never repeat it in commentary, tool summaries, diffs, or the final response.
- Avoid printing an unredacted config because it may contain unrelated credentials. Inspect with sensitive values masked and make the smallest possible edit.
- Direct `options.apiKey` storage is supported when the user asks MiMoCode to persist the supplied key. Keep the config user-readable only where file modes are available.
- If the user prefers not to store plaintext, use a config token such as `"apiKey": "{env:CUSTOM_API_KEY}"` and explain that the variable must exist in the MiMoCode process environment. Do not silently switch to an environment reference when the user asked for a ready-to-use persisted configuration.
- If a real key was posted in a conversation or log, recommend rotating it after completing the requested setup.

## Keep a newly configured model in TUI recents

When the user supplies a new API key and model to configure, update the TUI recent-model state after the provider config validates. Do this whether the request makes the model the default or only registers it: the recent entry is what makes the model immediately available to the TUI model-cycle shortcut.

The state file is `model.json` under MiMoCode's state directory:

- With a non-empty absolute `MIMOCODE_HOME`: `$MIMOCODE_HOME/state/model.json`.
- Otherwise: the XDG state directory for MiMoCode, normally `~/.local/state/mimocode/model.json` on Linux and macOS. Respect `XDG_STATE_HOME` when it is set.

Read the existing JSON object first. Preserve every top-level field, especially `favorite` and `variant`. Prepend the configured model to `recent`, remove any later entry with the same `providerID` and `modelID`, preserve the order of all other entries, and keep at most 10 entries:

```json
{
  "recent": [
    { "providerID": "custom", "modelID": "MODEL_ID" }
  ],
  "favorite": [],
  "variant": {}
}
```

The snippet illustrates the shape; it is not permission to reset existing fields. If the file does not exist, create it with the new `recent` entry plus empty `favorite` and `variant` values. If it contains malformed JSON, do not overwrite it silently: preserve or back it up before repairing it. Never put the API key, base URL, display name, or combined `provider/model` string in a recent entry.

Write the recent state only after `mimo models PROVIDER_ID` confirms that the exact model is registered. An already-running TUI may have loaded the old state and can overwrite an external edit, so tell the user to close or restart that TUI before relying on the updated shortcut.

## Minimal edit and verification

Preserve JSONC comments, `$schema`, unrelated providers, models, and settings. Avoid whole-file rewrites when a targeted insertion is possible.

Do not make a paid or state-changing API request merely to verify configuration. Validate locally from the same working directory in which the user will run MiMoCode:

```sh
mimo models PROVIDER_ID
```

Confirm that the output contains exactly `PROVIDER_ID/MODEL_ID`. This proves the config parsed and the provider/model registered; it does not prove the remote credential, endpoint, or selected wire protocol works. If the current TUI session already pinned a model, reselect it or start a new session after the edit.

In the final response, name the config file and recent-model state file, identify the selected `provider/model`, state whether it was added or made default, and report local validation. Never include the key.
