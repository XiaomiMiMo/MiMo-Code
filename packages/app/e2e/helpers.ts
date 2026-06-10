import { createHash } from "node:crypto"
import { execSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { APIRequestContext } from "@playwright/test"

export function base64Encode(value: string) {
  const bytes = new TextEncoder().encode(value)
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("")
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

export function mimocodeHome() {
  return process.env.MIMOCODE_HOME ?? path.join(os.tmpdir(), "mimocode-playwright")
}

export async function createGitProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mimocode-e2e-project-"))
  execSync("git init && git config user.email test@mimocode.test && git config user.name Test && git commit --allow-empty -m init", {
    cwd: dir,
    stdio: "ignore",
  })
  return dir
}

export function projectMemoryId(projectDir: string) {
  return createHash("sha256").update(projectDir).digest("hex").slice(0, 12)
}

export async function seedProjectMemory(projectDir: string, body: string) {
  const memoryDir = path.join(mimocodeHome(), "data", "memory", "projects", projectMemoryId(projectDir))
  await fs.mkdir(memoryDir, { recursive: true })
  await fs.writeFile(path.join(memoryDir, "MEMORY.md"), body, "utf8")
}

export async function waitForServer(request: APIRequestContext, serverUrl: string) {
  for (let i = 0; i < 60; i++) {
    const res = await request.get(`${serverUrl}/global/health`).catch(() => null)
    if (res?.ok()) return
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Server not ready at ${serverUrl}`)
}
