declare global {
  const MIMOCODE_VERSION: string
  const MIMOCODE_CHANNEL: string
}

export const InstallationVersion = typeof MIMOCODE_VERSION === "string" ? MIMOCODE_VERSION : "local"
export const InstallationChannel = typeof MIMOCODE_CHANNEL === "string" ? MIMOCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
