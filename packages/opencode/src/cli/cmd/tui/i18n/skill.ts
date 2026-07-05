const BUILTIN = new Set([
  "docx-official",
  "xlsx-official",
  "pdf-official",
  "pptx-official",
  "mimocode",
  "self-extend",
  "frontend-design",
  "loop",
  "html-to-video-pipeline",
  "arxiv",
  "skill-creator",
  "research-paper-writing",
])

export function skillDescription(
  t: (key: string) => string,
  name: string,
  fallback?: string,
) {
  if (!BUILTIN.has(name)) return fallback
  const translated = t(`tui.skill.${name}.description`)
  return translated || fallback
}
