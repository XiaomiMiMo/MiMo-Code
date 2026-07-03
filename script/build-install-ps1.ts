#!/usr/bin/env bun

/**
 * Converts install-utf8.ps1 (human-editable, Unicode) to install.ps1 (ASCII-safe, deployable).
 * Non-ASCII characters are replaced with $([char]0xHHHH) PowerShell escape sequences.
 * Lines starting with #@build-remove are stripped from the output.
 */

const input = await Bun.file("install-utf8.ps1").text()
const lines = input.split("\n").filter((line) => !line.startsWith("#@build-remove"))

let output = ""
for (const char of lines.join("\n")) {
  const code = char.codePointAt(0)!
  if (code > 0x7e) {
    output += `$([char]0x${code.toString(16).padStart(4, "0")})`
  } else {
    output += char
  }
}

await Bun.write("install.ps1", output)
console.log("install.ps1 generated (ASCII-safe)")
