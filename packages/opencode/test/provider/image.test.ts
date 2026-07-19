import { describe, expect, test } from "bun:test"
import { PNG } from "pngjs"
import jpeg from "jpeg-js"
import { compressImage, downscale, DEFAULT_MAX_IMAGE_BYTES } from "../../src/provider/image"

// --- helpers -------------------------------------------------------------

// Build an RGBA pixel buffer via a per-pixel painter, as pngjs/jpeg-js expect.
function makePixels(width: number, height: number, paint: (x: number, y: number) => [number, number, number, number]) {
  const data = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const [r, g, b, a] = paint(x, y)
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = a
    }
  }
  return { data, width, height }
}

function encodePng(width: number, height: number, paint: (x: number, y: number) => [number, number, number, number]) {
  const png = new PNG({ width, height })
  const pixels = makePixels(width, height, paint)
  pixels.data.copy(png.data)
  return PNG.sync.write(png)
}

function encodeJpeg(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number, number],
  quality = 90,
) {
  const pixels = makePixels(width, height, paint)
  return Buffer.from(jpeg.encode({ data: Buffer.from(pixels.data), width, height }, quality).data)
}

function base64Bytes(b64: string) {
  return Buffer.from(b64, "base64").length
}

// --- downscale: dimensions ----------------------------------------------

describe("downscale - output dimensions", () => {
  const src = makePixels(100, 80, () => [10, 20, 30, 255])

  test.each([
    [0.5, 50, 40],
    [0.25, 25, 20],
    [0.15, 15, 12],
    [0.1, 10, 8],
  ])("scale %p -> %p x %p", (scale, w, h) => {
    const out = downscale(src, scale)
    expect(out.width).toBe(w)
    expect(out.height).toBe(h)
    expect(out.data.length).toBe(w * h * 4)
  })

  test("never produces a zero dimension (clamped to >= 1)", () => {
    const out = downscale(makePixels(3, 3, () => [0, 0, 0, 255]), 0.01)
    expect(out.width).toBeGreaterThanOrEqual(1)
    expect(out.height).toBeGreaterThanOrEqual(1)
  })
})

// --- downscale: area-averaging correctness ------------------------------

describe("downscale - area-averaging correctness", () => {
  // A 2x2 image with four distinct colors, halved to 1x1, must average all four.
  // Nearest-neighbor would pick a single corner and get this wrong.
  test("2x2 distinct colors halve to their average", () => {
    const src = makePixels(2, 2, (x, y) => {
      if (x === 0 && y === 0) return [0, 0, 0, 255] // black
      if (x === 1 && y === 0) return [255, 0, 0, 255] // red
      if (x === 0 && y === 1) return [0, 255, 0, 255] // green
      return [0, 0, 255, 255] // blue
    })
    const out = downscale(src, 0.5)
    expect(out.width).toBe(1)
    expect(out.height).toBe(1)
    // mean of {0,255,0,0}=63.75->64 ; {0,0,255,0}=63.75->64 ; {0,0,0,255}=63.75->64
    expect(out.data[0]).toBe(64) // R: (0+255+0+0)/4
    expect(out.data[1]).toBe(64) // G: (0+0+255+0)/4
    expect(out.data[2]).toBe(64) // B: (0+0+0+255)/4
    expect(out.data[3]).toBe(255) // fully opaque
  })

  // The value a nearest-neighbor sampler would return for this block is one of
  // the four corners (0 or 255), never the average (64). Prove we differ.
  test("differs from nearest-neighbor point-sampling", () => {
    const src = makePixels(2, 2, (x, y) => {
      if (x === 0 && y === 0) return [0, 0, 0, 255]
      if (x === 1 && y === 0) return [255, 0, 0, 255]
      if (x === 0 && y === 1) return [0, 255, 0, 255]
      return [0, 0, 255, 255]
    })
    const out = downscale(src, 0.5)
    expect([0, 255]).not.toContain(out.data[0])
  })

  // A uniform image must downscale to exactly the same uniform color (no drift).
  test("uniform color is preserved exactly", () => {
    const src = makePixels(40, 40, () => [123, 45, 200, 255])
    const out = downscale(src, 0.25)
    for (let i = 0; i < out.data.length; i += 4) {
      expect(out.data[i]).toBe(123)
      expect(out.data[i + 1]).toBe(45)
      expect(out.data[i + 2]).toBe(200)
      expect(out.data[i + 3]).toBe(255)
    }
  })

  // A sharp black/white vertical split, halved, yields mid-gray at the seam
  // (averaging) rather than a hard 0-or-255 edge (nearest-neighbor).
  test("high-contrast edge blends toward gray (anti-aliasing)", () => {
    const src = makePixels(4, 2, (x) => (x < 2 ? [0, 0, 0, 255] : [255, 255, 255, 255]))
    // 4x2 -> 2x1: each dest pixel covers one solid half, so still 0 and 255.
    const half = downscale(src, 0.5)
    expect(half.data[0]).toBe(0)
    expect(half.data[4]).toBe(255)
    // 4x2 -> 3x1 forces a dest pixel straddling the seam -> intermediate gray.
    const three = downscale(src, 0.75)
    expect(three.width).toBe(3)
    const mid = three.data[4] // middle pixel R channel
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(255)
  })

  // Fully-transparent source must not drag RGB toward black in the average.
  test("fully transparent region keeps alpha at 0", () => {
    const src = makePixels(2, 2, () => [255, 255, 255, 0])
    const out = downscale(src, 0.5)
    expect(out.data[3]).toBe(0)
  })
})

// --- compressImage: shrinks under the cap -------------------------------

describe("compressImage - brings oversized images under the cap", () => {
  // A large noisy PNG: noise defeats PNG's own compression so the source is big,
  // and forces the JPEG ladder to actually step down quality/scale.
  function noisyPng(size: number) {
    let seed = 12345
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % 256
    }
    return encodePng(size, size, () => [rand(), rand(), rand(), 255])
  }

  test("large PNG is compressed to valid JPEG base64 under maxBytes", () => {
    const bytes = noisyPng(900) // ~900x900 noise -> comfortably > cap once raw
    const maxBytes = 200_000
    const out = compressImage("image/png", bytes, maxBytes)
    expect(out).toBeDefined()
    expect(out!.mediaType).toBe("image/jpeg")
    // Decoded output really is under the cap.
    expect(base64Bytes(out!.data)).toBeLessThanOrEqual(maxBytes)
    // ...and really is a decodable JPEG.
    const decoded = jpeg.decode(Buffer.from(out!.data, "base64"), { useTArray: true })
    expect(decoded.width).toBeGreaterThan(0)
    expect(decoded.height).toBeGreaterThan(0)
  })

  test("respects DEFAULT_MAX_IMAGE_BYTES for a genuinely huge image", () => {
    const bytes = noisyPng(1600)
    const out = compressImage("image/png", bytes, DEFAULT_MAX_IMAGE_BYTES)
    expect(out).toBeDefined()
    expect(base64Bytes(out!.data)).toBeLessThanOrEqual(DEFAULT_MAX_IMAGE_BYTES)
  })

  // The quality/scale ladder must shrink progressively: a tighter cap must not
  // produce a LARGER output than a looser cap for the same source.
  test("tighter cap yields a smaller (or equal) output", () => {
    const bytes = noisyPng(700)
    const loose = compressImage("image/png", bytes, 300_000)
    const tight = compressImage("image/png", bytes, 60_000)
    expect(loose).toBeDefined()
    expect(tight).toBeDefined()
    expect(base64Bytes(tight!.data)).toBeLessThanOrEqual(base64Bytes(loose!.data))
    expect(base64Bytes(tight!.data)).toBeLessThanOrEqual(60_000)
  })
})

// --- compressImage: already-small round-trips ---------------------------

describe("compressImage - image already under the cap", () => {
  test("small image returns valid JPEG within the cap (scale=1 path)", () => {
    const bytes = encodeJpeg(16, 16, () => [40, 120, 200, 255])
    const out = compressImage("image/jpeg", bytes, DEFAULT_MAX_IMAGE_BYTES)
    expect(out).toBeDefined()
    expect(out!.mediaType).toBe("image/jpeg")
    expect(base64Bytes(out!.data)).toBeLessThanOrEqual(DEFAULT_MAX_IMAGE_BYTES)
    const decoded = jpeg.decode(Buffer.from(out!.data, "base64"), { useTArray: true })
    // Dimensions preserved because it fit at the first (scale=1) rung.
    expect(decoded.width).toBe(16)
    expect(decoded.height).toBe(16)
  })

  test("small PNG round-trips to a decodable JPEG", () => {
    const bytes = encodePng(24, 24, (x, y) => [x * 10, y * 10, 100, 255])
    const out = compressImage("image/png", bytes, DEFAULT_MAX_IMAGE_BYTES)
    expect(out).toBeDefined()
    const decoded = jpeg.decode(Buffer.from(out!.data, "base64"), { useTArray: true })
    expect(decoded.width).toBe(24)
    expect(decoded.height).toBe(24)
  })
})

// --- compressImage: undecodable / failure paths -------------------------

describe("compressImage - undecodable formats return undefined", () => {
  test("webp mime (no pure-JS decoder) returns undefined", () => {
    // RIFF....WEBP header bytes; we have no webp decoder so this can't be shrunk.
    const fakeWebp = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ])
    expect(compressImage("image/webp", fakeWebp, DEFAULT_MAX_IMAGE_BYTES)).toBeUndefined()
  })

  test("gif mime returns undefined", () => {
    const fakeGif = Buffer.from("GIF89a", "ascii")
    expect(compressImage("image/gif", fakeGif, DEFAULT_MAX_IMAGE_BYTES)).toBeUndefined()
  })

  test("corrupt PNG bytes under a png mime return undefined (decode throws)", () => {
    const garbage = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03, 0x04])
    expect(compressImage("image/png", garbage, DEFAULT_MAX_IMAGE_BYTES)).toBeUndefined()
  })

  test("empty buffer returns undefined", () => {
    expect(compressImage("image/png", Buffer.alloc(0), DEFAULT_MAX_IMAGE_BYTES)).toBeUndefined()
  })
})
