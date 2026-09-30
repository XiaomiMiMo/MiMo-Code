const SUPPORTED_IDES = [
  "Windsurf",
  "Visual Studio Code - Insiders",
  "Visual Studio Code",
  "Cursor",
  "VSCodium",
] as const

export function ide() {
  if (process.env["TERM_PROGRAM"] === "vscode") {
    const v = process.env["GIT_ASKPASS"]
    for (const ide of SUPPORTED_IDES) {
      if (v?.includes(ide)) return ide
    }
  }
  return "unknown"
}

export * as Ide from "."
