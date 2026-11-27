import { existsSync } from "fs"
import path from "path"
import { childProcessEnv } from "./child-process-env"
import { which } from "./which"

// Windows PowerShell ships at a fixed location; resolving it there keeps callers
// working when System32\WindowsPowerShell\v1.0 is missing from PATH.
export function executable() {
  const root = process.env.SystemRoot || process.env.windir
  if (root) {
    const file = path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    if (existsSync(file)) return file
  }
  return which("powershell.exe") ?? which("pwsh.exe") ?? "powershell.exe"
}

// A PSModulePath inherited from a pwsh parent lists PowerShell 7 modules first, so
// Windows PowerShell loads e.g. PS7's Archive module and fails on .NET Framework.
// Undefined entries are dropped by child_process, letting the child rebuild its default.
export function env(extra?: Record<string, string | undefined>) {
  const out: Record<string, string | undefined> = { ...extra }
  for (const key of ["PSModulePath", ...Object.keys(childProcessEnv())]) {
    if (key.toLowerCase() === "psmodulepath") out[key] = undefined
  }
  return out
}

export * as WindowsPowerShell from "./windows-powershell"
