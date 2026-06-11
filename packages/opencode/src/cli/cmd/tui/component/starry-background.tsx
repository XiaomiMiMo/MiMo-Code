import { createEffect, createSignal, onCleanup, onMount, createMemo } from "solid-js"
import { RGBA, StyledText, type BoxRenderable, type TextChunk, type TextRenderable } from "@opentui/core"
import { useTheme, tint } from "@tui/context/theme"

const STAR_CHARS_DARK = ["✦", "✧", "✦", "✧", "✦", "✧", "✦", " "]
const STAR_CHARS_LIGHT = ["✦", "✧", "✦", "✧", "✦", "✧", "✦", " "]
const HOT_CHAR = "✶"
const HOT_THRESHOLD = 0.88
const TWINKLE_INTERVAL = 200
const DENSITY = 0.00394
const METEOR_INTERVAL = 8000
const METEOR_DURATION = 3600
const METEOR_ANGLE = 0.36
const METEOR_TAIL = 32
const METEOR_FRAME_INTERVAL = 50
const METEOR_STEP = 0.15

type StarField = {
  grid: string[][]
  brightness: number[][]
}

type Meteor = {
  at: number
  startX: number
  startY: number
  speed: number
}

function appendChunk(chunks: TextChunk[], text: string, fg?: RGBA) {
  const prev = chunks.at(-1)
  if (prev?.fg?.equals(fg) && prev.bg === undefined && prev.attributes === 0) {
    prev.text += text
    return
  }
  chunks.push({ __isChunk: true, text, fg, attributes: 0 })
}

function generateField(w: number, h: number): StarField {
  const grid: string[][] = []
  const brightness: number[][] = []
  for (let y = 0; y < h; y++) {
    const row: string[] = []
    const brow: number[] = []
    for (let x = 0; x < w; x++) {
      if (Math.random() < DENSITY) {
        const idx = Math.floor(Math.random() * (STAR_CHARS_DARK.length - 1))
        row.push(String(idx))
        brow.push(0.15 + Math.random() * 0.4)
      } else {
        row.push(" ")
        brow.push(0)
      }
    }
    grid.push(row)
    brightness.push(brow)
  }
  return { grid, brightness }
}

// Map a (col, row) within a 2×4 Braille sub-grid to its bit index in U+2800 patterns.
// Layout: dots 1/2/3 in left column rows 0/1/2, dot 7 in left column row 3,
// dots 4/5/6 in right column rows 0/1/2, dot 8 in right column row 3.
function brailleBit(col: number, row: number): number {
  if (col === 0) return row === 3 ? 6 : row
  return row === 3 ? 7 : 3 + row
}

export function StarryBackground(props: { meteor?: () => boolean } = {}) {
  const { theme } = useTheme()
  const [field, setField] = createSignal<StarField>({ grid: [], brightness: [] })
  const [size, setSize] = createSignal({ w: 80, h: 24 })
  const [meteor, setMeteor] = createSignal<Meteor>()
  const [frame, setFrame] = createSignal(0)
  let timer: ReturnType<typeof setInterval> | undefined
  let meteorTimer: ReturnType<typeof setInterval> | undefined
  let frameTimer: ReturnType<typeof setInterval> | undefined
  let box: BoxRenderable | undefined
  let text: TextRenderable | undefined
  let mounted = false

  const sync = () => {
    if (!box) return
    const next = { w: box.width || 80, h: box.height || 24 }
    const cur = size()
    if (next.w === cur.w && next.h === cur.h) return
    setSize(next)
    setField(generateField(next.w, next.h))
  }

  onMount(() => {
    mounted = true
    sync()
    box?.on("resize", sync)
    timer = setInterval(() => {
      if (!mounted) return
      const { w, h } = size()
      setField((prev) => {
        const next = { grid: prev.grid, brightness: [...prev.brightness.map((r) => [...r])] }
        const count = Math.floor(w * h * 0.008)
        for (let i = 0; i < count; i++) {
          const y = Math.floor(Math.random() * h)
          const x = Math.floor(Math.random() * w)
          if (next.grid[y]?.[x] && next.grid[y][x] !== " ") {
            const r = Math.random()
            // 12% chance of a "hot spike" (very bright), 68% normal bright, 20% dim
            next.brightness[y][x] =
              r < 0.12 ? 0.92 + Math.random() * 0.08 : r < 0.8 ? 0.7 + Math.random() * 0.22 : 0.05 + Math.random() * 0.2
          }
        }
        return next
      })
    }, TWINKLE_INTERVAL)
    meteorTimer = setInterval(() => {
      if (!mounted) return
      if (props.meteor && !props.meteor()) return
      const { w, h } = size()
      const startY = Math.floor(Math.random() * 2)
      const speed = Math.max(0.011, Math.min(0.038, (h - startY) / (Math.sin(METEOR_ANGLE) * METEOR_DURATION)))
      setMeteor({
        at: performance.now(),
        startX: w - Math.random() * Math.max(1, w * 0.15),
        startY,
        speed,
      })
      if (frameTimer) clearInterval(frameTimer)
      frameTimer = setInterval(() => {
        if (!mounted) {
          if (frameTimer) clearInterval(frameTimer)
          frameTimer = undefined
          return
        }
        setFrame((n) => n + 1)
        const m = meteor()
        if (!m || performance.now() - m.at > METEOR_DURATION) {
          if (frameTimer) {
            clearInterval(frameTimer)
            frameTimer = undefined
          }
          setMeteor(undefined)
        }
      }, METEOR_FRAME_INTERVAL)
    }, METEOR_INTERVAL)
  })

  onCleanup(() => {
    mounted = false
    box?.off("resize", sync)
    if (timer) {
      clearInterval(timer)
      timer = undefined
    }
    if (meteorTimer) {
      clearInterval(meteorTimer)
      meteorTimer = undefined
    }
    if (frameTimer) {
      clearInterval(frameTimer)
      frameTimer = undefined
    }
  })

  const isDark = createMemo(() => {
    const bg = theme.background
    return (bg.r ?? 0) + (bg.g ?? 0) + (bg.b ?? 0) < 384
  })

  const content = createMemo(() => {
    void frame()
    const f = field()
    if (!f.grid.length) return new StyledText([])
    const dark = isDark()
    const charSet = dark ? STAR_CHARS_DARK : STAR_CHARS_LIGHT
    const meteorMap = new Map<string, { char: string; color: RGBA }>()
    const m = meteor()
    if (m) {
      const elapsed = performance.now() - m.at
      if (elapsed >= 0 && elapsed <= METEOR_DURATION) {
        const distance = elapsed * m.speed
        const dx = -Math.cos(METEOR_ANGLE)
        const dy = Math.sin(METEOR_ANGLE)
        const headX = m.startX + distance * dx
        const headY = m.startY + distance * dy
        const envelope = Math.sin((elapsed / METEOR_DURATION) * Math.PI)
        const beamCore = dark ? RGBA.fromInts(255, 255, 255) : RGBA.fromInts(40, 60, 130)
        const beamGlow = dark ? RGBA.fromInts(180, 215, 255) : RGBA.fromInts(80, 110, 170)
        const gridH = f.grid.length
        const gridW = f.grid[0]?.length ?? 0
        // Walk the trajectory in fine steps and accumulate Braille dots per cell so
        // the rendered beam visually traces the exact movement angle.
        const cellAcc = new Map<string, { dots: number; minT: number }>()
        const setDot = (px: number, py: number, t: number) => {
          const subX = Math.floor(px * 2)
          const subY = Math.floor(py * 4)
          const cx = subX >> 1
          const cy = subY >> 2
          if (cx < 0 || cx >= gridW || cy < 0 || cy >= gridH) return
          const bit = brailleBit(subX & 1, subY & 3)
          const key = `${cx},${cy}`
          const existing = cellAcc.get(key)
          cellAcc.set(key, {
            dots: (existing?.dots ?? 0) | (1 << bit),
            minT: Math.min(existing?.minT ?? Infinity, t),
          })
        }
        for (let t = 0; t <= METEOR_TAIL; t += METEOR_STEP) {
          setDot(headX - t * dx, headY - t * dy, t)
        }
        // Round head: filled disk in Braille sub-pixel space. Sub-pixels are visually
        // square (cell W:H ≈ 1:2, sub-grid 2×4), so a circle in this space renders as
        // a circle on screen — giving the meteor a clear glowing core, not a hairline.
        // Anchor the head circle on the SAME sub-pixel that the tail's t=0 step
        // lights up — `setDot` uses Math.floor, so we must too. Using Math.round here
        // would offset the disk by up to 1 sub-pixel below or to the side of the tip.
        const headSubX = Math.floor(headX * 2)
        const headSubY = Math.floor(headY * 4)
        const headR2 = 1
        for (let dsx = -1; dsx <= 1; dsx++) {
          for (let dsy = -1; dsy <= 1; dsy++) {
            if (dsx * dsx + dsy * dsy > headR2) continue
            const subX = headSubX + dsx
            const subY = headSubY + dsy
            const cx = subX >> 1
            const cy = subY >> 2
            if (cx < 0 || cx >= gridW || cy < 0 || cy >= gridH) continue
            const bit = brailleBit(subX & 1, subY & 3)
            const key = `${cx},${cy}`
            const existing = cellAcc.get(key)
            cellAcc.set(key, {
              dots: (existing?.dots ?? 0) | (1 << bit),
              minT: 0,
            })
          }
        }
        for (const [key, val] of cellAcc) {
          const fade = Math.pow(1 - val.minT / METEOR_TAIL, 1.3) * envelope
          const headBlend = Math.max(0, 1 - val.minT / 5)
          const color = tint(
            theme.background,
            tint(beamGlow, beamCore, headBlend),
            Math.max(0.02, fade),
          )
          meteorMap.set(key, { char: String.fromCharCode(0x2800 + val.dots), color })
        }
      }
    }
    const chunks: TextChunk[] = []
    f.grid.forEach((row, y) => {
      row.forEach((cell, x) => {
        const overlay = meteorMap.get(`${x},${y}`)
        if (overlay) {
          appendChunk(chunks, overlay.char, overlay.color)
          return
        }
        const b = f.brightness[y]?.[x] ?? 0
        if (cell === " " || b === 0) {
          appendChunk(chunks, " ", theme.background)
          return
        }
        const idx = parseInt(cell) || 0
        const isHot = b >= HOT_THRESHOLD
        const peak = isHot ? Math.min(1, (b - HOT_THRESHOLD) / (1 - HOT_THRESHOLD)) : 0
        const char = isHot ? HOT_CHAR : charSet[idx % (charSet.length - 1)]
        const baseColor = dark
          ? tint(theme.background, RGBA.fromInts(237, 220, 170), Math.min(1, b * 1.05))
          : tint(theme.background, RGBA.fromInts(117, 92, 47), Math.min(1, b * 0.95))
        const starColor =
          peak > 0
            ? tint(baseColor, dark ? RGBA.fromInts(255, 255, 255) : RGBA.fromInts(60, 30, 0), peak * (dark ? 0.65 : 0.5))
            : baseColor
        appendChunk(chunks, char, starColor)
      })
      if (y < f.grid.length - 1) chunks.push({ __isChunk: true, text: "\n", attributes: 0 })
    })
    return new StyledText(chunks)
  })

  createEffect(() => {
    if (!text) return
    text.content = content()
  })

  return (
    <box
      ref={(item: BoxRenderable) => (box = item)}
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      zIndex={0}
    >
      <text
        ref={(item: TextRenderable) => {
          text = item
          item.content = content()
        }}
        width="100%"
        height="100%"
        wrapMode="none"
        selectable={false}
      />
    </box>
  )
}
