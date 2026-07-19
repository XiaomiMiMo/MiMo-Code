# MiMoCode Permissions Reference

Permissions gate what the agent may do without asking. Configure them under the top-level `permission` key.

## Actions

Every rule resolves to one of three actions:

| Action | Meaning |
|--------|---------|
| `allow` | Run without prompting |
| `ask` | Prompt the user for confirmation (default for risky ops) |
| `deny` | Block entirely |

## Two shapes

A permission rule is **either** a single action string, **or** a glob-keyed map of action strings (for tools whose argument is a path or command):

```jsonc
{
  "permission": {
    // whole-tool action
    "webfetch": "allow",
    // glob-keyed: match on the tool's path/command argument.
    // Later rules win, so put the catch-all FIRST and specifics after it.
    "bash": {
      "*": "ask",
      "git *": "allow",
      "rm -rf *": "deny"
    }
  }
}
```

A bare string at the top level (`"permission": "allow"`) becomes `{ "*": action }` — a blanket default for everything.

## Configurable tools

Path/command-keyed (accept the glob-map form): `read`, `edit`, `glob`, `grep`, `list`, `bash`, `task`, `actor`, `external_directory`, `lsp`, `skill`.

Simple action-only: `question`, `webfetch`, `websearch`, `codesearch`, `doom_loop`.

Unknown keys fall through to a catch-all record, so future/custom tools can be named too.

## Common recipes

Auto-allow read-only git and block destructive shell:
```jsonc
{ "permission": { "bash": { "git status": "allow", "git log *": "allow", "git diff *": "allow", "rm -rf *": "deny" } } }
```

Allow the system temp dir (opt-in; has known risks — temp is world-writable):
```jsonc
{ "permission": { "external_directory": { "/tmp/**": "allow" } } }
```

Ask before every file edit:
```jsonc
{ "permission": { "edit": "ask" } }
```

## Skipping permission prompts

For trusted, disposable environments (containers, sandboxes, CI) you can auto-approve everything the agent does.

| Surface | How |
|---------|-----|
| TUI (`mimo`) | `mimo --dangerously-skip-permissions` |
| Headless (`mimo run`) | `mimo run --dangerously-skip-permissions "<prompt>"` |
| Any surface (env) | `MIMOCODE_PERMISSION='"allow"'` or `MIMOCODE_DANGEROUSLY_SKIP_PERMISSIONS=1` |

Semantics: an **allow-all base is injected UNDER your config**, so a tool with *no* rule auto-approves. Because the injected `*: allow` sits before your rules and the last matching rule wins, **any explicit rule you wrote still takes precedence** — a `deny` blocks, and a leftover `ask` will still prompt. Two consequences worth knowing:

- A top-level catch-all like `"permission": { "*": "ask" }` makes the TUI/env form a no-op (your `*: ask` outranks the injected `*: allow`). Remove it, or use `mimo run --dangerously-skip-permissions`, which auto-replies at the event layer and overrides `ask` too.
- A tool disabled via the `tools` key (`"tools": { "codesearch": false }`) is re-enabled by allow-all, since that toggle is weaker than a real `permission` rule. Use `permission: { codesearch: "deny" }` if you need it to stay off.

In the TUI the flag is gated by a one-time red confirmation on startup (you must explicitly accept the risk); the prompt is skipped when there is no TTY, so in CI / piped-stdin the dangerous mode activates with no confirmation. This is dangerous — a malicious prompt, file, or plugin can then run arbitrary commands without confirmation. Only use it where you fully trust the workspace.

## Notes

- Rules are evaluated in your original insertion order and **the last matching rule wins**. Put the `*` catch-all **first** and more specific patterns after it — a `*` placed last would shadow everything above it (e.g. a trailing `"*": "ask"` makes preceding `allow`/`deny` rules dead code).
- `external_directory` governs reads/writes outside the project working directory — by default these prompt, so MiMoCode never silently widens scope.
- Permissions cannot be modified by custom tools/hooks — they are the one system the self-extension surface can't override.
