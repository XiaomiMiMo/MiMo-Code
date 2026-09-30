import { dict as en } from "./cmd/tui/i18n/en"
import { dict as zh } from "./cmd/tui/i18n/zh"
import { dict as ja } from "./cmd/tui/i18n/ja"
import { dict as fr } from "./cmd/tui/i18n/fr"
import { dict as ru } from "./cmd/tui/i18n/ru"
import { detectSystemLocale } from "./cmd/tui/util/system-locale"

const dicts: Record<string, Partial<Record<string, string>>> = { en, zh, ja, fr, ru }
const dict = dicts[detectSystemLocale()] ?? en

export function t(key: string, params?: Record<string, string | number>): string {
  const raw = dict[key] ?? (en as Record<string, string>)[key] ?? key
  if (!params) return raw
  return raw.replace(/\{(\w+)\}/g, (_, k) => (k in params ? String(params[k]) : `{${k}}`))
}
