import { invoke } from "@tauri-apps/api/core"
import { open, save } from "@tauri-apps/plugin-dialog"
import { readText, writeText, readImage } from "@tauri-apps/plugin-clipboard-manager"
import { sendNotification } from "@tauri-apps/plugin-notification"
import { relaunch } from "@tauri-apps/plugin-process"
import { openUrl } from "@tauri-apps/plugin-opener"
import { getCurrentWindow } from "@tauri-apps/api/window"
import type { ElectronAPI } from "../../desktop/src/preload/types"

export type { ElectronAPI }

async function safeInvoke<T>(cmd: string, args?: Record<string, unknown>, fallback?: T): Promise<T> {
  try {
    return await invoke<T>(cmd, args)
  } catch {
    return fallback as T
  }
}

export function setupTauriBridge(): void {
  const appWindow = getCurrentWindow()

  let draggingPromise: Promise<void> | null = null
  const safeStartDragging = () => {
    if (draggingPromise) return draggingPromise
    draggingPromise = appWindow.startDragging().finally(() => {
      draggingPromise = null
    })
    return draggingPromise
  }

  let lastToggleTime = 0
  const safeToggleMaximize = async () => {
    const now = Date.now()
    if (now - lastToggleTime < 300) return
    lastToggleTime = now
    return appWindow.toggleMaximize().catch(() => {})
  }

  // 注入 __TAURI__ 全局对象，以使 titlebar.tsx 等 UI 组件能顺利感知 startDragging 与 toggleMaximize
  ;(window as any).__TAURI__ = {
    window: {
      getCurrentWindow: () => ({
        startDragging: safeStartDragging,
        toggleMaximize: safeToggleMaximize,
      }),
    },
  }

  const tauriApi: ElectronAPI = {
    killSidecar: () => Promise.resolve(),
    installCli: () => Promise.resolve(""),
    awaitInitialization: async () => {
      // 提供连接默认本地 sidecar 的服务器信息与匹配密钥
      return {
        url: "http://127.0.0.1:4096",
        username: "opencode",
        password: "mimocode-desktop-secret",
      }
    },
    getWindowConfig: () => Promise.resolve({ updaterEnabled: false }),
    consumeInitialDeepLinks: () => Promise.resolve([]),
    getDefaultServerUrl: () => Promise.resolve(null),
    setDefaultServerUrl: () => Promise.resolve(),
    getWslConfig: () => Promise.resolve({ enabled: false }),
    setWslConfig: () => Promise.resolve(),
    getDisplayBackend: () => Promise.resolve(null),
    setDisplayBackend: () => Promise.resolve(),
    parseMarkdownCommand: (markdown) => Promise.resolve(markdown),
    checkAppExists: () => Promise.resolve(true),
    wslPath: (path) => Promise.resolve(path),
    resolveAppPath: (appName) => Promise.resolve(appName),
    
    // Store 走 Web LocalStorage 作为全平台 Safe Fallback
    storeGet: async (name, key) => {
      const raw = localStorage.getItem(`${name}:${key}`)
      if (!raw) return null
      try { return JSON.parse(raw) } catch { return raw }
    },
    storeSet: async (name, key, value) => {
      localStorage.setItem(`${name}:${key}`, JSON.stringify(value))
    },
    storeDelete: async (name, key) => {
      localStorage.removeItem(`${name}:${key}`)
    },
    storeClear: async (name) => {
      const keys = Object.keys(localStorage).filter(k => k.startsWith(`${name}:`))
      for (const k of keys) localStorage.removeItem(k)
    },
    storeKeys: async (name) => {
      return Object.keys(localStorage)
        .filter(k => k.startsWith(`${name}:`))
        .map(k => k.slice(name.length + 1))
    },
    storeLength: async (name) => {
      return Object.keys(localStorage).filter(k => k.startsWith(`${name}:`)).length
    },

    getWindowCount: () => Promise.resolve(1),
    onSqliteMigrationProgress: () => () => {},
    onMenuCommand: () => () => {},
    onDeepLink: () => () => {},

    openDirectoryPicker: async (opts) => {
      try {
        const res = await open({
          directory: true,
          multiple: opts?.multiple ?? false,
          title: opts?.title,
          defaultPath: opts?.defaultPath,
        })
        return res as string | string[] | null
      } catch {
        return null
      }
    },
    openFilePicker: async (opts) => {
      try {
        const res = await open({
          directory: false,
          multiple: opts?.multiple ?? false,
          title: opts?.title,
          defaultPath: opts?.defaultPath,
        })
        return res as string | string[] | null
      } catch {
        return null
      }
    },
    saveFilePicker: async (opts) => {
      try {
        const res = await save({
          defaultPath: opts?.defaultPath,
          title: opts?.title,
        })
        return res
      } catch {
        return null
      }
    },
    openLink: (url) => {
      void openUrl(url).catch(() => window.open(url, "_blank"))
    },
    openPath: (path) => safeInvoke("open_path", { path }),
    readClipboardImage: async () => {
      try {
        const img = await readImage()
        if (!img) return null
        const bytes = await img.rgba()
        return {
          buffer: bytes.buffer as ArrayBuffer,
          width: 0,
          height: 0,
        }
      } catch {
        return null
      }
    },
    readClipboardText: () => readText().catch(() => ""),
    writeClipboardText: (text) => writeText(text).catch(() => {}),
    syncUniversalClipboard: () => Promise.resolve(""),
    showNotification: (title, body) => {
      void sendNotification({ title, body })
    },
    getWindowFocused: () => appWindow.isFocused().catch(() => true),
    setWindowFocus: () => appWindow.setFocus().catch(() => {}),
    showWindow: () => appWindow.show().catch(() => {}),
    relaunch: () => {
      void relaunch().catch(() => location.reload())
    },
    getZoomFactor: () => Promise.resolve(1),
    setZoomFactor: () => Promise.resolve(),
    setTitlebar: () => Promise.resolve(),
    loadingWindowComplete: () => {},
    runUpdater: () => Promise.resolve(),
    checkUpdate: () => Promise.resolve({ updateAvailable: false }),
    installUpdate: () => Promise.resolve(),
    setBackgroundColor: () => Promise.resolve(),
    setWindowTitle: (title) => appWindow.setTitle(title).catch(() => {}),
    setRecentProjects: () => Promise.resolve(),
    setCurrentSession: () => Promise.resolve(),
    onTrayCommand: () => () => {},

    mac: {
      capabilities: () => safeInvoke("mac_capabilities", undefined, { platform: "darwin", supports: { keychain: true, notifications: true, dockBadge: true, appleScript: true, universalClipboard: true, spotlight: true } }),
      credentialSet: async (name, value) => {
        localStorage.setItem(`cred:${name}`, value)
      },
      credentialGet: async (name) => {
        return localStorage.getItem(`cred:${name}`)
      },
      credentialDelete: async (name) => {
        localStorage.removeItem(`cred:${name}`)
      },
      openInTerminal: (command, terminal) => safeInvoke("mac_open_in_terminal", { command, terminal }),
      setDockBadge: () => Promise.resolve(),
      showNotification: (title, body) => {
        void sendNotification({ title, body })
      },
    },
  }

  // 挂载到全局对象，兼容现有 packages/app
  ;(window as any).api = tauriApi
}
