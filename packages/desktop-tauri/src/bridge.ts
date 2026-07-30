import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { open, save } from "@tauri-apps/plugin-dialog"
import { readText, writeText, readImage } from "@tauri-apps/plugin-clipboard-manager"
import { sendNotification } from "@tauri-apps/plugin-notification"
import { relaunch } from "@tauri-apps/plugin-process"
import { openUrl } from "@tauri-apps/plugin-opener"
import { getCurrentWindow } from "@tauri-apps/api/window"
import type { ElectronAPI } from "../../desktop/src/preload/types"

export type { ElectronAPI }

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function checkUpdate() {
  // tauri-plugin-updater check is handled via the plugin;
  // we expose the Electron-compatible API for the UI layer
  return invoke<{ updateAvailable: boolean; version?: string }>("tauri_plugin_updater_check_update", {})
    .then((result) => ({
      updateAvailable: true,
      version: result.version,
    }))
    .catch(() => ({ updateAvailable: false }))
}

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

  const safeToggleMaximize = async () => {
    // macOS AppKit handles double-click on titlebar natively via performZoom.
    // JS-side is no-op to avoid conflicts.
    return
  }

  // Inject __TAURI__ global for titlebar.tsx etc.
  ;(window as any).__TAURI__ = {
    window: {
      getCurrentWindow: () => ({
        startDragging: safeStartDragging,
        toggleMaximize: safeToggleMaximize,
      }),
    },
  }

  // Listen for menu-command events from Rust (check_updates etc.)
  const menuUnlisten = listen<string>("menu-command", (event) => {
    window.dispatchEvent(new CustomEvent("menu-command", { detail: event.payload }))
  })

  const tauriApi: ElectronAPI = {
    killSidecar: () => Promise.resolve(),
    installCli: () => Promise.resolve(""),
    awaitInitialization: async () => ({
      url: "http://127.0.0.1:4096",
      username: "opencode",
      password: "mimocode-desktop-secret",
    }),
    getWindowConfig: () => Promise.resolve({ updaterEnabled: true }),
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

    // Store via tauri-plugin-store (persistent JSON)
    storeGet: async (name, key) => {
      try {
        // Use tauri-plugin-store's store API
        const { Store } = await import("@tauri-apps/plugin-store")
        const store = await Store.load(name)
        const val = await store.get<string>(key)
        return val ?? null
      } catch {
        // Fallback to localStorage
        const raw = localStorage.getItem(`${name}:${key}`)
        if (!raw) return null
        try { return JSON.parse(raw) } catch { return raw }
      }
    },
    storeSet: async (name, key, value) => {
      try {
        const { Store } = await import("@tauri-apps/plugin-store")
        const store = await Store.load(name)
        await store.set(key, value)
        await store.save()
      } catch {
        localStorage.setItem(`${name}:${key}`, JSON.stringify(value))
      }
    },
    storeDelete: async (name, key) => {
      try {
        const { Store } = await import("@tauri-apps/plugin-store")
        const store = await Store.load(name)
        await store.delete(key)
        await store.save()
      } catch {
        localStorage.removeItem(`${name}:${key}`)
      }
    },
    storeClear: async (name) => {
      try {
        const { Store } = await import("@tauri-apps/plugin-store")
        const store = await Store.load(name)
        const keys = await store.keys()
        for (const k of keys) await store.delete(k)
        await store.save()
      } catch {
        const keys = Object.keys(localStorage).filter(k => k.startsWith(`${name}:`))
        for (const k of keys) localStorage.removeItem(k)
      }
    },
    storeKeys: async (name) => {
      try {
        const { Store } = await import("@tauri-apps/plugin-store")
        const store = await Store.load(name)
        return await store.keys()
      } catch {
        return Object.keys(localStorage)
          .filter(k => k.startsWith(`${name}:`))
          .map(k => k.slice(name.length + 1))
      }
    },
    storeLength: async (name) => {
      try {
        const { Store } = await import("@tauri-apps/plugin-store")
        const store = await Store.load(name)
        return (await store.keys()).length
      } catch {
        return Object.keys(localStorage).filter(k => k.startsWith(`${name}:`)).length
      }
    },

    getWindowCount: () => Promise.resolve(1),
    onSqliteMigrationProgress: () => () => {},
    onMenuCommand: (cb) => {
      const handler = (e: Event) => cb((e as CustomEvent).detail)
      window.addEventListener("menu-command", handler)
      return () => window.removeEventListener("menu-command", handler)
    },
    onDeepLink: () => () => {},
    onTrayCommand: () => () => {},

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
    runUpdater: async () => {
      // tauri-plugin-updater handles this; trigger check via plugin
      try {
        await invoke("tauri_plugin_updater_check_update", {})
      } catch {
        // no update available
      }
    },
    checkUpdate: () => checkUpdate(),
    installUpdate: async () => {
      try {
        await invoke("tauri_plugin_updater_install_update", {})
      } catch {
        // install failed
      }
    },
    setBackgroundColor: () => Promise.resolve(),
    setWindowTitle: (title) => appWindow.setTitle(title).catch(() => {}),
    setRecentProjects: () => Promise.resolve(),
    setCurrentSession: () => Promise.resolve(),

    mac: {
      capabilities: () => safeInvoke("mac_capabilities", undefined, {
        platform: "darwin",
        supports: { keychain: true, notifications: true, dockBadge: true, appleScript: true, universalClipboard: true, spotlight: true },
      }),
      credentialSet: async (name, value) => {
        try {
          await invoke("mac_keychain_set", { name, value })
        } catch {
          // Fallback: encrypted localStorage
          localStorage.setItem(`cred:${name}`, btoa(value))
        }
      },
      credentialGet: async (name) => {
        try {
          return await invoke<string | null>("mac_keychain_get", { name })
        } catch {
          const raw = localStorage.getItem(`cred:${name}`)
          if (!raw) return null
          try { return atob(raw) } catch { return raw }
        }
      },
      credentialDelete: async (name) => {
        try {
          await invoke("mac_keychain_delete", { name })
        } catch {
          localStorage.removeItem(`cred:${name}`)
        }
      },
      openInTerminal: (command, terminal) => safeInvoke("mac_open_in_terminal", { command, terminal }),
      setDockBadge: async (text) => {
        const str = text === null ? undefined : String(text)
        await safeInvoke("mac_set_dock_badge", { text: str })
      },
      showNotification: (title, body) => {
        void sendNotification({ title, body })
      },
    },
  }

  // Mount to global, compatible with packages/app
  ;(window as any).api = tauriApi
}
