import { describe, expect, test } from "bun:test"
import { dict as ar } from "./ar"
import { dict as br } from "./br"
import { dict as bs } from "./bs"
import { dict as da } from "./da"
import { dict as de } from "./de"
import { dict as en } from "./en"
import { dict as es } from "./es"
import { dict as fr } from "./fr"
import { dict as ja } from "./ja"
import { dict as ko } from "./ko"
import { dict as no } from "./no"
import { dict as pl } from "./pl"
import { dict as ru } from "./ru"
import { dict as zh } from "./zh"
import { dict as zht } from "./zht"

const locales = { ar, br, bs, da, de, en, es, fr, ja, ko, no, pl, ru, zh, zht }

describe("desktop localized branding copy", () => {
  for (const locale of Object.keys(locales) as Array<keyof typeof locales>) {
    test(`${locale} update and CLI install copy uses MiMoCode`, () => {
      const text = [
        locales[locale]["desktop.updater.none.message"],
        locales[locale]["desktop.updater.downloaded.prompt"],
        locales[locale]["desktop.cli.installed.message"],
      ].join("\n")

      expect(text).toContain("MiMoCode")
      expect(text).toContain("'mimo'")
      expect(text).not.toContain("OpenCode")
      expect(text).not.toContain("'opencode'")
    })
  }
})
