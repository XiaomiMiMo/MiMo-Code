import { describe, expect, test } from "bun:test"
import { dict as en } from "../../../../src/cli/cmd/tui/i18n/en"
import { dict as es } from "../../../../src/cli/cmd/tui/i18n/es"
import { dict as fr } from "../../../../src/cli/cmd/tui/i18n/fr"
import { dict as ja } from "../../../../src/cli/cmd/tui/i18n/ja"
import { dict as ru } from "../../../../src/cli/cmd/tui/i18n/ru"
import { dict as zh } from "../../../../src/cli/cmd/tui/i18n/zh"
import { dict as zht } from "../../../../src/cli/cmd/tui/i18n/zht"

const badgeKey = "tui.command.never_ask.badge"

describe("never-ask badge localization", () => {
  test("uses localized badge labels instead of the English command slug", () => {
    expect(en[badgeKey]).toBe("never-ask")
    expect(es[badgeKey]).toBe("Sin preguntas")
    expect(fr[badgeKey]).toBe("Sans questions")
    expect(ja[badgeKey]).toBe("質問しない")
    expect(ru[badgeKey]).toBe("Без вопросов")
    expect(zh[badgeKey]).toBe("跳过提问")
    expect(zht[badgeKey]).toBe("跳過提問")
  })
})
