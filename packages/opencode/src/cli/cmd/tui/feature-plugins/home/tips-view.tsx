import { createEffect, createMemo, createSignal, For, onCleanup } from "solid-js"
import { DEFAULT_THEMES, useTheme } from "@tui/context/theme"
import { useLanguage } from "@tui/context/language"
import { useLocal } from "@tui/context/local"
import { useSync } from "@tui/context/sync"
import { Flag } from "@/flag/flag"
import { createFreeApiSunsetSignal } from "@tui/util/free-api-sunset"

const themeCount = Object.keys(DEFAULT_THEMES).length
const TIP_ROTATION_MS = 10_000
const COMPOSE_LOCK_TIP = "tui.tips.compose_next"

// Weighted tip priority. Higher weight = shown more often.
// Promote recently-added or critical features so users discover them.
// Tips not listed here use the default weight of 1.
const PRIORITY_WEIGHTS: Record<string, number> = {
  "tui.tips.ask_slash_commands": 70,
  "tui.tips.multi_skills": 60,
  "tui.tips.free_models": 50,
  "tui.tips.free_api_sunset": 50,
  "tui.tips.background": 50,
  "tui.tips.vivid": 40,
  "tui.tips.login": 40,
  "tui.tips.theme_mode": 40,
  "tui.tips.tab_agent": 40,
  "tui.tips.tab_agent_orchestrator": 40,
  "tui.tips.doc": 30,
  "tui.tips.models": 30,
  "tui.tips.connect": 30,
}

const TIP_KEYS = [
  "tui.tips.ask_slash_commands",
  "tui.tips.multi_skills",
  "tui.tips.free_models",
  "tui.tips.background",
  "tui.tips.vivid",
  "tui.tips.theme_mode",
  "tui.tips.doc",
  "tui.tips.attach_file",
  "tui.tips.shell_prefix",
  "tui.tips.undo",
  "tui.tips.redo",
  "tui.tips.drag_drop",
  "tui.tips.paste_image",
  "tui.tips.editor",
  "tui.tips.init",
  "tui.tips.models",
  "tui.tips.theme",
  "tui.tips.new_session",
  "tui.tips.sessions",
  "tui.tips.compact",
  "tui.tips.export",
  "tui.tips.copy_last",
  "tui.tips.command_palette",
  "tui.tips.login",
  "tui.tips.connect",
  "tui.tips.leader",
  "tui.tips.f2",
  "tui.tips.sidebar",
  "tui.tips.history",
  "tui.tips.jump_first",
  "tui.tips.jump_last",
  "tui.tips.newline",
  "tui.tips.clear_input",
  "tui.tips.escape",
  "tui.tips.plan_agent",
  "tui.tips.subagent",
  "tui.tips.cycle_sessions",
  "tui.tips.config_files",
  "tui.tips.global_config",
  "tui.tips.schema",
  "tui.tips.default_model",
  "tui.tips.keybinds",
  "tui.tips.disable_keybind",
  "tui.tips.mcp_config",
  "tui.tips.mcp_oauth",
  "tui.tips.custom_command",
  "tui.tips.command_args",
  "tui.tips.command_backticks",
  "tui.tips.custom_agent",
  "tui.tips.agent_perms",
  "tui.tips.bash_allow",
  "tui.tips.bash_deny",
  "tui.tips.bash_ask",
  "tui.tips.formatter",
  "tui.tips.disable_formatter",
  "tui.tips.custom_formatter",
  "tui.tips.lsp",
  "tui.tips.custom_tool",
  "tui.tips.tool_scripts",
  "tui.tips.plugins",
  "tui.tips.plugin_notify",
  "tui.tips.plugin_protect",
  "tui.tips.run",
  "tui.tips.continue",
  "tui.tips.attach_cli",
  "tui.tips.format_json",
  "tui.tips.serve",
  "tui.tips.attach_server",
  "tui.tips.upgrade",
  "tui.tips.auth_list",
  "tui.tips.agent_create",
  "tui.tips.github_install",
  "tui.tips.github_oc",
  "tui.tips.theme_system",
  "tui.tips.theme_files",
  "tui.tips.theme_variants",
  "tui.tips.theme_ansi",
  "tui.tips.env_var",
  "tui.tips.file_var",
  "tui.tips.instructions",
  "tui.tips.temperature",
  "tui.tips.steps",
  "tui.tips.disable_tool",
  "tui.tips.disable_mcp_tools",
  "tui.tips.tool_override",
  "tui.tips.share_auto",
  "tui.tips.share_disabled",
  "tui.tips.unshare",
  "tui.tips.doom_loop",
  "tui.tips.external_dir",
  "tui.tips.debug_config",
  "tui.tips.print_logs",
  "tui.tips.timeline",
  "tui.tips.toggle_code",
  "tui.tips.status",
  "tui.tips.scroll_accel",
  "tui.tips.username_toggle",
  "tui.tips.zen",
  "tui.tips.agents_md",
  "tui.tips.review",
  "tui.tips.help",
  "tui.tips.rename",
] as const

export function tipWeight(key: string) {
  return PRIORITY_WEIGHTS[key] ?? 1
}

// Build the tip key pool. The Tab-cycle tip mentions the Orchestrator agent
// only when the experiment is enabled; otherwise use the variant without it so
// we never point users at an agent that isn't reachable. The platform-specific
// suspend tip is always appended last.
export function buildTipKeys(
  orchestratorEnabled: boolean,
  platform: NodeJS.Platform,
  freeApiSunset = false,
  xiaomiAuthenticated = false,
): readonly string[] {
  const tabAgentKey = orchestratorEnabled ? "tui.tips.tab_agent_orchestrator" : "tui.tips.tab_agent"
  const suspendKey = platform === "win32" ? "tui.tips.suspend.win" : "tui.tips.suspend.unix"
  return [
    ...TIP_KEYS.filter((key) => !freeApiSunset || key !== "tui.tips.free_models"),
    ...(freeApiSunset && !xiaomiAuthenticated ? ["tui.tips.free_api_sunset"] : []),
    tabAgentKey,
    suspendKey,
  ]
}

type TipPart = { text: string; highlight: boolean }

function parse(tip: string): TipPart[] {
  const parts: TipPart[] = []
  const regex = /\{highlight\}(.*?)\{\/highlight\}/g
  const found = Array.from(tip.matchAll(regex))
  const state = found.reduce(
    (acc, match) => {
      const start = match.index ?? 0
      if (start > acc.index) {
        acc.parts.push({ text: tip.slice(acc.index, start), highlight: false })
      }
      acc.parts.push({ text: match[1], highlight: true })
      acc.index = start + match[0].length
      return acc
    },
    { parts, index: 0 },
  )

  if (state.index < tip.length) {
    parts.push({ text: tip.slice(state.index), highlight: false })
  }

  return parts
}

function pickWeighted(keys: readonly string[]): string {
  const weights = keys.map(tipWeight)
  const total = weights.reduce((a, b) => a + b, 0)
  let target = Math.random() * total
  for (let i = 0; i < keys.length; i++) {
    target -= weights[i]
    if (target < 0) return keys[i]
  }
  return keys[keys.length - 1]
}

export function Tips() {
  const theme = useTheme().theme
  const lang = useLanguage()
  const local = useLocal()
  const sync = useSync()
  const freeApiSunset = createFreeApiSunsetSignal()
  const allKeys = createMemo(() =>
    buildTipKeys(
      Flag.MIMOCODE_EXPERIMENTAL_ORCHESTRATOR,
      process.platform,
      freeApiSunset(),
      sync.data.provider_next.authenticated.includes("xiaomi"),
    ),
  )
  const [key, setKey] = createSignal(pickWeighted(allKeys()))
  createEffect(() => {
    if (allKeys().includes(key())) return
    setKey(pickWeighted(allKeys()))
  })
  const interval = setInterval(() => setKey(pickWeighted(allKeys())), TIP_ROTATION_MS)
  onCleanup(() => clearInterval(interval))
  // Display override: while the current agent is Compose, show the compose-next
  // deprecation tip in place of whatever the rotation currently holds. The
  // rotation keeps running underneath; leaving Compose reveals the current
  // rotation key with no artificial swap.
  const displayKey = createMemo(() => (local.agent.current()?.name === "compose" ? COMPOSE_LOCK_TIP : key()))
  const parts = createMemo(() => parse(lang.t(displayKey(), { count: themeCount })))
  const labelColor = createMemo(() => {
    const agent = local.agent.current()
    return agent ? local.agent.color(agent.name) : theme.warning
  })

  return (
    <box flexDirection="row" maxWidth="100%">
      <text flexShrink={0} style={{ fg: labelColor() }}>
        ● {lang.t("tui.tips.label")}{" "}
      </text>
      <text flexShrink={1}>
        <For each={parts()}>
          {(part) => <span style={{ fg: part.highlight ? theme.text : theme.textMuted }}>{part.text}</span>}
        </For>
      </text>
    </box>
  )
}
