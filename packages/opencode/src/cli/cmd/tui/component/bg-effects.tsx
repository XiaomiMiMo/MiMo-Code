import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { RGBA, StyledText, type BoxRenderable, type TextChunk, type TextRenderable } from "@opentui/core"
import { useTheme } from "@tui/context/theme"

type BgSize = { w: number; h: number }

function useBgBase() {
  const { theme } = useTheme()
  const [size, setSize] = createSignal<BgSize>({ w: 80, h: 24 })
  let box: BoxRenderable | undefined
  let text: TextRenderable | undefined
  let mounted = false

  const sync = (b?: BoxRenderable) => {
    if (!b) return
    const next = { w: b.width || 80, h: b.height || 24 }
    const cur = size()
    if (next.w === cur.w && next.h === cur.h) return
    setSize(next)
  }

  return { theme, size, setSize, box, text, mounted, sync }
}

// ─── Fire ────────────────────────────────────────────────────

export function FireBg() {
  const { theme } = useTheme()
  const [size, setSize] = createSignal<BgSize>({ w: 80, h: 24 })
  const [particles, setParticles] = createSignal<{ x: number; y: number; speed: number; life: number }[]>([])
  const [frame, setFrame] = createSignal(0)
  let box: BoxRenderable | undefined
  let text: TextRenderable | undefined
  let mounted = false
  let timer: ReturnType<typeof setInterval> | undefined

  const sync = () => {
    if (!box) return
    const next = { w: box.width || 80, h: box.height || 24 }
    const cur = size()
    if (next.w === cur.w && next.h === cur.h) return
    setSize(next)
  }

  onMount(() => {
    mounted = true
    sync()
    box?.on("resize", sync)
    timer = setInterval(() => {
      if (!mounted) return
      const { w, h } = size()
      setParticles((prev) => {
        const next = prev
          .map((p) => ({ ...p, y: p.y - p.speed, life: p.life - 1 }))
          .filter((p) => p.life > 0 && p.y < h)
        if (Math.random() < 0.3) {
          next.push({ x: Math.random() * w, y: h - 1, speed: 0.3 + Math.random() * 0.7, life: 15 + Math.floor(Math.random() * 20) })
        }
        return next
      })
      setFrame((n) => n + 1)
    }, 60)
  })
  onCleanup(() => { mounted = false; box?.off("resize", sync); if (timer) clearInterval(timer) })

  const content = createMemo(() => {
    void frame()
    const { w, h } = size()
    const ps = particles()
    const bg = theme.background
    const chunks: TextChunk[] = []
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = ps.find((p) => Math.floor(p.x) === x && Math.floor(p.y) === y)
        if (!p) { chunks.push({ __isChunk: true, text: " ", bg, attributes: 0 }); continue }
        const t = p.life / 30
        const r = Math.round(255)
        const g = Math.round(120 + 135 * (1 - t))
        const b = Math.round(30 * (1 - t))
        chunks.push({ __isChunk: true, text: "░", fg: RGBA.fromInts(r, g, b), bg, attributes: 0 })
      }
      if (y < h - 1) chunks.push({ __isChunk: true, text: "\n", attributes: 0 })
    }
    return new StyledText(chunks)
  })
  createEffect(() => { if (text) text.content = content() })

  return (
    <box ref={(r) => { box = r; sync() }} position="absolute" top={0} left={0} width="100%" height="100%" zIndex={0}>
      <text ref={(r) => { text = r; if (r) r.content = content() }} width="100%" height="100%" wrapMode="none" selectable={false} />
    </box>
  )
}

// ─── Snow ────────────────────────────────────────────────────

export function SnowBg() {
  const { theme } = useTheme()
  const [size, setSize] = createSignal<BgSize>({ w: 80, h: 24 })
  const [flakes, setFlakes] = createSignal<{ x: number; y: number; drift: number; speed: number }[]>([])
  const [frame, setFrame] = createSignal(0)
  let box: BoxRenderable | undefined
  let text: TextRenderable | undefined
  let mounted = false
  let timer: ReturnType<typeof setInterval> | undefined

  const sync = () => {
    if (!box) return
    const next = { w: box.width || 80, h: box.height || 24 }
    const cur = size()
    if (next.w === cur.w && next.h === cur.h) return
    setSize(next)
  }

  onMount(() => {
    mounted = true
    sync()
    box?.on("resize", sync)
    timer = setInterval(() => {
      if (!mounted) return
      const { w, h } = size()
      setFlakes((prev) => {
        const next = prev.map((f) => ({ ...f, x: f.x + f.drift, y: f.y + f.speed })).filter((f) => f.y < h && f.x >= 0 && f.x < w)
        if (Math.random() < 0.4) {
          next.push({ x: Math.random() * w, y: -1, drift: -0.1 + Math.random() * 0.2, speed: 0.2 + Math.random() * 0.4 })
        }
        return next
      })
      setFrame((n) => n + 1)
    }, 80)
  })
  onCleanup(() => { mounted = false; box?.off("resize", sync); if (timer) clearInterval(timer) })

  const content = createMemo(() => {
    void frame()
    const { w, h } = size()
    const fs = flakes()
    const bg = theme.background
    const chunks: TextChunk[] = []
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const f = fs.find((f) => Math.floor(f.x) === x && Math.floor(f.y) === y)
        if (!f) { chunks.push({ __isChunk: true, text: " ", bg, attributes: 0 }); continue }
        chunks.push({ __isChunk: true, text: ".", fg: RGBA.fromInts(220, 230, 255), bg, attributes: 0 })
      }
      if (y < h - 1) chunks.push({ __isChunk: true, text: "\n", attributes: 0 })
    }
    return new StyledText(chunks)
  })
  createEffect(() => { if (text) text.content = content() })

  return (
    <box ref={(r) => { box = r; sync() }} position="absolute" top={0} left={0} width="100%" height="100%" zIndex={0}>
      <text ref={(r) => { text = r; if (r) r.content = content() }} width="100%" height="100%" wrapMode="none" selectable={false} />
    </box>
  )
}

// ─── Rain ────────────────────────────────────────────────────

export function RainBg() {
  const { theme } = useTheme()
  const [size, setSize] = createSignal<BgSize>({ w: 80, h: 24 })
  const [drops, setDrops] = createSignal<{ x: number; y: number; speed: number; len: number }[]>([])
  const [frame, setFrame] = createSignal(0)
  let box: BoxRenderable | undefined
  let text: TextRenderable | undefined
  let mounted = false
  let timer: ReturnType<typeof setInterval> | undefined

  const sync = () => {
    if (!box) return
    const next = { w: box.width || 80, h: box.height || 24 }
    const cur = size()
    if (next.w === cur.w && next.h === cur.h) return
    setSize(next)
  }

  onMount(() => {
    mounted = true
    sync()
    box?.on("resize", sync)
    timer = setInterval(() => {
      if (!mounted) return
      const { w, h } = size()
      setDrops((prev) => {
        const next = prev.map((d) => ({ ...d, y: d.y + d.speed })).filter((d) => d.y - d.len < h)
        if (Math.random() < 0.5) {
          next.push({ x: Math.random() * w, y: -Math.random() * 5, speed: 1.5 + Math.random() * 2, len: 3 + Math.floor(Math.random() * 5) })
        }
        return next
      })
      setFrame((n) => n + 1)
    }, 50)
  })
  onCleanup(() => { mounted = false; box?.off("resize", sync); if (timer) clearInterval(timer) })

  const content = createMemo(() => {
    void frame()
    const { w, h } = size()
    const ds = drops()
    const bg = theme.background
    const chunks: TextChunk[] = []
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = ds.find((d) => Math.floor(d.x) === x && y >= d.y - d.len && y <= d.y)
        if (!d) { chunks.push({ __isChunk: true, text: " ", bg, attributes: 0 }); continue }
        const dist = d.y - y
        const bright = 1 - dist / d.len
        const b = Math.round(180 + 75 * bright)
        chunks.push({ __isChunk: true, text: "|", fg: RGBA.fromInts(100, 180, b), bg, attributes: 0 })
      }
      if (y < h - 1) chunks.push({ __isChunk: true, text: "\n", attributes: 0 })
    }
    return new StyledText(chunks)
  })
  createEffect(() => { if (text) text.content = content() })

  return (
    <box ref={(r) => { box = r; sync() }} position="absolute" top={0} left={0} width="100%" height="100%" zIndex={0}>
      <text ref={(r) => { text = r; if (r) r.content = content() }} width="100%" height="100%" wrapMode="none" selectable={false} />
    </box>
  )
}

// ─── Aurora ──────────────────────────────────────────────────

export function AuroraBg() {
  const { theme } = useTheme()
  const [size, setSize] = createSignal<BgSize>({ w: 80, h: 24 })
  const [tick, setTick] = createSignal(0)
  let box: BoxRenderable | undefined
  let text: TextRenderable | undefined
  let mounted = false
  let timer: ReturnType<typeof setInterval> | undefined

  const sync = () => {
    if (!box) return
    const next = { w: box.width || 80, h: box.height || 24 }
    const cur = size()
    if (next.w === cur.w && next.h === cur.h) return
    setSize(next)
  }

  onMount(() => {
    mounted = true; sync(); box?.on("resize", sync)
    timer = setInterval(() => { if (mounted) setTick((t) => t + 1) }, 80)
  })
  onCleanup(() => { mounted = false; box?.off("resize", sync); if (timer) clearInterval(timer) })

  const content = createMemo(() => {
    const t = tick() * 0.05
    const { w, h } = size()
    const bg = theme.background
    const chunks: TextChunk[] = []
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const nx = x / w
        const ny = y / h
        const v = Math.sin(nx * 3 + t) * 0.5 + Math.sin(nx * 7 + ny * 2 + t * 0.7) * 0.3 + Math.sin(ny * 5 + t * 0.4) * 0.2
        const band = Math.max(0, Math.min(1, (v + 1) * 0.5 - ny * 0.3))
        if (band < 0.05) { chunks.push({ __isChunk: true, text: " ", bg, attributes: 0 }); continue }
        const g = Math.round(80 + 175 * band)
        const r = Math.round(20 * band)
        const b = Math.round(60 + 120 * band)
        const shade = band > 0.7 ? "█" : band > 0.4 ? "▓" : "▒"
        chunks.push({ __isChunk: true, text: shade, fg: RGBA.fromInts(r, g, b), bg, attributes: 0 })
      }
      if (y < h - 1) chunks.push({ __isChunk: true, text: "\n", attributes: 0 })
    }
    return new StyledText(chunks)
  })
  createEffect(() => { if (text) text.content = content() })

  return (
    <box ref={(r) => { box = r; sync() }} position="absolute" top={0} left={0} width="100%" height="100%" zIndex={0}>
      <text ref={(r) => { text = r; if (r) r.content = content() }} width="100%" height="100%" wrapMode="none" selectable={false} />
    </box>
  )
}

// ─── Plasma ──────────────────────────────────────────────────

export function PlasmaBg() {
  const { theme } = useTheme()
  const [size, setSize] = createSignal<BgSize>({ w: 80, h: 24 })
  const [tick, setTick] = createSignal(0)
  let box: BoxRenderable | undefined
  let text: TextRenderable | undefined
  let mounted = false
  let timer: ReturnType<typeof setInterval> | undefined

  const sync = () => {
    if (!box) return
    const next = { w: box.width || 80, h: box.height || 24 }
    const cur = size()
    if (next.w === cur.w && next.h === cur.h) return
    setSize(next)
  }

  onMount(() => {
    mounted = true; sync(); box?.on("resize", sync)
    timer = setInterval(() => { if (mounted) setTick((t) => t + 1) }, 60)
  })
  onCleanup(() => { mounted = false; box?.off("resize", sync); if (timer) clearInterval(timer) })

  const content = createMemo(() => {
    const t = tick() * 0.08
    const { w, h } = size()
    const bg = theme.background
    const chunks: TextChunk[] = []
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = Math.sin(x * 0.15 + t) + Math.sin(y * 0.1 + t * 0.7) + Math.sin((x + y) * 0.08 + t * 0.5) + Math.sin(Math.sqrt(x * x + y * y) * 0.1 + t * 0.3)
        const n = (v + 4) / 8
        const r = Math.round(Math.sin(n * 6) * 127 + 128)
        const g = Math.round(Math.sin(n * 6 + 2) * 127 + 128)
        const bl = Math.round(Math.sin(n * 6 + 4) * 127 + 128)
        const shade = n > 0.6 ? "█" : n > 0.4 ? "▓" : n > 0.25 ? "▒" : "░"
        chunks.push({ __isChunk: true, text: shade, fg: RGBA.fromInts(r, g, bl), bg, attributes: 0 })
      }
      if (y < h - 1) chunks.push({ __isChunk: true, text: "\n", attributes: 0 })
    }
    return new StyledText(chunks)
  })
  createEffect(() => { if (text) text.content = content() })

  return (
    <box ref={(r) => { box = r; sync() }} position="absolute" top={0} left={0} width="100%" height="100%" zIndex={0}>
      <text ref={(r) => { text = r; if (r) r.content = content() }} width="100%" height="100%" wrapMode="none" selectable={false} />
    </box>
  )
}

// ─── Bubbles ─────────────────────────────────────────────────

export function BubblesBg() {
  const { theme } = useTheme()
  const [size, setSize] = createSignal<BgSize>({ w: 80, h: 24 })
  const [bubbles, setBubbles] = createSignal<{ x: number; y: number; r: number; speed: number; wobble: number }[]>([])
  const [frame, setFrame] = createSignal(0)
  let box: BoxRenderable | undefined
  let text: TextRenderable | undefined
  let mounted = false
  let timer: ReturnType<typeof setInterval> | undefined

  const sync = () => {
    if (!box) return
    const next = { w: box.width || 80, h: box.height || 24 }
    const cur = size()
    if (next.w === cur.w && next.h === cur.h) return
    setSize(next)
  }

  onMount(() => {
    mounted = true; sync(); box?.on("resize", sync)
    timer = setInterval(() => {
      if (!mounted) return
      const { w, h } = size()
      setBubbles((prev) => {
        const next = prev.map((b) => ({ ...b, y: b.y - b.speed, x: b.x + Math.sin(b.y * 0.5 + b.wobble) * 0.1 })).filter((b) => b.y + b.r > 0 && b.x > 0 && b.x < w)
        if (Math.random() < 0.15) {
          next.push({ x: Math.random() * w, y: h + 1, r: 1 + Math.floor(Math.random() * 2), speed: 0.15 + Math.random() * 0.3, wobble: Math.random() * 6 })
        }
        return next
      })
      setFrame((n) => n + 1)
    }, 100)
  })
  onCleanup(() => { mounted = false; box?.off("resize", sync); if (timer) clearInterval(timer) })

  const content = createMemo(() => {
    void frame()
    const { w, h } = size()
    const bs = bubbles()
    const bg = theme.background
    const chars = [".", "o", "O", "o", "."]
    const chunks: TextChunk[] = []
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const b = bs.find((b) => {
          const dx = x - Math.floor(b.x)
          const dy = y - Math.floor(b.y)
          return dx >= -b.r && dx <= b.r && dy >= -b.r && dy <= b.r
        })
        if (!b) { chunks.push({ __isChunk: true, text: " ", bg, attributes: 0 }); continue }
        const dx = x - Math.floor(b.x)
        const dy = y - Math.floor(b.y)
        const dist = Math.sqrt(dx * dx + dy * dy)
        const idx = Math.min(chars.length - 1, Math.floor(dist / b.r * chars.length))
        const a = Math.round(80 + 120 * (1 - dist / (b.r + 1)))
        chunks.push({ __isChunk: true, text: chars[idx], fg: RGBA.fromInts(a, a, a), bg, attributes: 0 })
      }
      if (y < h - 1) chunks.push({ __isChunk: true, text: "\n", attributes: 0 })
    }
    return new StyledText(chunks)
  })
  createEffect(() => { if (text) text.content = content() })

  return (
    <box ref={(r) => { box = r; sync() }} position="absolute" top={0} left={0} width="100%" height="100%" zIndex={0}>
      <text ref={(r) => { text = r; if (r) r.content = content() }} width="100%" height="100%" wrapMode="none" selectable={false} />
    </box>
  )
}

// ─── Confetti ────────────────────────────────────────────────

export function ConfettiBg() {
  const { theme } = useTheme()
  const [size, setSize] = createSignal<BgSize>({ w: 80, h: 24 })
  const [pieces, setPieces] = createSignal<{ x: number; y: number; speed: number; drift: number; color: number; char: string }[]>([])
  const [frame, setFrame] = createSignal(0)
  let box: BoxRenderable | undefined
  let text: TextRenderable | undefined
  let mounted = false
  let timer: ReturnType<typeof setInterval> | undefined

  const confettiChars = ["*", ".", "+", "♦", "•", "♥", "★", "▬"]
  const sync = () => {
    if (!box) return
    const next = { w: box.width || 80, h: box.height || 24 }
    const cur = size()
    if (next.w === cur.w && next.h === cur.h) return
    setSize(next)
  }

  onMount(() => {
    mounted = true; sync(); box?.on("resize", sync)
    timer = setInterval(() => {
      if (!mounted) return
      const { w, h } = size()
      setPieces((prev) => {
        const next = prev.map((p) => ({ ...p, x: p.x + p.drift, y: p.y + p.speed })).filter((p) => p.y < h + 1 && p.x >= 0 && p.x < w)
        if (Math.random() < 0.2) {
          const hue = Math.floor(Math.random() * 6)
          next.push({ x: Math.random() * w, y: -1, speed: 0.3 + Math.random() * 0.6, drift: -0.2 + Math.random() * 0.4, color: hue, char: confettiChars[Math.floor(Math.random() * confettiChars.length)] })
        }
        return next
      })
      setFrame((n) => n + 1)
    }, 60)
  })
  onCleanup(() => { mounted = false; box?.off("resize", sync); if (timer) clearInterval(timer) })

  const colors = [[255,80,80],[80,255,80],[80,80,255],[255,255,80],[255,80,255],[80,255,255]]
  const content = createMemo(() => {
    void frame()
    const { w, h } = size()
    const ps = pieces()
    const bg = theme.background
    const chunks: TextChunk[] = []
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = ps.find((p) => Math.floor(p.x) === x && Math.floor(p.y) === y)
        if (!p) { chunks.push({ __isChunk: true, text: " ", bg, attributes: 0 }); continue }
        const c = colors[p.color % colors.length]
        chunks.push({ __isChunk: true, text: p.char, fg: RGBA.fromInts(c[0], c[1], c[2]), bg, attributes: 0 })
      }
      if (y < h - 1) chunks.push({ __isChunk: true, text: "\n", attributes: 0 })
    }
    return new StyledText(chunks)
  })
  createEffect(() => { if (text) text.content = content() })

  return (
    <box ref={(r) => { box = r; sync() }} position="absolute" top={0} left={0} width="100%" height="100%" zIndex={0}>
      <text ref={(r) => { text = r; if (r) r.content = content() }} width="100%" height="100%" wrapMode="none" selectable={false} />
    </box>
  )
}

// ─── Ripple ──────────────────────────────────────────────────

export function RippleBg() {
  const { theme } = useTheme()
  const [size, setSize] = createSignal<BgSize>({ w: 80, h: 24 })
  const [rings, setRings] = createSignal<{ cx: number; cy: number; r: number; life: number }[]>([])
  const [frame, setFrame] = createSignal(0)
  let box: BoxRenderable | undefined
  let text: TextRenderable | undefined
  let mounted = false
  let timer: ReturnType<typeof setInterval> | undefined

  const sync = () => {
    if (!box) return
    const next = { w: box.width || 80, h: box.height || 24 }
    const cur = size()
    if (next.w === cur.w && next.h === cur.h) return
    setSize(next)
  }

  onMount(() => {
    mounted = true; sync(); box?.on("resize", sync)
    timer = setInterval(() => {
      if (!mounted) return
      const { w, h } = size()
      setRings((prev) => {
        const next = prev.map((r) => ({ ...r, r: r.r + 0.5, life: r.life - 1 })).filter((r) => r.life > 0)
        if (Math.random() < 0.03) {
          next.push({ cx: Math.random() * w, cy: Math.random() * h, r: 1, life: 30 + Math.floor(Math.random() * 20) })
        }
        return next
      })
      setFrame((n) => n + 1)
    }, 80)
  })
  onCleanup(() => { mounted = false; box?.off("resize", sync); if (timer) clearInterval(timer) })

  const ringChars = [".", "o", "O", "O", "o", "."]
  const content = createMemo(() => {
    void frame()
    const { w, h } = size()
    const rs = rings()
    const bg = theme.background
    const chunks: TextChunk[] = []
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let drawn = false
        for (const ring of rs) {
          const dist = Math.sqrt((x - ring.cx) ** 2 + (y - ring.cy) ** 2)
          const idx = Math.floor(Math.abs(dist - ring.r))
          if (idx < ringChars.length) {
            const t = ring.life / 40
            const c = Math.round(100 + 155 * t)
            chunks.push({ __isChunk: true, text: ringChars[idx], fg: RGBA.fromInts(c, c, 255), bg, attributes: 0 })
            drawn = true
            break
          }
        }
        if (!drawn) chunks.push({ __isChunk: true, text: " ", bg, attributes: 0 })
      }
      if (y < h - 1) chunks.push({ __isChunk: true, text: "\n", attributes: 0 })
    }
    return new StyledText(chunks)
  })
  createEffect(() => { if (text) text.content = content() })

  return (
    <box ref={(r) => { box = r; sync() }} position="absolute" top={0} left={0} width="100%" height="100%" zIndex={0}>
      <text ref={(r) => { text = r; if (r) r.content = content() }} width="100%" height="100%" wrapMode="none" selectable={false} />
    </box>
  )
}

// ─── Pulse ───────────────────────────────────────────────────

export function PulseBg() {
  const { theme } = useTheme()
  const [size, setSize] = createSignal<BgSize>({ w: 80, h: 24 })
  const [tick, setTick] = createSignal(0)
  let box: BoxRenderable | undefined
  let text: TextRenderable | undefined
  let mounted = false
  let timer: ReturnType<typeof setInterval> | undefined

  const sync = () => {
    if (!box) return
    const next = { w: box.width || 80, h: box.height || 24 }
    const cur = size()
    if (next.w === cur.w && next.h === cur.h) return
    setSize(next)
  }

  onMount(() => {
    mounted = true; sync(); box?.on("resize", sync)
    timer = setInterval(() => { if (mounted) setTick((t) => t + 1) }, 60)
  })
  onCleanup(() => { mounted = false; box?.off("resize", sync); if (timer) clearInterval(timer) })

  const content = createMemo(() => {
    const t = tick() * 0.04
    const pulse = (Math.sin(t) + 1) / 2
    const { w, h } = size()
    const bg = theme.background
    const chunks: TextChunk[] = []
    const r = Math.round(80 + 50 * pulse)
    const g = Math.round(60 + 50 * pulse)
    const bl = Math.round(120 + 60 * pulse)
    const shade = pulse > 0.7 ? "░" : pulse > 0.4 ? "▒" : "▓"
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        chunks.push({ __isChunk: true, text: shade, fg: RGBA.fromInts(r, g, bl), bg, attributes: 0 })
      }
      if (y < h - 1) chunks.push({ __isChunk: true, text: "\n", attributes: 0 })
    }
    return new StyledText(chunks)
  })
  createEffect(() => { if (text) text.content = content() })

  return (
    <box ref={(r) => { box = r; sync() }} position="absolute" top={0} left={0} width="100%" height="100%" zIndex={0}>
      <text ref={(r) => { text = r; if (r) r.content = content() }} width="100%" height="100%" wrapMode="none" selectable={false} />
    </box>
  )
}

// ─── Drift (lava lamp) ──────────────────────────────────────

export function DriftBg() {
  const { theme } = useTheme()
  const [size, setSize] = createSignal<BgSize>({ w: 80, h: 24 })
  const [tick, setTick] = createSignal(0)
  let box: BoxRenderable | undefined
  let text: TextRenderable | undefined
  let mounted = false
  let timer: ReturnType<typeof setInterval> | undefined

  const sync = () => {
    if (!box) return
    const next = { w: box.width || 80, h: box.height || 24 }
    const cur = size()
    if (next.w === cur.w && next.h === cur.h) return
    setSize(next)
  }

  onMount(() => {
    mounted = true; sync(); box?.on("resize", sync)
    timer = setInterval(() => { if (mounted) setTick((t) => t + 1) }, 80)
  })
  onCleanup(() => { mounted = false; box?.off("resize", sync); if (timer) clearInterval(timer) })

  const content = createMemo(() => {
    const t = tick() * 0.03
    const { w, h } = size()
    const bg = theme.background
    const chunks: TextChunk[] = []
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const nx = x / w
        const ny = y / h
        const v = Math.sin(nx * 4 + ny * 3 + t) * 0.5 + Math.sin(nx * 6 - ny * 5 + t * 1.3 + 2) * 0.3 + Math.sin(nx * 2 + ny * 7 + t * 0.7 + 4) * 0.2
        const n = (v + 1) / 2
        if (n < 0.3) { chunks.push({ __isChunk: true, text: " ", bg, attributes: 0 }); continue }
        const r = Math.round(180 * n)
        const g = Math.round(60 * n)
        const bl = Math.round(200 * n)
        chunks.push({ __isChunk: true, text: "▓", fg: RGBA.fromInts(r, g, bl), bg, attributes: 0 })
      }
      if (y < h - 1) chunks.push({ __isChunk: true, text: "\n", attributes: 0 })
    }
    return new StyledText(chunks)
  })
  createEffect(() => { if (text) text.content = content() })

  return (
    <box ref={(r) => { box = r; sync() }} position="absolute" top={0} left={0} width="100%" height="100%" zIndex={0}>
      <text ref={(r) => { text = r; if (r) r.content = content() }} width="100%" height="100%" wrapMode="none" selectable={false} />
    </box>
  )
}

// ─── Twinkle ─────────────────────────────────────────────────

export function TwinkleBg() {
  const { theme } = useTheme()
  const [size, setSize] = createSignal<BgSize>({ w: 80, h: 24 })
  const [stars, setStars] = createSignal<{ x: number; y: number; phase: number; color: number; size: number }[]>([])
  const [tick, setTick] = createSignal(0)
  let box: BoxRenderable | undefined
  let text: TextRenderable | undefined
  let mounted = false
  let timer: ReturnType<typeof setInterval> | undefined

  const sync = () => {
    if (!box) return
    const next = { w: box.width || 80, h: box.height || 24 }
    const cur = size()
    if (next.w === cur.w && next.h === cur.h) return
    setSize(next)
    const starsArr = []
    for (let i = 0; i < Math.floor(next.w * next.h * 0.02); i++) {
      starsArr.push({ x: Math.random() * next.w, y: Math.random() * next.h, phase: Math.random() * 6, color: Math.floor(Math.random() * 4), size: Math.random() < 0.2 ? 2 : 1 })
    }
    setStars(starsArr)
  }

  onMount(() => {
    mounted = true; sync(); box?.on("resize", sync)
    timer = setInterval(() => { if (mounted) setTick((t) => t + 1) }, 100)
  })
  onCleanup(() => { mounted = false; box?.off("resize", sync); if (timer) clearInterval(timer) })

  const starChars = [".", "*", "•", "+"]
  const starColors = [[255,255,200],[255,200,255],[200,255,255],[255,220,180]]
  const content = createMemo(() => {
    const t = tick() * 0.1
    const { w, h } = size()
    const ss = stars()
    const bg = theme.background
    const chunks: TextChunk[] = []
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = ss.find((s) => Math.floor(s.x) === x && Math.floor(s.y) === y)
        if (!s) { chunks.push({ __isChunk: true, text: " ", bg, attributes: 0 }); continue }
        const bright = (Math.sin(t + s.phase) + 1) / 2
        const c = starColors[s.color % starColors.length]
        const dim = 0.3 + 0.7 * bright
        const r = Math.round(c[0] * dim)
        const g = Math.round(c[1] * dim)
        const b = Math.round(c[2] * dim)
        const ch = s.size === 2 && bright > 0.6 ? starChars[Math.floor(Math.random() * starChars.length)] : "."
        chunks.push({ __isChunk: true, text: ch, fg: RGBA.fromInts(r, g, b), bg, attributes: 0 })
      }
      if (y < h - 1) chunks.push({ __isChunk: true, text: "\n", attributes: 0 })
    }
    return new StyledText(chunks)
  })
  createEffect(() => { if (text) text.content = content() })

  return (
    <box ref={(r) => { box = r; sync() }} position="absolute" top={0} left={0} width="100%" height="100%" zIndex={0}>
      <text ref={(r) => { text = r; if (r) r.content = content() }} width="100%" height="100%" wrapMode="none" selectable={false} />
    </box>
  )
}
