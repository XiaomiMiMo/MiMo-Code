import { createSignal, For, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useLanguage } from "../context/language"
import { EnhancedSpinner, WaveSpinner, OrbitSpinner, BounceSpinner } from "./enhanced-spinner"
import { TypingIndicator, ProgressBar, PulseGlow, SlideIn, MessageAppear } from "./message-appear"
import { FloatingDots } from "./ripple"
import { MatrixRain, ParticleSystem, GlitchEffect, TypewriterText } from "./effects"
import { useAnimationConfig } from "./animation-config"

export function AnimationShowcase() {
  const { theme } = useTheme()
  const t = useLanguage().t
  const [config] = useAnimationConfig()
  const [activeTab, setActiveTab] = createSignal<"spinners" | "effects" | "transitions" | "particles">("spinners")
  const [demoProgress, setDemoProgress] = createSignal(0)

  const tabs = [
    { id: "spinners" as const, label: "Spinners" },
    { id: "effects" as const, label: "Effects" },
    { id: "transitions" as const, label: "Transitions" },
    { id: "particles" as const, label: "Particles" },
  ]

  return (
    <box flexDirection="column" gap={1} padding={1}>
      <text fg={theme.text} bold>
        Animation Showcase
      </text>

      <box flexDirection="row" gap={1} marginBottom={1}>
        <For each={tabs}>
          {(tab) => (
            <text
              fg={activeTab() === tab.id ? theme.primary : theme.textMuted}
              onClick={() => setActiveTab(tab.id)}
              cursor="pointer"
            >
              {tab.label}
            </text>
          )}
        </For>
      </box>

      <Show when={activeTab() === "spinners"}>
        <box flexDirection="column" gap={2}>
          <text fg={theme.textMuted}>Spinners:</text>
          <box flexDirection="row" gap={2}>
            <EnhancedSpinner style="dots">Dots</EnhancedSpinner>
            <EnhancedSpinner style="line">Line</EnhancedSpinner>
            <EnhancedSpinner style="pulse">Pulse</EnhancedSpinner>
          </box>
          <box flexDirection="row" gap={2}>
            <WaveSpinner>Wave</WaveSpinner>
            <OrbitSpinner>Orbit</OrbitSpinner>
            <BounceSpinner>Bounce</BounceSpinner>
          </box>
        </box>
      </Show>

      <Show when={activeTab() === "effects"}>
        <box flexDirection="column" gap={2}>
          <text fg={theme.textMuted}>Effects:</text>
          <box flexDirection="row" gap={2}>
            <TypingIndicator />
            <PulseGlow>
              <text fg={theme.text}>Glow</text>
            </PulseGlow>
          </box>
          <ProgressBar progress={demoProgress} width={20} />
          <box flexDirection="row" gap={2}>
            <text
              fg={theme.primary}
              onClick={() => setDemoProgress((prev) => Math.min(1, prev + 0.1))}
            >
              +10%
            </text>
            <text
              fg={theme.error}
              onClick={() => setDemoProgress((prev) => Math.max(0, prev - 0.1))}
            >
              -10%
            </text>
          </box>
        </box>
      </Show>

      <Show when={activeTab() === "transitions"}>
        <box flexDirection="column" gap={2}>
          <text fg={theme.textMuted}>Transitions:</text>
          <SlideIn direction="right" duration={500}>
            <box backgroundColor={theme.backgroundPanel} padding={1}>
              <text fg={theme.text}>Slide In Right</text>
            </box>
          </SlideIn>
          <MessageAppear direction="up" delay={100}>
            <box backgroundColor={theme.backgroundPanel} padding={1}>
              <text fg={theme.text}>Message Appear</text>
            </box>
          </MessageAppear>
          <GlitchEffect intensity={0.1}>
            <text fg={theme.text}>Glitch Effect</text>
          </GlitchEffect>
          <TypewriterText text="Typewriter effect..." speed={50} />
        </box>
      </Show>

      <Show when={activeTab() === "particles"}>
        <box flexDirection="column" gap={2}>
          <text fg={theme.textMuted}>Particles:</text>
          <FloatingDots count={5} />
          <box height={5} width={30} position="relative">
            <ParticleSystem count={10} enabled={config().particles} />
          </box>
          <box height={5} width={30} position="relative">
            <MatrixRain width={() => 30} height={() => 5} enabled={config().effects} />
          </box>
        </box>
      </Show>
    </box>
  )
}
