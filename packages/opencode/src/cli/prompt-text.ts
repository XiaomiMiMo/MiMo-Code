export function normalizePromptText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}
