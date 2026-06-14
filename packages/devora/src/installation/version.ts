declare global {
  const DEVORA_VERSION: string
  const DEVORA_CHANNEL: string
}

export const InstallationVersion = typeof DEVORA_VERSION === "string" ? DEVORA_VERSION : "local"
export const InstallationChannel = typeof DEVORA_CHANNEL === "string" ? DEVORA_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
