declare global {
  const MIMOCODE_VERSION: string
  const MIMOCODE_CHANNEL: string
}

function getVersion(): string {
  if (typeof MIMOCODE_VERSION === "string" && MIMOCODE_VERSION.length > 0) {
    return MIMOCODE_VERSION
  }
  // Fallback: try to read from package.json (useful when build-time constant is missing)
  try {
    const pkg = require("../../package.json")
    return pkg.version || "local"
  } catch {
    return "local"
  }
}

export const InstallationVersion = getVersion()
export const InstallationChannel = typeof MIMOCODE_CHANNEL === "string" ? MIMOCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
