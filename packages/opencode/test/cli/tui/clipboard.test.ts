import { describe, expect, test } from "bun:test"
import { windowsCopyCommands, writeClipboardProcess } from "../../../src/cli/cmd/tui/util/clipboard"

describe("clipboard", () => {
  test("builds Windows copy commands with PowerShell before clip fallback", () => {
    const commands = windowsCopyCommands(
      (cmd) =>
        ({
          "powershell.exe": "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          "clip.exe": "C:\\Windows\\System32\\clip.exe",
        })[cmd] ?? null,
    )

    expect(commands).toHaveLength(2)
    expect(commands[0].slice(0, 4)).toEqual([
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "-NonInteractive",
      "-NoProfile",
      "-EncodedCommand",
    ])
    expect(Buffer.from(commands[0][4], "base64").toString("utf16le")).toContain("Set-Clipboard")
    expect(commands[1]).toEqual(["C:\\Windows\\System32\\clip.exe"])
  })

  test("reports whether a stdin copy process exited successfully", async () => {
    await expect(
      writeClipboardProcess(
        [
          process.execPath,
          "-e",
          "let text = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => text += chunk); process.stdin.on('end', () => process.exit(text === 'copy text' ? 0 : 2));",
        ],
        "copy text",
      ),
    ).resolves.toBe(true)

    await expect(writeClipboardProcess([process.execPath, "-e", "process.exit(9)"], "copy text")).resolves.toBe(false)
  })
})
