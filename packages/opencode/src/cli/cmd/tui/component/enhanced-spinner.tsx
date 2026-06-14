import { createSignal, createMemo, onMount, onCleanup, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useKV } from "../context/kv"
import type { JSX } from "@opentui/solid"
import type { RGBA } from "@opentui/core"
import "opentui-spinner/solid"

export type SpinnerStyle = "dots" | "line" | "pulse" | "wave" | "orbit" | "bounce"

const SPINNER_FRAMES: Record<SpinnerStyle, string[]> = {
  dots: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  line: ["-", "\\", "|", "/"],
  pulse: ["●", "○", "◉", "○"],
  wave: ["▁", "▃", "▅", "▇", "▅", "▃"],
  orbit: ["◉", "◎", "●", "○", "◉"],
  bounce: ["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"],
}

export function EnhancedSpinner(props: {
  children?: JSX.Element
  color?: RGBA
  style?: SpinnerStyle
  speed?: number
}) {
  const { theme } = useTheme()
  const kv = useKV()
  const animationsEnabled = () => kv.get("animations_enabled", true)
  const color = () => props.color ?? theme.textMuted
  const style = props.style ?? "dots"
  const speed = props.speed ?? 80

  const frames = SPINNER_FRAMES[style]

  return (
    <Show when={animationsEnabled()} fallback={<text fg={color()}>⋯ {props.children}</text>}>
      <box flexDirection="row" gap={1}>
        <spinner frames={frames} interval={speed} color={color()} />
        <Show when={props.children}>
          <text fg={color()}>{props.children}</text>
        </Show>
      </box>
    </Show>
  )
}

export function PulseSpinner(props: {
  children?: JSX.Element
  color?: RGBA
  speed?: number
}) {
  const { theme } = useTheme()
  const kv = useKV()
  const animationsEnabled = () => kv.get("animations_enabled", true)
  const color = () => props.color ?? theme.primary
  const speed = props.speed ?? 1000

  const [pulse, setPulse] = createSignal(0)
  let timer: ReturnType<typeof setInterval> | undefined

  onMount(() => {
    if (!animationsEnabled()) return
    timer = setInterval(() => {
      setPulse((prev) => (prev + 1) % 4)
    }, speed / 4)
  })

  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  const dots = createMemo(() => {
    return Array.from({ length: 4 }, (_, i) => {
      const distance = Math.abs(pulse() - i)
      const opacity = Math.max(0.2, 1 - distance * 0.25)
      return { opacity, char: "●" }
    })
  })

  return (
    <Show when={animationsEnabled()} fallback={<text fg={color()}>⋯ {props.children}</text>}>
      <box flexDirection="row" gap={0}>
        {dots().map((dot) => (
          <text fg={color()} opacity={dot.opacity}>
            {dot.char}
          </text>
        ))}
        <Show when={props.children}>
          <text fg={color()} paddingLeft={1}>{props.children}</text>
        </Show>
      </box>
    </Show>
  )
}

export function WaveSpinner(props: {
  children?: JSX.Element
  color?: RGBA
  speed?: number
  height?: number
}) {
  const { theme } = useTheme()
  const kv = useKV()
  const animationsEnabled = () => kv.get("animations_enabled", true)
  const color = () => props.color ?? theme.primary
  const speed = props.speed ?? 150
  const height = props.height ?? 3

  const [frame, setFrame] = createSignal(0)
  let timer: ReturnType<typeof setInterval> | undefined

  onMount(() => {
    if (!animationsEnabled()) return
    timer = setInterval(() => {
      setFrame((prev) => prev + 1)
    }, speed)
  })

  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  const bars = createMemo(() => {
    const t = frame()
    return Array.from({ length: 7 }, (_, i) => {
      const wave = Math.sin((t + i) * 0.5) * 0.5 + 0.5
      const barHeight = Math.ceil(wave * height)
      return {
        char: "█",
        height: barHeight,
        opacity: 0.3 + wave * 0.7,
      }
    })
  })

  return (
    <Show when={animationsEnabled()} fallback={<text fg={color()}>⋯ {props.children}</text>}>
      <box flexDirection="row" gap={0}>
        {bars().map((bar) => (
          <box flexDirection="column">
            {Array.from({ length: bar.height }, () => (
              <text fg={color()} opacity={bar.opacity}>
                {bar.char}
              </text>
            ))}
          </box>
        ))}
        <Show when={props.children}>
          <text fg={color()} paddingLeft={1}>{props.children}</text>
        </Show>
      </box>
    </Show>
  )
}

export function OrbitSpinner(props: {
  children?: JSX.Element
  color?: RGBA
  speed?: number
}) {
  const { theme } = useTheme()
  const kv = useKV()
  const animationsEnabled = () => kv.get("animations_enabled", true)
  const color = () => props.color ?? theme.primary
  const speed = props.speed ?? 100

  const [angle, setAngle] = createSignal(0)
  let timer: ReturnType<typeof setInterval> | undefined

  onMount(() => {
    if (!animationsEnabled()) return
    timer = setInterval(() => {
      setAngle((prev) => (prev + 1) % 8)
    }, speed)
  })

  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  const orbitChars = ["◉", "◎", "●", "○", "◉", "◎", "●", "○"]
  const trailLength = 3

  return (
    <Show when={animationsEnabled()} fallback={<text fg={color()}>⋯ {props.children}</text>}>
      <box flexDirection="row" gap={0}>
        {Array.from({ length: trailLength + 1 }, (_, i) => {
          const pos = (angle() - i + 8) % 8
          const opacity = i === 0 ? 1 : Math.max(0.2, 1 - i * 0.25)
          return (
            <text fg={color()} opacity={opacity}>
              {orbitChars[pos]}
            </text>
          )
        })}
        <Show when={props.children}>
          <text fg={color()} paddingLeft={1}>{props.children}</text>
        </Show>
      </box>
    </Show>
  )
}

export function BounceSpinner(props: {
  children?: JSX.Element
  color?: RGBA
  speed?: number
}) {
  const { theme } = useTheme()
  const kv = useKV()
  const animationsEnabled = () => kv.get("animations_enabled", true)
  const color = () => props.color ?? theme.primary
  const speed = props.speed ?? 120

  const [bounce, setBounce] = createSignal(0)
  let timer: ReturnType<typeof setInterval> | undefined

  onMount(() => {
    if (!animationsEnabled()) return
    timer = setInterval(() => {
      setBounce((prev) => (prev + 1) % 4)
    }, speed)
  })

  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  const bounceChars = ["⠁", "⠂", "⠄", "⡀"]

  return (
    <Show when={animationsEnabled()} fallback={<text fg={color()}>⋯ {props.children}</text>}>
      <box flexDirection="row" gap={0}>
        {Array.from({ length: 4 }, (_, i) => {
          const pos = (bounce() + i) % 4
          const opacity = i === 0 ? 1 : Math.max(0.3, 1 - i * 0.2)
          return (
            <text fg={color()} opacity={opacity}>
              {bounceChars[pos]}
            </text>
          )
        })}
        <Show when={props.children}>
          <text fg={color()} paddingLeft={1}>{props.children}</text>
        </Show>
      </box>
    </Show>
  )
}
