import type { CommandOption } from "@/context/command"
import type { Locale } from "@/context/language"
import type { ColorScheme } from "@mimo-ai/ui/theme/context"

export interface BuildCommandsParams {
  language: any
  currentProject: () => any
  connectProvider: () => void
  openServer: () => void
  openSettings: () => void
  chooseProject: () => void
  cycleTheme: (step: number) => void
  availableThemeEntries: () => [string, any][]
  theme: any
  setLocale: (locale: Locale) => void
  locales: readonly Locale[]
  navigateProjectByOffset?: (offset: number) => void
  navigateSessionByOffset?: (offset: number) => void
  navigateSessionByUnseen?: (offset: number) => void
  currentSessions?: () => any[]
  archiveSession?: (session: any) => Promise<void>
  createWorkspace?: (project: any) => Promise<any>
  workspaceSetting?: () => boolean
  showToast?: (options: any) => void
  colorSchemeOrder?: readonly ColorScheme[]
  colorSchemeLabel?: (scheme: ColorScheme) => string
  cycleColorScheme?: (step: number) => void
  cycleLanguage?: (step: number) => void
  params?: any
  layout?: any
}

export function buildLayoutCommands(params: BuildCommandsParams): CommandOption[] {
  const {
    language,
    currentProject,
    connectProvider,
    openServer,
    openSettings,
    chooseProject,
    cycleTheme,
    availableThemeEntries,
    theme,
    setLocale,
    locales,
  } = params

  const commands: CommandOption[] = [
    {
      id: "provider.connect",
      title: language.t("command.provider.connect"),
      category: language.t("command.category.provider"),
      onSelect: connectProvider,
    },
    {
      id: "server.select",
      title: language.t("command.server.select"),
      category: language.t("command.category.server"),
      onSelect: openServer,
    },
    {
      id: "settings.open",
      title: language.t("command.settings.open"),
      category: language.t("command.category.settings"),
      onSelect: openSettings,
    },
    {
      id: "project.open",
      title: language.t("command.project.open"),
      category: language.t("command.category.project"),
      onSelect: chooseProject,
    },
    {
      id: "theme.cycle",
      title: language.t("command.theme.cycle"),
      category: language.t("command.category.theme"),
      keybind: "mod+shift+t",
      onSelect: () => cycleTheme(1),
    },
  ]

  const themeEntries = typeof availableThemeEntries === "function" ? availableThemeEntries() ?? [] : []
  for (const entry of themeEntries) {
    if (!entry || !entry[0]) continue
    const id = entry[0]
    commands.push({
      id: `theme.set.${id}`,
      title: language.t("command.theme.set", { theme: theme?.name?.(id) ?? id }),
      category: language.t("command.category.theme"),
      onSelect: () => theme?.commitPreview?.(),
      onHighlight: () => {
        theme?.previewTheme?.(id)
        return () => theme?.cancelPreview?.()
      },
    })
  }

  const schemes: ColorScheme[] = ["system", "dark", "light"]
  for (const scheme of schemes) {
    commands.push({
      id: `theme.scheme.${scheme}`,
      title: language.t(`command.theme.scheme.${scheme}` as Parameters<typeof language.t>[0]),
      category: language.t("command.category.theme"),
      onSelect: () => theme?.setScheme?.(scheme),
    })
  }

  for (const locale of locales ?? []) {
    commands.push({
      id: `language.set.${locale}`,
      title: language.t(`language.name.${locale}` as Parameters<typeof language.t>[0]),
      category: language.t("command.category.language"),
      onSelect: () => setLocale(locale),
    })
  }

  return commands
}
