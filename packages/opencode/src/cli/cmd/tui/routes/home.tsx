import { Prompt, type PromptRef } from "@tui/component/prompt"
import { createEffect, createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import path from "path"
import { Logo } from "../component/logo"
import { logoThin, logos, type LogoKey } from "@/cli/logo"
import { BackgroundImage } from "../component/background-image"
import { StarryBackground } from "../component/starry-background"
import { BUILTIN_BGS, EFFECT_VALUES } from "../component/bg-registry"
import { SOLID_VALUE } from "../component/dialog-image-list"
import { useTheme } from "../context/theme"
import { useProject } from "../context/project"
import { useSync } from "../context/sync"
import { Toast } from "../ui/toast"
import { useArgs } from "../context/args"
import { useRouteData } from "@tui/context/route"
import { usePromptRef } from "../context/prompt"
import { useLocal } from "../context/local"
import { useKV } from "../context/kv"
import { useLanguage } from "@tui/context/language"
import { TuiPluginRuntime } from "../plugin"
import { Global } from "@/global"
import { isPlainTerminal } from "../util/terminal"

let once = false

export function Home() {
  const sync = useSync()
  const project = useProject()
  const route = useRouteData("home")
  const promptRef = usePromptRef()
  const [ref, setRef] = createSignal<PromptRef | undefined>()
  const args = useArgs()
  const local = useLocal()
  const kv = useKV()
  const t = useLanguage().t
  const { theme } = useTheme()
  const plainTerminal = isPlainTerminal()
  const bgImagePath = createMemo(() => {
    const filename = kv.get("background_image")
    if (!filename || typeof filename !== "string") return undefined
    if (filename === SOLID_VALUE || EFFECT_VALUES.has(filename)) return filename
    return path.join(Global.Path.config, "backgrounds", filename)
  })
  const logoKey = createMemo(() => {
    const key = kv.get("logo_design")
    return typeof key === "string" && key in logos ? (key as LogoKey) : "thin"
  })
  // 所有 logo 变体(含默认的 thin 纤细半块)都显示流星特效。
  const showMeteor = () => true
  const placeholder = {
    get normal() {
      return [
        t("tui.home.placeholder.example.todo"),
        t("tui.home.placeholder.example.stack"),
        t("tui.home.placeholder.example.tests"),
      ]
    },
    shell: ["ls -la", "git status", "pwd"],
  }
  let sent = false

  const bind = (r: PromptRef | undefined) => {
    setRef(r)
    promptRef.set(r)
    if (once || !r) return
    if (route.prompt) {
      r.set(route.prompt)
      once = true
      return
    }
    if (!args.prompt) return
    r.set({ input: args.prompt, parts: [] })
    once = true
  }

  // Wait for sync and model store to be ready before auto-submitting --prompt
  createEffect(() => {
    const r = ref()
    if (sent) return
    if (!r) return
    if (!sync.ready || !local.model.ready) return
    if (!args.prompt) return
    if (r.current.input !== args.prompt) return
    sent = true
    r.submit()
  })

  return (
    <>
      <Show when={!plainTerminal}>
        <Show when={bgImagePath() === SOLID_VALUE}>
          <box position="absolute" top={0} left={0} width="100%" height="100%" zIndex={0} backgroundColor={kv.get("background_color") ?? theme.background} />
        </Show>
        <For each={BUILTIN_BGS}>
          {(bg) => (
            <Show when={bgImagePath() === bg.value}>
              <bg.component />
            </Show>
          )}
        </For>
        <Show when={bgImagePath() !== undefined && bgImagePath() !== SOLID_VALUE && !EFFECT_VALUES.has(bgImagePath() as string)}>
          <BackgroundImage path={bgImagePath()!} />
        </Show>
        <Show when={!bgImagePath()}>
          <StarryBackground meteor={showMeteor} />
        </Show>
      </Show>
      <box flexGrow={1} alignItems="center" paddingLeft={8} paddingRight={8} zIndex={1}>
        <box flexGrow={1} minHeight={0} />
        <box height={4} minHeight={0} flexShrink={1} />
        <box flexShrink={0}>
          <Show
            when={plainTerminal}
            fallback={
              <TuiPluginRuntime.Slot name="home_logo" mode="replace">
                <Show when={logoKey()} keyed>
                  {(k) => <Logo shape={logos[k]} sweep />}
                </Show>
              </TuiPluginRuntime.Slot>
            }
          >
            <box flexDirection="column" flexShrink={0}>
              {logoThin.left.slice(2).map((line, index) => (
                <box flexDirection="row" gap={1} flexShrink={0}>
                  <text selectable={false}>{line}</text>
                  <text selectable={false}>{logoThin.right[index + 2] ?? ""}</text>
                </box>
              ))}
            </box>
          </Show>
        </box>
        <box height={1} minHeight={0} flexShrink={1} />
        <box
          width="100%"
          maxWidth={75}
          zIndex={1000}
          paddingTop={1}
          flexShrink={0}
        >
          <Show
            when={plainTerminal}
            fallback={
              <TuiPluginRuntime.Slot
                name="home_prompt"
                mode="replace"
                workspace_id={project.workspace.current()}
                ref={bind}
              >
                <Prompt
                  ref={bind}
                  workspaceID={project.workspace.current()}
                  right={<TuiPluginRuntime.Slot name="home_prompt_right" workspace_id={project.workspace.current()} />}
                  placeholders={placeholder}
                />
              </TuiPluginRuntime.Slot>
            }
          >
            <Prompt
              ref={bind}
              workspaceID={project.workspace.current()}
              placeholders={placeholder}
            />
          </Show>
        </box>
        <Show when={plainTerminal}>
          <box paddingTop={1} flexShrink={0}>
            <text selectable={false}>{t("tui.tips.plain_terminal")}</text>
          </box>
        </Show>
        <Show when={!plainTerminal}>
          <TuiPluginRuntime.Slot name="home_bottom" />
        </Show>
        <box flexGrow={1} minHeight={0} />
        <Toast />
      </box>
      <Show when={!plainTerminal}>
        <box width="100%" flexShrink={0}>
          <TuiPluginRuntime.Slot name="home_footer" mode="single_winner" />
        </box>
      </Show>
    </>
  )
}
