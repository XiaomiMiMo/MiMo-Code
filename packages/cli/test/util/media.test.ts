import { describe, expect, test } from "bun:test"
import {
  base64Length,
  fitsMediaBase64,
  isMedia,
  isReadAttachmentMime,
  isReadAudioMime,
  isReadImageMime,
  isReadPdfMime,
  isReadVideoMime,
  looksLikeMediaMime,
  MAX_MEDIA_BASE64_BYTES,
  readMimeAllowlist,
  sniffAttachmentMime,
} from "../../src/util/media"

describe("util.media", () => {
  test("bounds inline audio/video on the encoded size", () => {
    // 3 raw bytes encode to 4; the last byte under the limit is 3/4 of it.
    const raw = (MAX_MEDIA_BASE64_BYTES / 4) * 3
    expect(base64Length(raw)).toBe(MAX_MEDIA_BASE64_BYTES)
    expect(fitsMediaBase64(raw)).toBe(true)
    expect(fitsMediaBase64(raw + 1)).toBe(false)
    expect(base64Length(Buffer.from("hello").byteLength)).toBe(Buffer.from("hello").toString("base64").length)
  })

  test("treats audio and video as media", () => {
    expect(isMedia("audio/wav")).toBe(true)
    expect(isMedia("video/mp4")).toBe(true)
    expect(isMedia("image/png")).toBe(true)
    expect(isMedia("text/plain")).toBe(false)
  })

  test("sniffs a RIFF/WAVE header as audio/wav", () => {
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")])
    expect(sniffAttachmentMime(wav, "application/octet-stream")).toBe("audio/wav")
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")])
    expect(sniffAttachmentMime(webp, "application/octet-stream")).toBe("image/webp")
  })

  test("finite read allowlist accepts only familiar formats", () => {
    expect(isReadImageMime("image/jpeg")).toBe(true)
    expect(isReadImageMime("image/png")).toBe(true)
    expect(isReadImageMime("image/webp")).toBe(true)
    expect(isReadImageMime("image/gif")).toBe(true)
    expect(isReadImageMime("image/bmp")).toBe(false)
    expect(isReadImageMime("image/svg+xml")).toBe(false)

    expect(isReadAudioMime("audio/wav")).toBe(true)
    expect(isReadAudioMime("audio/mpeg")).toBe(true)
    expect(isReadAudioMime("audio/flac")).toBe(false)
    expect(isReadAudioMime("audio/m4a")).toBe(false)

    expect(isReadVideoMime("video/mp4")).toBe(true)
    expect(isReadVideoMime("video/quicktime")).toBe(false)
    expect(isReadVideoMime("video/webm")).toBe(false)
    expect(isReadVideoMime("video/mp2t")).toBe(false)

    expect(isReadPdfMime("application/pdf")).toBe(true)
    expect(isReadAttachmentMime("video/mp2t")).toBe(false)
    expect(isReadAttachmentMime("image/png")).toBe(true)
  })

  test("prefix media-likeness does not imply attachable", () => {
    expect(looksLikeMediaMime("video/mp2t")).toBe(true)
    expect(isReadVideoMime("video/mp2t")).toBe(false)
    expect(looksLikeMediaMime("image/bmp")).toBe(true)
    expect(isReadImageMime("image/bmp")).toBe(false)
    expect(readMimeAllowlist("video/mp2t")).toContain("video/mp4")
    expect(readMimeAllowlist("text/plain")).toBeUndefined()
  })
})
