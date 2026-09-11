import { app } from "electron"
import { join } from "node:path"
import { existsSync, mkdirSync } from "node:fs"

/**
 * 安装 CLI：在 ~/.local/bin/mimo 创建符号链接到当前进程的可执行路径。
 * 如果 ~/.local/bin 不存在则创建。
 */
export async function installCli(): Promise<string> {
  const home = app.getPath("home")
  const binDir = join(home, ".local", "bin")
  const linkPath = join(binDir, "mimo")
  const targetPath = process.execPath

  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true })
  }

  const fs = await import("node:fs/promises")
  if (existsSync(linkPath)) {
    const existing = await fs.readlink(linkPath).catch(() => null)
    if (existing === targetPath) return linkPath
    await fs.unlink(linkPath)
  }

  await fs.symlink(targetPath, linkPath)
  return linkPath
}
