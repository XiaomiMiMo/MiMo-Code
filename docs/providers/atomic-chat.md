# Atomic Chat

[Atomic Chat](https://atomic.chat) runs local LLMs behind an OpenAI-compatible API at `http://127.0.0.1:1337/v1`.

MiMoCode loads the `atomic-chat` provider from [models.dev](https://models.dev) automatically. No custom provider wiring is required unless you want to override the base URL or model list.

## Quick setup

1. Install and launch [Atomic Chat](https://atomic.chat) (macOS Apple Silicon).
2. Download or load a model in the app.
3. Confirm the API is up: `curl http://127.0.0.1:1337/v1/models`
4. In MiMoCode TUI or desktop app, connect **Atomic Chat** as a provider.
5. Select a model (for example `atomic-chat/<model-id>`).

API keys are optional for local use. Leave `ATOMIC_CHAT_API_KEY` unset unless your setup requires one.

## Optional config override

Project config: `.mimocode/mimocode.json`  
Global config: `~/.config/mimocode/mimocode.json`

See [examples/mimocode.atomic-chat.jsonc](../examples/mimocode.atomic-chat.jsonc) for a minimal override that points at the default local endpoint and declares a model loaded in Atomic Chat.

## Tips

- Prefer capable coding models for agent workflows with tool calls.
- If context is tight, use a smaller model or reduce task scope.
- Model IDs must match those returned by `GET /v1/models` in Atomic Chat.

## Links

- [Atomic Chat website](https://atomic.chat)
- [Atomic Chat GitHub](https://github.com/AtomicBot-ai/Atomic-Chat)
