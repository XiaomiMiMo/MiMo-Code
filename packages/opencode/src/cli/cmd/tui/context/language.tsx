import * as i18n from "@solid-primitives/i18n"
import { createMemo, createResource, type ParentProps } from "solid-js"
import { dict as tuiEn } from "../i18n/en"
import { LOCALES, INTL, LABEL_KEY, normalizeLocale, type Locale } from "../i18n/locales"
import { useKV } from "./kv"
import { detectSystemLocale } from "../util/system-locale"
import { createSimpleContext } from "./helper"

type Source = { dict: Record<string, string> }
const base = i18n.flatten(tuiEn)
type Dictionary = typeof base

const merge = async (tui: Promise<Source>) => {
  const t = await tui
  return { ...base, ...i18n.flatten(t.dict) } as Dictionary
}

const loaders: Partial<Record<Exclude<Locale, "en">, () => Promise<Dictionary>>> = {
  zh: () => merge(import("../i18n/zh")),
  zht: () => merge(import("../i18n/zht")),
  es: () => merge(import("../i18n/es")),
  fr: () => merge(import("../i18n/fr")),
  ja: () => merge(import("../i18n/ja")),
  ru: () => merge(import("../i18n/ru")),
}

const cache = new Map<Locale, Dictionary>([["en", base]])
async function loadDict(locale: Locale): Promise<Dictionary> {
  const hit = cache.get(locale)
  if (hit) return hit
  if (locale === "en") return base
  const load = loaders[locale]
  const next = load ? await load() : base
  cache.set(locale, next)
  return next
}

export const { use: useLanguage, provider: LanguageProvider } = createSimpleContext({
  name: "Language",
  init: () => {
    const kv = useKV()
    const [preference, setPreference] = kv.signal<Locale | "auto">("locale", "auto")

    const effective = createMemo<Locale>(() => {
      if (!kv.ready) return "en"
      const pref = preference()
      if (pref !== "auto") return normalizeLocale(pref)
      return detectSystemLocale()
    })

    const [dict] = createResource(effective, loadDict, { initialValue: base })
    // NB: i18n.translator() returns undefined for missing keys at runtime, despite the cast to string.
    // Callers that need a fallback should use `t(key) || fallback`.
    const t = i18n.translator(() => dict() ?? base, i18n.resolveTemplate) as (
      key: string,
      params?: Record<string, string | number | boolean>,
    ) => string
    const intl = createMemo(() => INTL[effective()])
    const label = (locale: Locale) => t(LABEL_KEY[locale])

    function setLocale(next: Locale | "auto") {
      const value: Locale | "auto" = next === "auto" ? "auto" : normalizeLocale(next)
      setPreference(() => value)
    }

    return {
      preference,
      effective,
      intl,
      locales: LOCALES,
      label,
      t,
      setLocale,
    }
  },
})
