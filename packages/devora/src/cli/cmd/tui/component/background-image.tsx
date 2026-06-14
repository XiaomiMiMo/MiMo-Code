import { createEffect, createMemo, createResource, onCleanup, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { RGBA, StyledText, type TextChunk, type TextRenderable } from "@opentui/core"
import { tint, useTheme } from "@tui/context/theme"
import { StarryBackground } from "./starry-background"
import { PNG } from "pngjs"
import jpeg from "jpeg-js"
import path from "path"
import { allocImageId, detectImageProtocol, kittyClear, kittyDisplay } from "../util/image-protocol"

const HALF_BLOCK = "▀"
const PROTOCOL = detectImageProtocol()
const IMAGE_ALPHA = 0.45

type Pixels = {
  data: Uint8Array | Buffer
  width: number
  height: number
}

async function decode(filePath: string): Promise<Pixels | undefined> {
  const file = Bun.file(filePath)
  if (!(await file.exists())) return undefined
  const buf = Buffer.from(await file.arrayBuffer())
  const ext = path.extname(filePath).toLowerCase()
  if (ext === ".png") {
    const png = PNG.sync.read(buf)
    return { data: png.data, width: png.width, height: png.height }
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    const decoded = jpeg.decode(buf, { useTArray: true })
    return { data: decoded.data, width: decoded.width, height: decoded.height }
  }
  return undefined
}

function sample(p: Pixels, sx: number, sy: number) {
  const x = Math.min(p.width - 1, Math.max(0, Math.floor(sx)))
  const y = Math.min(p.height - 1, Math.max(0, Math.floor(sy)))
  const i = (y * p.width + x) * 4
  return {
    r: p.data[i] ?? 0,
    g: p.data[i + 1] ?? 0,
    b: p.data[i + 2] ?? 0,
    a: p.data[i + 3] ?? 255,
  }
}

function pixelChunk(fg: RGBA, bg: RGBA): TextChunk {
  return { __isChunk: true, text: HALF_BLOCK, fg, bg, attributes: 0 }
}

function StyledBackgroundText(props: { content: () => StyledText | undefined }) {
  let text: TextRenderable | undefined

  createEffect(() => {
    const content = props.content()
    if (!text || !content) return
    text.content = content
  })

  return (
    <text
      ref={(item: TextRenderable) => {
        text = item
        const content = props.content()
        if (content) item.content = content
      }}
      width="100%"
      height="100%"
      wrapMode="none"
      selectable={false}
    />
  )
}

export function BackgroundImage(props: { path: string }) {
  const kitty = createMemo(() => PROTOCOL === "kitty" && path.extname(props.path).toLowerCase() === ".png")
  return (
    <Show when={kitty()} fallback={<BackgroundImageHalfBlock path={props.path} />}>
      <BackgroundImageKitty path={props.path} />
    </Show>
  )
}

function BackgroundImageKitty(props: { path: string }) {
  const dimensions = useTerminalDimensions()
  const id = allocImageId()
  createEffect(() => {
    const W = dimensions().width
    const H = dimensions().height
    const p = props.path
    if (!W || !H || !p) return
    kittyClear(id)
    void kittyDisplay({ id, filePath: p, cols: W, rows: H }).catch(() => {})
  })
  onCleanup(() => kittyClear(id))
  return null
}

function BackgroundImageHalfBlock(props: { path: string }) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const [pixels] = createResource(
    () => props.path,
    (p) => decode(p).catch(() => undefined),
  )

  const content = createMemo(() => {
    const p = pixels()
    const W = dimensions().width
    const H = dimensions().height
    if (!p || !W || !H) return undefined

    // "cover" fit: scale image to fully fill the screen, cropping excess.
    // Half-block doubles vertical resolution: each terminal row = 2 image rows.
    const targetW = W
    const targetH = H * 2
    const ratio = Math.max(targetW / p.width, targetH / p.height)
    const offsetX = (p.width * ratio - targetW) / 2
    const offsetY = (p.height * ratio - targetH) / 2
    const bg = theme.background
    const chunks: TextChunk[] = []

    Array.from({ length: H }).forEach((_, y) => {
      Array.from({ length: W }).forEach((_, x) => {
        const sx = (x + offsetX) / ratio
        const top = sample(p, sx, (y * 2 + offsetY) / ratio)
        const bot = sample(p, sx, (y * 2 + 1 + offsetY) / ratio)
        chunks.push(
          pixelChunk(
            top.a < 16 ? bg : tint(bg, RGBA.fromInts(top.r, top.g, top.b), IMAGE_ALPHA),
            bot.a < 16 ? bg : tint(bg, RGBA.fromInts(bot.r, bot.g, bot.b), IMAGE_ALPHA),
          ),
        )
      })
      if (y < H - 1) chunks.push({ __isChunk: true, text: "\n", attributes: 0 })
    })

    return new StyledText(chunks)
  })

  return (
    <Show when={content()} fallback={<StarryBackground />}>
      <box position="absolute" top={0} left={0} width="100%" height="100%" zIndex={0}>
        <StyledBackgroundText content={content} />
      </box>
    </Show>
  )
}
