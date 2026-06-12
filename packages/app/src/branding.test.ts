import { describe, expect, test } from "bun:test"
import path from "node:path"
import { dict as ar } from "./i18n/ar"
import { dict as br } from "./i18n/br"
import { dict as bs } from "./i18n/bs"
import { dict as da } from "./i18n/da"
import { dict as de } from "./i18n/de"
import { dict as en } from "./i18n/en"
import { dict as es } from "./i18n/es"
import { dict as fr } from "./i18n/fr"
import { dict as ja } from "./i18n/ja"
import { dict as ko } from "./i18n/ko"
import { dict as no } from "./i18n/no"
import { dict as pl } from "./i18n/pl"
import { dict as ru } from "./i18n/ru"
import { dict as th } from "./i18n/th"
import { dict as tr } from "./i18n/tr"
import { dict as zh } from "./i18n/zh"
import { dict as zht } from "./i18n/zht"

const read = (file: string) => Bun.file(path.resolve(import.meta.dir, file)).text()
const locales = { ar, br, bs, da, de, en, es, fr, ja, ko, no, pl, ru, th, tr, zh, zht }
const productKeys = [
  "dialog.server.description",
  "toast.update.description",
  "error.page.report.prefix",
  "error.chain.mcpFailed",
  "sidebar.gettingStarted.line1",
  "app.name.desktop",
  "settings.desktop.wsl.description",
  "settings.general.row.language.description",
  "settings.general.row.appearance.description",
  "settings.general.row.colorScheme.description",
  "settings.general.row.theme.description",
  "settings.updates.row.startup.description",
  "settings.updates.toast.latest.description",
] as const

describe("app branding assets", () => {
  test("notifications and built-in project avatar use bundled favicon assets", async () => {
    const entry = await read("entry.tsx")
    const sidebar = await read("pages/layout/sidebar-items.tsx")
    const errorPage = await read("pages/error.tsx")
    const layout = await read("pages/layout.tsx")
    const statusPopover = await read("components/status-popover-body.tsx")
    const serverErrors = await read("utils/server-errors.ts")

    expect(entry).toContain('icon: "/favicon-96x96-v3.png"')
    expect(sidebar).toContain('"/favicon.svg"')
    expect(errorPage).toContain("https://github.com/XiaomiMiMo/MiMo-Code/issues/new?template=bug-report.yml")
    expect(errorPage).toContain('Icon name="github"')
    expect(layout).toContain("https://github.com/XiaomiMiMo/MiMo-Code")
    expect(statusPopover).toContain('"mimocode.json"')
    expect(serverErrors).toContain("Check your config (mimocode.json) provider/model names")
    expect(entry).not.toContain("opencode.ai/favicon")
    expect(sidebar).not.toContain("opencode.ai/favicon")
    expect(errorPage).not.toContain("opencode.ai/desktop-feedback")
    expect(layout).not.toContain("opencode.ai/desktop-feedback")
    expect(statusPopover).not.toContain('"opencode.json"')
    expect(serverErrors).not.toContain("Check your config (opencode.json) provider/model names")
  })

  test("localized app product copy uses MiMoCode branding", () => {
    for (const dict of Object.values(locales)) {
      const text = productKeys.map((key) => dict[key]).join("\n")

      expect(text).toContain("MiMoCode")
      expect(text).not.toContain("OpenCode")
    }
  })

  test("OpenCode Zen and Go service names stay intact", () => {
    expect(en["provider.connect.opencodeZen.line1"]).toContain("OpenCode Zen")
    expect(en["dialog.provider.opencodeGo.tagline"]).toBe("Low cost subscription for everyone")
  })
})
