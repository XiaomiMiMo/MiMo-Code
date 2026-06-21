const BUILTIN = new Set(["init", "review", "dream", "distill", "goal", "deep-research"])

export function slashCommandDescription(
  t: (key: string) => string,
  name: string,
  fallback?: string,
) {
  if (!BUILTIN.has(name)) return fallback
  const translated = t(`tui.slash.${name}.description`)
  return translated || fallback
}
