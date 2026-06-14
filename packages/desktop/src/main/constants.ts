import { app } from "electron"

type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.DEVORA_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"
const macUpdaterSupported = process.platform !== "darwin" || import.meta.env.DEVORA_SIGN_MAC === "true"

export const SETTINGS_STORE = "devora.settings"
export const DEFAULT_SERVER_URL_KEY = "defaultServerUrl"
export const WSL_ENABLED_KEY = "wslEnabled"
export const UPDATER_ENABLED = app.isPackaged && CHANNEL !== "dev" && macUpdaterSupported
