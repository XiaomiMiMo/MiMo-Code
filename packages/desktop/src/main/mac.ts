import { execFile } from "node:child_process"
import { join } from "node:path"
import { promisify } from "node:util"

import { Notification, app, safeStorage } from "electron"

const execFileAsync = promisify(execFile)

const KEYCHAIN_SERVICE = "com.mimo-ai.desktop"

export function isMac() {
  return process.platform === "darwin"
}

// Keychain 凭据存储 —— 走 safeStorage (Electron) 加密后落 disk
// 安全模型：数据用系统 Keychain 派生的 key 加密，存到 userData/credentials/<name>.bin
// 卸载时需要在 Keychain Access 里手动删除 "OpenCode Safe Storage" 项
export async function credentialSet(name: string, value: string): Promise<void> {
  if (!isMac()) {
    throw new Error("credentialSet is only available on macOS")
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("safeStorage encryption not available on this macOS user account")
  }
  const encrypted = safeStorage.encryptString(value)
  // 直接落盘：safeStorage 已经在内部用了 Keychain 的 key
  const { writeFile } = await import("node:fs/promises")
  const { join } = await import("node:path")
  const path = join(credentialDir(), `${name}.bin`)
  await writeFile(path, encrypted, { mode: 0o600 })
}

export async function credentialGet(name: string): Promise<string | null> {
  if (!isMac()) return null
  try {
    const { readFile } = await import("node:fs/promises")
    const { join } = await import("node:path")
    const path = join(credentialDir(), `${name}.bin`)
    const encrypted = await readFile(path)
    return safeStorage.decryptString(encrypted)
  } catch {
    return null
  }
}

export async function credentialDelete(name: string): Promise<void> {
  if (!isMac()) return
  try {
    const { unlink } = await import("node:fs/promises")
    const { join } = await import("node:path")
    const path = join(credentialDir(), `${name}.bin`)
    await unlink(path)
  } catch {
    // 文件不存在视为成功
  }
}

function credentialDir() {
  return join(app.getPath("userData"), "credentials")
}

// Dock badge —— 用未读数显示在 dock icon 上
export function setDockBadge(text: string | number | null) {
  if (!isMac()) return
  if (text === null || text === "") {
    app.dock?.setBadge("")
    return
  }
  app.dock?.setBadge(String(text))
}

// 系统通知 —— 包装 Notification，附 silent 选项避免被系统静音时漏掉
export function showSystemNotification(opts: {
  title: string
  body?: string
  silent?: boolean
  subtitle?: string
}) {
  if (!Notification.isSupported()) return
  const n = new Notification({
    title: opts.title,
    body: opts.body,
    subtitle: opts.subtitle,
    silent: opts.silent,
  })
  n.show()
  return n
}

// AppleScript 桥 —— 让 GUI 能在 Terminal/iTerm/TUI attach 时调起系统终端
// 默认用 Terminal.app（系统自带），用户装 iTerm 也能用
type TerminalApp = "Terminal" | "iTerm"

export async function openInTerminal(command: string, terminal: TerminalApp = "Terminal"): Promise<void> {
  if (!isMac()) {
    throw new Error("openInTerminal is only available on macOS")
  }

  // 用 -e 模式给 Terminal.app 传命令；iTerm 用 tell session
  const script =
    terminal === "iTerm"
      ? `tell application "iTerm"
    create window with default profile
    tell current session of current window
      write text "${escapeForAppleScript(command)}"
    end tell
  end tell`
      : `tell application "Terminal"
    do script "${escapeForAppleScript(command)}"
    activate
  end tell`

  await execFileAsync("osascript", ["-e", script])
}

function escapeForAppleScript(value: string): string {
  // AppleScript string literal escape：反斜杠 + 双引号
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

// URL scheme 处理 —— `mimo://session/<id>` / `mimo://project?path=...`
// 已经在 index.ts 里注册了 opencode://，这里是 mimo:// 的别名入口
const URL_SCHEMES = ["mimo", "opencode"] as const

export function registerMacProtocolSchemes() {
  if (!isMac()) return
  for (const scheme of URL_SCHEMES) {
    if (!app.isDefaultProtocolClient(scheme)) {
      app.setAsDefaultProtocolClient(scheme)
    }
  }
}

// 系统能力探测 —— 给 renderer 一个 "mac features" 列表
export function macCapabilities() {
  if (!isMac()) {
    return { platform: process.platform, supports: {} as Record<string, boolean> }
  }
  return {
    platform: process.platform,
    supports: {
      keychain: safeStorage.isEncryptionAvailable(),
      notifications: Notification.isSupported(),
      dockBadge: typeof app.dock?.setBadge === "function",
      appleScript: true,
      universalClipboard: true,
      spotlight: true,
    },
  }
}
