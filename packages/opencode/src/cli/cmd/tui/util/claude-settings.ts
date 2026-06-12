export const CLAUDE_SETTINGS_FILES = ["settings.json", "settings.local.json", "settings_local.json"]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function claudeSettingsEnvSources(settings: unknown) {
  if (!isRecord(settings)) return []
  return [settings, ...(isRecord(settings.env) ? [settings.env] : [])]
}

export function resolveClaudeEnvValue(
  envs: ReadonlyArray<Record<string, unknown>>,
  name: string,
  fallback: Record<string, string | undefined> = process.env,
) {
  for (let i = envs.length - 1; i >= 0; i--) {
    const value = envs[i][name]
    if (typeof value === "string" && value) return value
  }
  const value = fallback[name]
  return value || undefined
}

export function resolveClaudeApiKey(resolve: (name: string) => string | undefined) {
  return resolve("ANTHROPIC_API_KEY") ?? resolve("ANTHROPIC_AUTH_TOKEN")
}
