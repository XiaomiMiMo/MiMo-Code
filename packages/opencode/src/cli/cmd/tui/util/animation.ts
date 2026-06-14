import { createSignal, onCleanup, onMount } from "solid-js"
import { RGBA } from "@opentui/core"

export type EasingFunction = (t: number) => number

export const easing = {
  linear: (t: number) => t,
  easeInQuad: (t: number) => t * t,
  easeOutQuad: (t: number) => t * (2 - t),
  easeInOutQuad: (t: number) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  easeInCubic: (t: number) => t * t * t,
  easeOutCubic: (t: number) => (t - 1) * (t - 1) * (t - 1) + 1,
  easeInOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1),
  easeOutBack: (t: number) => {
    const c1 = 1.70158
    const c3 = c1 + 1
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
  },
  easeOutElastic: (t: number) => {
    if (t === 0 || t === 1) return t
    const c4 = (2 * Math.PI) / 3
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1
  },
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t))
}

export function lerpColor(a: RGBA, b: RGBA, t: number): RGBA {
  const clamp = Math.max(0, Math.min(1, t))
  return RGBA.fromInts(
    Math.round(lerp(a.r ?? 0, b.r ?? 0, clamp)),
    Math.round(lerp(a.g ?? 0, b.g ?? 0, clamp)),
    Math.round(lerp(a.b ?? 0, b.b ?? 0, clamp)),
    Math.round(lerp(a.a ?? 255, b.a ?? 255, clamp)),
  )
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function remap(value: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  return outMin + ((value - inMin) / (inMax - inMin)) * (outMax - outMin)
}

export function pingPong(t: number, length: number): number {
  const mod = t % (length * 2)
  return mod < length ? mod : length * 2 - mod
}

export function createTimer(callback: () => void, interval: number, immediate = false) {
  let timer: ReturnType<typeof setInterval> | undefined
  let mounted = false

  const start = () => {
    if (timer || !mounted) return
    if (immediate) callback()
    timer = setInterval(callback, interval)
  }

  const stop = () => {
    if (timer) {
      clearInterval(timer)
      timer = undefined
    }
  }

  onMount(() => {
    mounted = true
    start()
  })

  onCleanup(() => {
    mounted = false
    stop()
  })

  return { start, stop }
}

export function useAnimationFrame(callback: (dt: number) => void) {
  let frame: number | undefined
  let lastTime = 0
  let mounted = false

  const tick = (time: number) => {
    if (!mounted) return
    const dt = lastTime ? time - lastTime : 16
    lastTime = time
    callback(dt)
    frame = requestAnimationFrame(tick)
  }

  onMount(() => {
    mounted = true
    frame = requestAnimationFrame(tick)
  })

  onCleanup(() => {
    mounted = false
    if (frame) cancelAnimationFrame(frame)
  })
}

export function createPulseSignal(
  options: {
    period?: number
    min?: number
    max?: number
    easing?: EasingFunction
  } = {},
) {
  const period = options.period ?? 1000
  const min = options.min ?? 0
  const max = options.max ?? 1
  const ease = options.easing ?? easing.linear

  const [value, setValue] = createSignal(0)

  useAnimationFrame(() => {
    const t = (performance.now() % period) / period
    setValue(lerp(min, max, ease(t)))
  })

  return value
}

export function createBreathSignal(
  options: {
    period?: number
    min?: number
    max?: number
    holdTime?: number
  } = {},
) {
  const period = options.period ?? 4000
  const min = options.min ?? 0.3
  const max = options.max ?? 1
  const holdTime = options.holdTime ?? 0.1

  const [value, setValue] = createSignal(min)

  useAnimationFrame(() => {
    const t = (performance.now() % period) / period
    const cycle = t * 2
    let v: number
    if (cycle < 1) {
      v = lerp(min, max, easing.easeInOutCubic(cycle))
    } else {
      v = lerp(max, min, easing.easeInOutCubic(cycle - 1))
    }
    setValue(v)
  })

  return value
}

export function createWaveSignal(
  options: {
    period?: number
    min?: number
    max?: number
    phase?: number
  } = {},
) {
  const period = options.period ?? 2000
  const min = options.min ?? 0
  const max = options.max ?? 1
  const phase = options.phase ?? 0

  const [value, setValue] = createSignal(0)

  useAnimationFrame(() => {
    const t = (performance.now() + phase) % period / period
    const v = min + (max - min) * (0.5 + 0.5 * Math.sin(t * Math.PI * 2))
    setValue(v)
  })

  return value
}

export function createFadeSignal(
  options: {
    duration?: number
    delay?: number
    from?: number
    to?: number
    easing?: EasingFunction
    autoStart?: boolean
  } = {},
) {
  const duration = options.duration ?? 300
  const delay = options.delay ?? 0
  const from = options.from ?? 0
  const to = options.to ?? 1
  const ease = options.easing ?? easing.easeOutQuad

  const [progress, setProgress] = createSignal(from)
  const [running, setRunning] = createSignal(false)
  let startTime = 0
  let frame: number | undefined
  let mounted = false

  const animate = (direction: "in" | "out") => {
    if (frame) cancelAnimationFrame(frame)
    startTime = performance.now() + delay
    setRunning(true)

    const tick = (time: number) => {
      if (!mounted) return
      const elapsed = time - startTime
      if (elapsed < 0) {
        frame = requestAnimationFrame(tick)
        return
      }
      const t = Math.min(1, elapsed / duration)
      const easedT = ease(t)
      setProgress(direction === "in" ? lerp(from, to, easedT) : lerp(to, from, easedT))
      if (t < 1) {
        frame = requestAnimationFrame(tick)
      } else {
        setRunning(false)
      }
    }

    frame = requestAnimationFrame(tick)
  }

  const fadeIn = () => animate("in")
  const fadeOut = () => animate("out")

  onMount(() => {
    mounted = true
    if (options.autoStart !== false) fadeIn()
  })

  onCleanup(() => {
    mounted = false
    if (frame) cancelAnimationFrame(frame)
  })

  return { progress, running, fadeIn, fadeOut }
}

export function createSlideSignal(
  options: {
    duration?: number
    delay?: number
    from?: number
    to?: number
    easing?: EasingFunction
    direction?: "left" | "right" | "up" | "down"
  } = {},
) {
  const duration = options.duration ?? 300
  const delay = options.delay ?? 0
  const from = options.from ?? 0
  const to = options.to ?? 1
  const ease = options.easing ?? easing.easeOutCubic
  const direction = options.direction ?? "right"

  const [progress, setProgress] = createSignal(from)
  const [running, setRunning] = createSignal(false)
  let startTime = 0
  let frame: number | undefined
  let mounted = false

  const animate = (target: number) => {
    if (frame) cancelAnimationFrame(frame)
    startTime = performance.now() + delay
    setRunning(true)
    const startValue = progress()

    const tick = (time: number) => {
      if (!mounted) return
      const elapsed = time - startTime
      if (elapsed < 0) {
        frame = requestAnimationFrame(tick)
        return
      }
      const t = Math.min(1, elapsed / duration)
      const easedT = ease(t)
      setProgress(lerp(startValue, target, easedT))
      if (t < 1) {
        frame = requestAnimationFrame(tick)
      } else {
        setRunning(false)
      }
    }

    frame = requestAnimationFrame(tick)
  }

  const slideIn = () => animate(to)
  const slideOut = () => animate(from)

  onMount(() => {
    mounted = true
    setProgress(from)
    slideIn()
  })

  onCleanup(() => {
    mounted = false
    if (frame) cancelAnimationFrame(frame)
  })

  return { progress, running, slideIn, slideOut, direction }
}
