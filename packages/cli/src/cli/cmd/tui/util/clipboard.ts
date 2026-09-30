import { platform, release } from "os"
import { lazy } from "../../../../util/lazy.js"
import { tmpdir } from "os"
import path from "path"
import fs from "fs/promises"
import * as Filesystem from "../../../../util/filesystem"
import * as Process from "../../../../util/process"

// Lazy load which and clipboardy to avoid expensive execa/which/isexe chain at startup
const getWhich = lazy(async () => {
  const { which } = await import("../../../../util/which")
  return which
})

const getClipboardy = lazy(async () => {
  const { default: clipboardy } = await import("clipboardy")
  return clipboardy
})

/**
 * Writes text to clipboard via OSC 52 escape sequence.
 * This allows clipboard operations to work over SSH by having
 * the terminal emulator handle the clipboard locally.
 */
function writeOsc52(text: string): void {
  if (!process.stdout.isTTY) return
  const base64 = Buffer.from(text).toString("base64")
  const osc52 = `\x1b]52;c;${base64}\x07`
  const passthrough = process.env["TMUX"] || process.env["STY"]
  const sequence = passthrough ? `\x1bPtmux;\x1b${osc52}\x1b\\` : osc52
  process.stdout.write(sequence)
}

export interface Content {
  data: string
  mime: string
}

export async function spillImage(content: { data: string; mime: string }): Promise<string> {
  const ext = content.mime === "image/png" ? "png" : content.mime === "image/jpeg" ? "jpg" : "bin"
  const file = path.join(tmpdir(), `opencode-paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`)
  await Bun.write(file, Buffer.from(content.data, "base64"))
  return file
}

// Reads an image off the macOS clipboard as PNG, whatever representation the
// source app put there (screenshots, PixPin, copied files, other tools).
//
// Enumerating specific pasteboard classes ("PNGf", TIFF) is fragile: it only
// matches sources that happen to publish that exact type. Instead we ask AppKit
// to decode ANY available image representation into an NSImage and re-encode it
// to PNG — the same path native apps use — so format detection is the system's
// job, not ours. `pngpaste` (if installed) is a faster shortcut for the common
// case; the osascript path is a last resort when Swift tooling is unavailable.
async function readDarwinClipboardImage(): Promise<Content | undefined> {
  const dest = path.join(tmpdir(), `opencode-clipboard-${Date.now()}.png`)
  try {
    // Fast path: pngpaste (brew) reads any image representation as PNG.
    const which = await getWhich()
    if (which("pngpaste")) {
      const out = await Process.run(["pngpaste", dest], { nothrow: true })
      if (out.code === 0) {
        const buf = await Filesystem.readBytes(dest).catch(() => Buffer.alloc(0))
        if (buf.length > 0) return { data: buf.toString("base64"), mime: "image/png" }
      }
    }

    // Primary path: let AppKit decode any image representation → PNG. Use JXA
    // (osascript -l JavaScript) rather than `swift`, which recompiles on every
    // invocation (multi-second cold stall) and needs Xcode CLT. JXA is
    // interpreted, always available, and reaches the same AppKit APIs.
    const jxa = [
      "ObjC.import('AppKit');",
      "const pb = $.NSPasteboard.generalPasteboard;",
      "const img = $.NSImage.alloc.initWithPasteboard(pb);",
      "if (!img) { $.exit(1); }",
      "const tiff = img.TIFFRepresentation;",
      "if (!tiff) { $.exit(1); }",
      "const rep = $.NSBitmapImageRep.imageRepWithData(tiff);",
      "const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());",
      "if (!png) { $.exit(1); }",
      `png.writeToFileAtomically($('${dest}'), true);`,
    ].join("\n")
    const jxaOut = await Process.run(["osascript", "-l", "JavaScript", "-e", jxa], { nothrow: true })
    if (jxaOut.code === 0) {
      const buf = await Filesystem.readBytes(dest).catch(() => Buffer.alloc(0))
      if (buf.length > 0) return { data: buf.toString("base64"), mime: "image/png" }
    }

    // Last resort: osascript PNGf, then TIFF via sips. Works even on the rare
    // system where JXA/AppKit is unavailable, but only matches those two classes.
    const dumpClipboard = async (clazz: string, out: string) => {
      await Process.run(
        [
          "osascript",
          "-e",
          `set imageData to the clipboard as ${clazz}`,
          "-e",
          `set fileRef to open for access POSIX file "${out}" with write permission`,
          "-e",
          "set eof fileRef to 0",
          "-e",
          "write imageData to fileRef",
          "-e",
          "close access fileRef",
        ],
        { nothrow: true },
      )
      return Filesystem.readBytes(out).catch(() => Buffer.alloc(0))
    }
    const png = await dumpClipboard('"PNGf"', dest)
    if (png.length > 0) return { data: png.toString("base64"), mime: "image/png" }
    const tifffile = dest.replace(/\.png$/, ".tiff")
    try {
      const tiff = await dumpClipboard("«class TIFF»", tifffile)
      if (tiff.length > 0) {
        await Process.run(["sips", "-s", "format", "png", tifffile, "--out", dest], { nothrow: true })
        const converted = await Filesystem.readBytes(dest).catch(() => Buffer.alloc(0))
        if (converted.length > 0) return { data: converted.toString("base64"), mime: "image/png" }
      }
    } finally {
      await fs.rm(tifffile, { force: true }).catch(() => {})
    }
    return undefined
  } finally {
    await fs.rm(dest, { force: true }).catch(() => {})
  }
}

// Checks clipboard for images first, then falls back to text.
//
// On Windows prompt/ can call this from multiple paste signals because
// terminals surface image paste differently:
//   1. A forwarded Ctrl+V keypress
//   2. An empty bracketed-paste hint for image-only clipboard in Windows
//      Terminal <1.25
//   3. A kitty Ctrl+V key-release fallback for Windows Terminal 1.25+
export async function read(): Promise<Content | undefined> {
  const os = platform()

  if (os === "darwin") {
    const image = await readDarwinClipboardImage()
    if (image) return image
  }

  // Windows/WSL: probe clipboard for images via PowerShell.
  // Bracketed paste can't carry image data so we read it directly.
  if (os === "win32" || release().includes("WSL")) {
    const script =
      "Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $ms = New-Object System.IO.MemoryStream; $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [System.Convert]::ToBase64String($ms.ToArray()) }"
    const base64 = await Process.text(["powershell.exe", "-NonInteractive", "-NoProfile", "-command", script], {
      nothrow: true,
    })
    if (base64.text) {
      const imageBuffer = Buffer.from(base64.text.trim(), "base64")
      if (imageBuffer.length > 0) {
        return { data: imageBuffer.toString("base64"), mime: "image/png" }
      }
    }
  }

  if (os === "linux") {
    const wayland = await Process.run(["wl-paste", "-t", "image/png"], { nothrow: true })
    if (wayland.stdout.byteLength > 0) {
      return { data: Buffer.from(wayland.stdout).toString("base64"), mime: "image/png" }
    }
    const x11 = await Process.run(["xclip", "-selection", "clipboard", "-t", "image/png", "-o"], {
      nothrow: true,
    })
    if (x11.stdout.byteLength > 0) {
      return { data: Buffer.from(x11.stdout).toString("base64"), mime: "image/png" }
    }
  }

  const clipboardy = await getClipboardy()
  const text = await clipboardy.read().catch(() => {})
  if (text) {
    return { data: text, mime: "text/plain" }
  }
}

const getCopyMethod = lazy(async () => {
  const os = platform()
  const which = await getWhich()

  if (os === "darwin" && which("osascript")) {
    console.log("clipboard: using osascript")
    return async (text: string) => {
      const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
      await Process.run(["osascript", "-e", `set the clipboard to "${escaped}"`], { nothrow: true })
    }
  }

  if (os === "linux") {
    if (process.env["WAYLAND_DISPLAY"] && which("wl-copy")) {
      console.log("clipboard: using wl-copy")
      return async (text: string) => {
        const proc = Process.spawn(["wl-copy"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" })
        if (!proc.stdin) return
        proc.stdin.write(text)
        proc.stdin.end()
        await proc.exited.catch(() => {})
      }
    }
    if (which("xclip")) {
      console.log("clipboard: using xclip")
      return async (text: string) => {
        const proc = Process.spawn(["xclip", "-selection", "clipboard"], {
          stdin: "pipe",
          stdout: "ignore",
          stderr: "ignore",
        })
        if (!proc.stdin) return
        proc.stdin.write(text)
        proc.stdin.end()
        await proc.exited.catch(() => {})
      }
    }
    if (which("xsel")) {
      console.log("clipboard: using xsel")
      return async (text: string) => {
        const proc = Process.spawn(["xsel", "--clipboard", "--input"], {
          stdin: "pipe",
          stdout: "ignore",
          stderr: "ignore",
        })
        if (!proc.stdin) return
        proc.stdin.write(text)
        proc.stdin.end()
        await proc.exited.catch(() => {})
      }
    }
  }

  if (os === "win32") {
    console.log("clipboard: using powershell")
    return async (text: string) => {
      // Pipe via stdin to avoid PowerShell string interpolation ($env:FOO, $(), etc.)
      const proc = Process.spawn(
        [
          "powershell.exe",
          "-NonInteractive",
          "-NoProfile",
          "-Command",
          "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
        ],
        {
          stdin: "pipe",
          stdout: "ignore",
          stderr: "ignore",
        },
      )

      if (!proc.stdin) return
      proc.stdin.write(text)
      proc.stdin.end()
      await proc.exited.catch(() => {})
    }
  }

  console.log("clipboard: no native support")
  return async (text: string) => {
    const clipboardy = await getClipboardy()
    await clipboardy.write(text).catch(() => {})
  }
})

export async function copy(text: string): Promise<void> {
  writeOsc52(text)
  const method = await getCopyMethod()
  await method(text)
}
