import * as i18n from "@solid-primitives/i18n"
import { createMemo, createResource, type ParentProps } from "solid-js"
import { I18nProvider } from "@mimo-ai/ui/context/i18n"
import { dict as tuiEn } from "../i18n/en"
import { dict as uiEn } from "@mimo-ai/ui/i18n/en"
import { LOCALES, INTL, LABEL_KEY, normalizeLocale, type Locale } from "../i18n/locales"
import { useKV } from "./kv"
import { detectSystemLocale } from "../util/system-locale"
import { createSimpleContext } from "./helper"

type Source = { dict: Record<string, string> }
const base = i18n.flatten({ ...tuiEn, ...uiEn })
type Dictionary = typeof base

const merge = async (ui: Promise<Source>, tui?: Promise<Source>) => {
  const [u, t] = await Promise.all([ui, tui])
  const tuiDict = t?.dict ?? {}
  return { ...base, ...i18n.flatten({ ...tuiDict, ...u.dict }) } as Dictionary
}

const loaders: Record<Exclude<Locale, "en">, () => Promise<Dictionary>> = {
  zh: () => merge(import("@mimo-ai/ui/i18n/zh"), import("../i18n/zh")),
  zht: () => merge(import("@mimo-ai/ui/i18n/zht"), import("../i18n/zht")),
  ko: () => merge(import("@mimo-ai/ui/i18n/ko")),
  de: () => merge(import("@mimo-ai/ui/i18n/de")),
  es: () => merge(import("@mimo-ai/ui/i18n/es"), import("../i18n/es")),
  fr: () => merge(import("@mimo-ai/ui/i18n/fr"), import("../i18n/fr")),
  da: () => merge(import("@mimo-ai/ui/i18n/da")),
  ja: () => merge(import("@mimo-ai/ui/i18n/ja"), import("../i18n/ja")),
  pl: () => merge(import("@mimo-ai/ui/i18n/pl")),
  ru: () => merge(import("@mimo-ai/ui/i18n/ru"), import("../i18n/ru")),
  ar: () => merge(import("@mimo-ai/ui/i18n/ar")),
  no: () => merge(import("@mimo-ai/ui/i18n/no")),
  br: () => merge(import("@mimo-ai/ui/i18n/br")),
  th: () => merge(import("@mimo-ai/ui/i18n/th")),
  bs: () => merge(import("@mimo-ai/ui/i18n/bs")),
  tr: () => merge(import("@mimo-ai/ui/i18n/tr")),
}

const cache = new Map<Locale, Dictionary>([["en", base]])
async function loadDict(locale: Locale): Promise<Dictionary> {
  const hit = cache.get(locale)
  if (hit) return hit
  if (locale === "en") return base
  const next = await loaders[locale]()
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

export function UiI18nBridge(props: ParentProps) {
  const lang = useLanguage()
  return <I18nProvider value={{ locale: lang.intl, t: (key: any, params: any) => lang.t(key, params) }}>{props.children}</I18nProvider>
}
