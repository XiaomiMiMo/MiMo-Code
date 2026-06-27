import { platform, release } from "os"
import { lazy } from "../../../../util/lazy.js"
import { tmpdir } from "os"
import path from "path"
import fs from "fs/promises"
import * as Filesystem from "../../../../util/filesystem"
import * as Process from "../../../../util/process"
import { errorMessage } from "../../../../util/error"

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

export type LinuxCopyCommand = {
  name: string
  command: string[]
}

export function getLinuxCopyCommands(env: NodeJS.ProcessEnv, which: (command: string) => unknown): LinuxCopyCommand[] {
  return [
    ...(env["WAYLAND_DISPLAY"] && which("wl-copy") ? [{ name: "wl-copy", command: ["wl-copy"] }] : []),
    ...(which("xclip") ? [{ name: "xclip", command: ["xclip", "-selection", "clipboard"] }] : []),
    ...(which("xsel") ? [{ name: "xsel", command: ["xsel", "--clipboard", "--input"] }] : []),
  ]
}

async function writeToCopyCommand(command: LinuxCopyCommand, text: string): Promise<void> {
  const proc = Process.spawn(command.command, { stdin: "pipe", stdout: "ignore", stderr: "ignore" })
  if (!proc.stdin) throw new Error(`${command.name} did not accept stdin`)
  proc.stdin.write(text)
  proc.stdin.end()
  const code = await proc.exited
  if (code !== 0) throw new Error(`${command.name} exited with code ${code}`)
}

export async function runLinuxCopyCommands(
  text: string,
  commands: LinuxCopyCommand[],
  write: (command: LinuxCopyCommand, text: string) => Promise<void> = writeToCopyCommand,
): Promise<void> {
  const failures: string[] = []
  for (const command of commands) {
    try {
      await write(command, text)
      return
    } catch (error) {
      failures.push(`${command.name}: ${errorMessage(error)}`)
    }
  }

  const details = failures.length ? ` Tried ${failures.join("; ")}.` : ""
  throw new Error(`Failed to copy to the clipboard on Linux. Install wl-clipboard, xclip, or xsel.${details}`)
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
    const tmpfile = path.join(tmpdir(), "opencode-clipboard.png")
    try {
      await Process.run(
        [
          "osascript",
          "-e",
          'set imageData to the clipboard as "PNGf"',
          "-e",
          `set fileRef to open for access POSIX file "${tmpfile}" with write permission`,
          "-e",
          "set eof fileRef to 0",
          "-e",
          "write imageData to fileRef",
          "-e",
          "close access fileRef",
        ],
        { nothrow: true },
      )
      const buffer = await Filesystem.readBytes(tmpfile)
      return { data: buffer.toString("base64"), mime: "image/png" }
    } catch {
    } finally {
      await fs.rm(tmpfile, { force: true }).catch(() => {})
    }
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
    const commands = getLinuxCopyCommands(process.env, (command) => which(command))
    if (commands.length) {
      console.log(`clipboard: using ${commands.map((command) => command.name).join(", ")}`)
      return async (text: string) => runLinuxCopyCommands(text, commands)
    }

    console.log("clipboard: using clipboardy")
    return async (text: string) => {
      try {
        const clipboardy = await getClipboardy()
        await clipboardy.write(text)
      } catch (error) {
        throw new Error(
          `Failed to copy to the clipboard on Linux. Install wl-clipboard, xclip, or xsel. ${errorMessage(error)}`,
        )
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
    await clipboardy.write(text)
  }
})

export async function copy(text: string): Promise<void> {
  writeOsc52(text)
  const method = await getCopyMethod()
  await method(text)
}
