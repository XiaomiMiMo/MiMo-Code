import semver from "semver"

declare global {
  const MIMOCODE_VERSION: string
  const MIMOCODE_CHANNEL: string
}

export const InstallationVersion = typeof MIMOCODE_VERSION === "string" ? MIMOCODE_VERSION : "local"
export const InstallationChannel = typeof MIMOCODE_CHANNEL === "string" ? MIMOCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"

// InstallationVersion is an install identity (local / desktop-<hash> / release semver),
// not an npm dist-tag. @mimo-ai/plugin installs only pin when that identity is a valid
// semver string; otherwise omit the version so npm resolves latest.
export function pluginSdkNpmVersion(version: string, local: boolean): string | undefined {
  if (local) return undefined
  return semver.valid(version) ? version : undefined
}

export const PluginSdkNpmVersion = pluginSdkNpmVersion(InstallationVersion, InstallationLocal)
