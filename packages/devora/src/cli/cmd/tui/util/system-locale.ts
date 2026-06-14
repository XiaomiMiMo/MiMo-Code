import type { Locale } from "../i18n/locales"

const matchers: Array<{ test: (s: string) => boolean; locale: Locale }> = [
  { test: (s) => s.startsWith("en"), locale: "en" },
  { test: (s) => s.startsWith("zh") && /(hant|tw|hk|mo)/.test(s), locale: "zht" },
  { test: (s) => s.startsWith("zh"), locale: "zh" },
  { test: (s) => s.startsWith("ko"), locale: "ko" },
  { test: (s) => s.startsWith("de"), locale: "de" },
  { test: (s) => s.startsWith("es"), locale: "es" },
  { test: (s) => s.startsWith("fr"), locale: "fr" },
  { test: (s) => s.startsWith("da"), locale: "da" },
  { test: (s) => s.startsWith("ja"), locale: "ja" },
  { test: (s) => s.startsWith("pl"), locale: "pl" },
  { test: (s) => s.startsWith("ru"), locale: "ru" },
  { test: (s) => s.startsWith("ar"), locale: "ar" },
  { test: (s) => /^(no|nb|nn)/.test(s), locale: "no" },
  { test: (s) => s.startsWith("pt"), locale: "br" },
  { test: (s) => s.startsWith("th"), locale: "th" },
  { test: (s) => s.startsWith("bs"), locale: "bs" },
  { test: (s) => s.startsWith("tr"), locale: "tr" },
]

const CN_TIMEZONES = new Set(["Asia/Shanghai", "Asia/Chongqing", "Asia/Harbin", "Asia/Urumqi", "Asia/Kashgar"])

const ZHT_TIMEZONES = new Set(["Asia/Hong_Kong", "Asia/Macau", "Asia/Macao", "Asia/Taipei"])

const JA_TIMEZONES = new Set(["Asia/Tokyo"])

const FR_TIMEZONES = new Set([
  "Europe/Paris",
  "Europe/Monaco",
  "Indian/Reunion",
  "Indian/Mayotte",
  "Pacific/Noumea",
  "Pacific/Tahiti",
  "Pacific/Marquesas",
  "Pacific/Gambier",
  "America/Martinique",
  "America/Guadeloupe",
  "America/St_Barthelemy",
  "America/Cayenne",
  "America/Miquelon",
])

const RU_TIMEZONES = new Set([
  "Europe/Moscow",
  "Europe/Kaliningrad",
  "Europe/Samara",
  "Europe/Volgograd",
  "Europe/Saratov",
  "Europe/Astrakhan",
  "Europe/Kirov",
  "Europe/Ulyanovsk",
  "Europe/Simferopol",
  "Europe/Minsk",
  "Asia/Yekaterinburg",
  "Asia/Omsk",
  "Asia/Novosibirsk",
  "Asia/Novokuznetsk",
  "Asia/Krasnoyarsk",
  "Asia/Irkutsk",
  "Asia/Chita",
  "Asia/Yakutsk",
  "Asia/Khandyga",
  "Asia/Vladivostok",
  "Asia/Ust-Nera",
  "Asia/Magadan",
  "Asia/Sakhalin",
  "Asia/Srednekolymsk",
  "Asia/Kamchatka",
  "Asia/Anadyr",
  "Asia/Barnaul",
  "Asia/Tomsk",
])

const ES_TIMEZONES = new Set([
  "Europe/Madrid",
  "Atlantic/Canary",
  "Africa/Ceuta",
  "America/Mexico_City",
  "America/Tijuana",
  "America/Hermosillo",
  "America/Mazatlan",
  "America/Chihuahua",
  "America/Monterrey",
  "America/Cancun",
  "America/Merida",
  "America/Matamoros",
  "America/Bahia_Banderas",
  "America/Ojinaga",
  "America/Havana",
  "America/Santo_Domingo",
  "America/Puerto_Rico",
  "America/Panama",
  "America/Guatemala",
  "America/Tegucigalpa",
  "America/Managua",
  "America/Costa_Rica",
  "America/El_Salvador",
  "America/Bogota",
  "America/Caracas",
  "America/Guayaquil",
  "America/Lima",
  "America/La_Paz",
  "America/Asuncion",
  "America/Montevideo",
  "America/Santiago",
  "America/Punta_Arenas",
  "Pacific/Easter",
  "America/Argentina/Buenos_Aires",
  "America/Argentina/Cordoba",
  "America/Argentina/Salta",
  "America/Argentina/Jujuy",
  "America/Argentina/Tucuman",
  "America/Argentina/Catamarca",
  "America/Argentina/La_Rioja",
  "America/Argentina/San_Juan",
  "America/Argentina/Mendoza",
  "America/Argentina/San_Luis",
  "America/Argentina/Rio_Gallegos",
  "America/Argentina/Ushuaia",
])

const EN_TIMEZONES = new Set([
  "America/New_York",
  "America/Detroit",
  "America/Kentucky/Louisville",
  "America/Kentucky/Monticello",
  "America/Indiana/Indianapolis",
  "America/Indiana/Vincennes",
  "America/Indiana/Winamac",
  "America/Indiana/Marengo",
  "America/Indiana/Petersburg",
  "America/Indiana/Vevay",
  "America/Indiana/Tell_City",
  "America/Indiana/Knox",
  "America/Chicago",
  "America/Menominee",
  "America/North_Dakota/Center",
  "America/North_Dakota/New_Salem",
  "America/North_Dakota/Beulah",
  "America/Denver",
  "America/Boise",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "America/Juneau",
  "America/Sitka",
  "America/Metlakatla",
  "America/Yakutat",
  "America/Nome",
  "America/Adak",
  "Pacific/Honolulu",
  "America/Toronto",
  "America/Vancouver",
  "America/Edmonton",
  "America/Winnipeg",
  "America/Halifax",
  "America/St_Johns",
  "America/Regina",
  "America/Whitehorse",
  "Europe/London",
  "Europe/Belfast",
  "Europe/Dublin",
  "Australia/Sydney",
  "Australia/Melbourne",
  "Australia/Brisbane",
  "Australia/Perth",
  "Australia/Adelaide",
  "Australia/Hobart",
  "Australia/Darwin",
  "Pacific/Auckland",
])

function detectTimezoneLocale(): Locale | undefined {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (!tz) return undefined
    if (ZHT_TIMEZONES.has(tz)) return "zht"
    if (CN_TIMEZONES.has(tz)) return "zh"
    if (JA_TIMEZONES.has(tz)) return "ja"
    if (RU_TIMEZONES.has(tz)) return "ru"
    if (FR_TIMEZONES.has(tz)) return "fr"
    if (ES_TIMEZONES.has(tz)) return "es"
    if (EN_TIMEZONES.has(tz)) return "en"
  } catch {}
  return undefined
}

export function detectSystemLocale(): Locale {
  const tz = detectTimezoneLocale()
  if (tz) return tz
  for (const env of ["LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"] as const) {
    const value = process.env[env]
    if (!value) continue
    for (const raw of value.split(":")) {
      const cleaned = raw.replace(/[.@].*$/, "").replace(/_/g, "-").toLowerCase()
      if (!cleaned || cleaned === "c" || cleaned === "posix") continue
      const match = matchers.find((m) => m.test(cleaned))
      if (match) return match.locale
    }
  }
  try {
    const intl = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase()
    const match = matchers.find((m) => m.test(intl))
    if (match) return match.locale
  } catch {}
  return "en"
}
