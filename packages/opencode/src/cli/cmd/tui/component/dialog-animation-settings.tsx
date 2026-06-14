import { createSignal, For } from "solid-js"
import { useTheme } from "../context/theme"
import { useKV } from "../context/kv"
import { useLanguage } from "../context/language"
import { useDialog } from "../ui/dialog"
import { useAnimationConfig } from "./animation-config"
import { getAnimationThemes, type AnimationTheme } from "../config/animation-themes"

export function DialogAnimationSettings() {
  const { theme } = useTheme()
  const kv = useKV()
  const t = useLanguage().t
  const dialog = useDialog()
  const [config, setConfig] = useAnimationConfig()
  const [selectedTheme, setSelectedTheme] = createSignal<string>("balanced")
  const themes = getAnimationThemes()

  const toggleEnabled = () => {
    setConfig({ enabled: !config().enabled })
  }

  const toggleReducedMotion = () => {
    setConfig({ reducedMotion: !config().reducedMotion })
  }

  const toggleParticles = () => {
    setConfig({ particles: !config().particles })
  }

  const toggleTransitions = () => {
    setConfig({ transitions: !config().transitions })
  }

  const toggleEffects = () => {
    setConfig({ effects: !config().effects })
  }

  const cyclePerformance = () => {
    const current = config().performance
    const next = current === "low" ? "medium" : current === "medium" ? "high" : "low"
    setConfig({ performance: next })
  }

  const selectTheme = (theme: AnimationTheme) => {
    setSelectedTheme(theme.name)
    setConfig({
      particles: theme.particles,
      transitions: theme.transitions,
      effects: theme.effects,
      intensity: theme.intensity,
    })
  }

  return (
    <box flexDirection="column" gap={1} padding={1} minWidth={40}>
      <text fg={theme.text} bold>
        Animation Settings
      </text>

      <box flexDirection="column" gap={1} marginTop={1}>
        <text fg={theme.textMuted} marginBottom={1}>
          Quick Settings:
        </text>

        <box flexDirection="row" gap={1}>
          <text fg={theme.text}>Enable animations:</text>
          <text
            fg={config().enabled ? theme.success : theme.error}
            onClick={toggleEnabled}
            cursor="pointer"
          >
            {config().enabled ? "ON" : "OFF"}
          </text>
        </box>

        <box flexDirection="row" gap={1}>
          <text fg={theme.text}>Reduced motion:</text>
          <text
            fg={config().reducedMotion ? theme.warning : theme.text}
            onClick={toggleReducedMotion}
            cursor="pointer"
          >
            {config().reducedMotion ? "ON" : "OFF"}
          </text>
        </box>

        <box flexDirection="row" gap={1}>
          <text fg={theme.text}>Particles:</text>
          <text
            fg={config().particles ? theme.success : theme.error}
            onClick={toggleParticles}
            cursor="pointer"
          >
            {config().particles ? "ON" : "OFF"}
          </text>
        </box>

        <box flexDirection="row" gap={1}>
          <text fg={theme.text}>Transitions:</text>
          <text
            fg={config().transitions ? theme.success : theme.error}
            onClick={toggleTransitions}
            cursor="pointer"
          >
            {config().transitions ? "ON" : "OFF"}
          </text>
        </box>

        <box flexDirection="row" gap={1}>
          <text fg={theme.text}>Effects:</text>
          <text
            fg={config().effects ? theme.success : theme.error}
            onClick={toggleEffects}
            cursor="pointer"
          >
            {config().effects ? "ON" : "OFF"}
          </text>
        </box>

        <box flexDirection="row" gap={1}>
          <text fg={theme.text}>Performance:</text>
          <text
            fg={theme.primary}
            onClick={cyclePerformance}
            cursor="pointer"
          >
            {config().performance.toUpperCase()}
          </text>
        </box>
      </box>

      <box flexDirection="column" gap={1} marginTop={1}>
        <text fg={theme.textMuted} marginBottom={1}>
          Animation Themes:
        </text>

        <For each={themes}>
          {(themeItem) => (
            <box
              flexDirection="row"
              gap={1}
              padding={1}
              backgroundColor={selectedTheme() === themeItem.name ? theme.backgroundElement : undefined}
              onClick={() => selectTheme(themeItem)}
              cursor="pointer"
            >
              <text
                fg={selectedTheme() === themeItem.name ? theme.primary : theme.text}
              >
                {selectedTheme() === themeItem.name ? "●" : "○"}
              </text>
              <text fg={theme.text}>{themeItem.name}</text>
              <text fg={theme.textMuted}>- {themeItem.description}</text>
            </box>
          )}
        </For>
      </box>

      <box flexDirection="row" gap={1} marginTop={1} justifyContent="flex-end">
        <text
          fg={theme.textMuted}
          onClick={() => dialog.clear()}
          cursor="pointer"
        >
          Close
        </text>
      </box>
    </box>
  )
}
