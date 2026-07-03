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

## Notes

- Rules are evaluated in your original insertion order and **the last matching rule wins**. Put the `*` catch-all **first** and more specific patterns after it — a `*` placed last would shadow everything above it (e.g. a trailing `"*": "ask"` makes preceding `allow`/`deny` rules dead code).
- `external_directory` governs reads/writes outside the project working directory — by default these prompt, so MiMoCode never silently widens scope.
- Permissions cannot be modified by custom tools/hooks — they are the one system the self-extension surface can't override.
