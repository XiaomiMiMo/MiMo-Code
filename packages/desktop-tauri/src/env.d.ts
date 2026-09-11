import type { ElectronAPI } from "./bridge"

declare global {
  interface Window {
    api: ElectronAPI
    __OPENCODE__?: {
      deepLinks?: string[]
      recentProjects?: string[]
    }
  }
}

declare module "@tauri-apps/api/core" {
  export function invoke<T = any>(cmd: string, args?: Record<string, unknown>): Promise<T>
}

declare module "@tauri-apps/api/window" {
  export function getCurrentWindow(): {
    isFocused(): Promise<boolean>
    setFocus(): Promise<void>
    show(): Promise<void>
    setTitle(title: string): Promise<void>
    startDragging(): Promise<void>
    toggleMaximize(): Promise<void>
  }
}

declare module "@tauri-apps/plugin-dialog" {
  export function open(opts?: any): Promise<string | string[] | null>
  export function save(opts?: any): Promise<string | null>
}

declare module "@tauri-apps/plugin-clipboard-manager" {
  export function readText(): Promise<string>
  export function writeText(text: string): Promise<void>
  export function readImage(): Promise<{ rgba(): Promise<Uint8Array> } | null>
}

declare module "@tauri-apps/plugin-notification" {
  export function sendNotification(options: { title: string; body?: string }): void
}

declare module "@tauri-apps/plugin-process" {
  export function relaunch(): Promise<void>
}

declare module "@tauri-apps/plugin-opener" {
  export function openUrl(url: string): Promise<void>
}
