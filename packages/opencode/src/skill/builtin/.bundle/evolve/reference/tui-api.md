# TUI Plugin API Reference

## File Format

The module must **default-export an object with a `tui()` function** — a named
`export const tui` will fail to load with "must default export an object with tui()".

```tsx
import type { TuiPlugin, TuiPluginModule } from "@mimo-ai/plugin/tui"

const tui: TuiPlugin = async (api, options, meta) => {
  // api — the full TUI plugin API
  // options — plugin options from config (if any)
  // meta — plugin metadata (id, source, version, etc.)
}

const plugin: TuiPluginModule & { id: string } = {
  id: "my-plugin",
  tui,
}

export default plugin
```

File extension should be `.tsx` (JSX support for UI components).

## How plugins load

Files are auto-discovered from two directories at TUI startup:

- `~/.config/mimocode/tui/*.{ts,tsx,js}` — global
- `<project>/.mimocode/tui/*.{ts,tsx,js}` — project-local

Plugins can also be declared in `tui.json` (global `~/.config/mimocode/tui.json`
or project `.mimocode/tui.json`) via the `plugin` array (file URLs or npm specs).
Either way, a **restart is required** — TUI plugins are only scanned at startup.

## Rendering model — opentui, NOT HTML

Components render to the **terminal** via opentui + Solid.js. HTML elements
(`<div>`, `<span style="css">`, CSS properties) do not exist. Use:

- `<box>` — flex container. Props: `flexDirection`, `gap`, `padding{Top,Bottom,Left,Right}`, `flexGrow`, `flexShrink`, `justifyContent`, `backgroundColor`
- `<text>` — text line. Props: `fg={color}`, event handlers like `onMouseDown`
- `<span style={{ fg: color }}>` — inline colored segment inside `<text>`
- `<b>` — bold text

Colors come from the theme: `api.theme.current.text`, `.textMuted`, `.primary`,
`.success`, etc. (RGBA values). Do not hard-code hex CSS strings.

Solid.js rules apply: no `useState`/`useEffect`; use `createMemo`, `createSignal`,
`<Show>`, and accessor functions (`const theme = () => api.theme.current`).

## TuiPluginApi

### api.command

Register commands in the command palette (Ctrl+K / Cmd+K).

```ts
const unregister = api.command.register(() => [
  {
    title: "Deploy to Staging",        // Display name
    value: "deploy-staging",           // Unique id
    description: "Run staging deploy", // Optional subtitle
    category: "Deploy",                // Optional grouping
    keybind: "ctrl+shift+d",           // Optional shortcut
    suggested: true,                   // Pin to top
    hidden: false,                     // Show/hide
    enabled: true,                     // Greyed out if false
    onSelect: () => { /* action */ },
  },
])

api.command.trigger("deploy-staging")  // Programmatic trigger
api.command.show()                     // Open palette
```

### api.route

Register full-screen views (pages).

```tsx
api.route.register([
  {
    name: "my-dashboard",
    render: (input) => (
      <box>
        <text><b>Dashboard</b></text>
        <text>Params: {JSON.stringify(input.params)}</text>
      </box>
    ),
  },
])

api.route.navigate("my-dashboard", { filter: "active" })
api.route.current  // { name: "session", params: { sessionID: "..." } }
```

### api.slots

Inject content into predefined UI slots.

```tsx
api.slots.register({
  slots: {
    sidebar_footer: (props) => (
      <text>Session: {props.session_id}</text>
    ),
    home_bottom: () => (
      <box><text>Custom widget here</text></box>
    ),
  },
})
```

#### Available Slots

| Slot Name | Props | Where |
|-----------|-------|-------|
| `app` | `{}` | Root wrapper |
| `home_logo` | `{}` | Home screen logo |
| `home_prompt` | `{ workspace_id?, ref? }` | Home input |
| `home_prompt_right` | `{ workspace_id? }` | Right of home input |
| `home_bottom` | `{}` | Below home content |
| `home_footer` | `{}` | Home footer bar |
| `session_prompt` | `{ session_id, visible?, disabled?, on_submit?, ref? }` | Session input |
| `session_prompt_right` | `{ session_id }` | Right of session input |
| `sidebar_title` | `{ session_id, title, share_url? }` | Sidebar header |
| `sidebar_content` | `{ session_id }` | Sidebar body |
| `sidebar_footer` | `{ session_id }` | Sidebar footer |

### api.ui

Built-in dialog components and toast notifications.

```tsx
// Toast notification
api.ui.toast({
  variant: "success",  // "info" | "success" | "warning" | "error"
  title: "Done",
  message: "Deployment complete",
  duration: 3000,
})

// Dialog stack
api.ui.dialog.replace(() => (
  <api.ui.DialogConfirm
    title="Confirm"
    message="Are you sure?"
    onConfirm={() => api.ui.dialog.clear()}
    onCancel={() => api.ui.dialog.clear()}
  />
))

// Available dialog components:
// api.ui.Dialog — generic dialog wrapper
// api.ui.DialogAlert — alert with OK button
// api.ui.DialogConfirm — confirm with OK/Cancel
// api.ui.DialogPrompt — text input dialog
// api.ui.DialogSelect — list selection dialog
```

### api.state

Read-only access to application state.

```ts
api.state.config                        // Current config
api.state.provider                      // Available providers
api.state.path.directory                // Project directory
api.state.path.worktree                 // Git worktree
api.state.vcs?.branch                   // Current branch

api.state.session.count()               // Number of sessions
api.state.session.messages(sessionID)   // Messages in session
api.state.session.status(sessionID)     // Session status
api.state.session.diff(sessionID)       // Changed files
api.state.session.todo(sessionID)       // Todo items
api.state.session.task(sessionID)       // Tasks

api.state.lsp()                         // LSP server status
api.state.mcp()                         // MCP server status
```

### api.theme

Theme access and management.

```ts
api.theme.current           // All current theme colors (RGBA)
api.theme.selected          // Theme name
api.theme.mode()            // "dark" | "light"
api.theme.set("monokai")   // Switch theme
api.theme.has("monokai")   // Check if installed
await api.theme.install("./themes/custom.json")  // Install from file
```

### api.keybind

Keyboard shortcut utilities.

```ts
api.keybind.match("submit", event)   // Check if key matches binding
api.keybind.print("submit")          // Human-readable "Ctrl+Enter"
const keys = api.keybind.create(
  { submit: "ctrl+enter", cancel: "escape" },
  overrides,
)
```

### api.client

SDK client for server communication.

```ts
// The full @mimo-ai/sdk client — same as what plugins get on server side
const sessions = await api.client.session.list()
const messages = await api.client.session.messages(sessionID)
```

### api.event

Subscribe to server-side events (SSE).

```ts
const unsub = api.event.on("session.updated", (event) => {
  console.log("Session changed:", event.properties)
})
```

### api.kv

Persistent key-value storage (survives restarts).

```ts
api.kv.set("my-plugin.lastRun", Date.now())
const last = api.kv.get<number>("my-plugin.lastRun", 0)
```

### api.lifecycle

Plugin lifecycle management.

```ts
api.lifecycle.signal  // AbortSignal — fired when plugin is deactivated
api.lifecycle.onDispose(() => {
  // Cleanup: close connections, remove listeners, etc.
})
```

## Complete Example

```tsx
import type { TuiPlugin, TuiPluginModule } from "@mimo-ai/plugin/tui"

const tui: TuiPlugin = async (api) => {
  // Register a command
  api.command.register(() => [
    {
      title: "Show Project Stats",
      value: "project-stats",
      category: "Info",
      onSelect: () => {
        api.ui.toast({
          variant: "info",
          message: `Sessions: ${api.state.session.count()}, Branch: ${api.state.vcs?.branch ?? "unknown"}`,
        })
      },
    },
  ])

  // Add sidebar footer content
  api.slots.register({
    slots: {
      sidebar_footer: (props) => {
        const theme = () => api.theme.current
        const status = () => api.state.session.status(props.session_id)
        return <text fg={theme().textMuted}>{status() ?? "idle"}</text>
      },
    },
  })

  // Cleanup on deactivate
  api.lifecycle.onDispose(() => {
    console.log("Plugin deactivated")
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "project-stats",
  tui,
}

export default plugin
```

## Constraints

- TUI plugins need a restart to take effect (scanned only at TUI startup)
- Use `.tsx` extension for JSX support
- Components use Solid.js JSX with opentui terminal elements (`<box>`, `<text>`, `<span>`, `<b>`) — no React hooks, no HTML/CSS
- Keep plugins lightweight — they run in the main rendering thread
