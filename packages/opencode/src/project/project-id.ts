import * as fs from "fs"
import * as path from "path"
import * as crypto from "crypto"
import { ProjectID } from "./schema"

export function resolveMainGitDir(startDir: string): string | null {
  if (!startDir) return null
  let dir = path.resolve(startDir)
  while (true) {
    const candidate = path.join(dir, ".git")
    try {
      if (fs.existsSync(candidate)) {
        const stat = fs.statSync(candidate)
        if (stat.isDirectory()) return candidate
        const content = fs.readFileSync(candidate, "utf-8").trim()
        const match = content.match(/^gitdir:\s*(.+)$/)
        if (!match) return null
        return path.resolve(dir, match[1], "../..")
      }
    } catch {
      // Handle EACCES/EPERM gracefully
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function readFileTrimmedOrNull(p: string): string | null {
  if (!fs.existsSync(p)) return null
  const text = fs.readFileSync(p, "utf-8").trim()
  return text || null
}

export function resolveProjectId(workingDir: string): ProjectID {
  if (!workingDir || workingDir === "/" || path.parse(workingDir).root === workingDir) {
    return ProjectID.global
  }

  try {
    const mainGit = resolveMainGitDir(workingDir)

    if (mainGit) {
      const idFile = path.join(mainGit, "mimocode-project-id")
      const cached = readFileTrimmedOrNull(idFile)
      if (cached) return ProjectID.make(cached)
      const newId = crypto.randomUUID()
      fs.writeFileSync(idFile, newId)
      return ProjectID.make(newId)
    }

    const localFile = path.join(workingDir, ".mimocode-project-id")
    const cached = readFileTrimmedOrNull(localFile)
    if (cached) return ProjectID.make(cached)
    const newId = crypto.randomUUID()
    fs.writeFileSync(localFile, newId)
    return ProjectID.make(newId)
  } catch {
    return ProjectID.global
  }
}
