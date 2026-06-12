import { describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import path from "node:path"

const route = Bun.file(new URL("../src/routes/download/[channel]/[platform].ts", import.meta.url)).text()
const downloadPage = Bun.file(new URL("../src/routes/download/index.tsx", import.meta.url)).text()
const homePage = Bun.file(new URL("../src/routes/index.tsx", import.meta.url)).text()
const tempPage = Bun.file(new URL("../src/routes/temp.tsx", import.meta.url)).text()
const discordRoute = Bun.file(new URL("../src/routes/discord.ts", import.meta.url)).text()
const openapiRoute = Bun.file(new URL("../src/routes/openapi.json.ts", import.meta.url)).text()
const newUserSection = Bun.file(new URL("../src/routes/workspace/[id]/new-user-section.tsx", import.meta.url)).text()
const config = Bun.file(new URL("../src/config.ts", import.meta.url)).text()
const footer = Bun.file(new URL("../src/component/footer.tsx", import.meta.url)).text()
const localeLinks = Bun.file(new URL("../src/component/locale-links.tsx", import.meta.url)).text()
const notFound = Bun.file(new URL("../src/routes/[...404].tsx", import.meta.url)).text()
const en = Bun.file(new URL("../src/i18n/en.ts", import.meta.url)).text()
const i18nDir = path.resolve(import.meta.dir, "../src/i18n")

function productSurfaceCopy(source: string) {
  let active = false
  return source
    .split("\n")
    .flatMap((line) => {
      const key = line.match(/^\s+"([^"]+)":/)
      if (key) {
        active =
          /^(nav\.logoAlt|app\.meta\.|notFound\.|home\.|temp\.|workspace\.newUser\.|workspace\.keys\.)/.test(
            key[1],
          ) && !/^(temp\.zen|temp\.feature\.zen\.|home\.zenCta\.|workspace\.newUser\.title$)/.test(key[1])
      }
      const result = active ? [line] : []
      if (active && line.trim().endsWith(",")) active = false
      return result
    })
    .join("\n")
}

describe("download branding", () => {
  test("download route follows currently published MiMoCode CLI release assets", async () => {
    const source = await route

    expect(source).toContain('"darwin-arm64-zip": "mimocode-darwin-arm64.zip"')
    expect(source).toContain('"linux-x64-tar": "mimocode-linux-x64.tar.gz"')
    expect(source).toContain('"windows-x64-zip": "mimocode-windows-x64.zip"')
    expect(source).toContain("https://api.github.com/repos/${repo}/releases?per_page=20")
    expect(source).toContain("release.prerelease")
    expect(source).toContain(".flatMap((release) => (release.prerelease ? (release.assets ?? []) : []))")
    expect(source).not.toContain("mimocode-desktop")
    expect(source).not.toContain("opencode-desktop-mac-arm64.dmg")
    expect(source).not.toContain(".find((release) => release.prerelease)\n    ?.assets")
  })

  test("download page copy uses MiMoCode branding", async () => {
    const source = await en

    expect(source).toContain('"download.title": "MiMoCode | Download"')
    expect(source).toContain(
      '"download.hero.subtitle": "CLI archives and install commands for macOS, Windows, and Linux"',
    )
    expect(source).toContain('"download.section.desktop": "MiMoCode CLI Archives"')
    expect(source).toContain('"download.platform.linuxDeb": "Linux x64 (.tar.gz)"')
    expect(source).toContain('"download.platform.linuxRpm": "Linux arm64 (.tar.gz)"')
    expect(source).not.toContain("MiMoCode Desktop (Beta)")
    expect(source).not.toContain('"download.section.desktop": "OpenCode Desktop (Beta)"')
  })

  test("install commands do not point users to upstream OpenCode packages", async () => {
    const sources = [await downloadPage, await homePage, await tempPage]

    sources.forEach((source) => {
      expect(source).toContain("mimo.xiaomi.com/install")
      expect(source).toContain("@mimo-ai/cli")
      expect(source).not.toContain("opencode.ai/install")
      expect(source).not.toContain("opencode-ai")
      expect(source).not.toContain("anomalyco/tap/opencode")
      expect(source).not.toContain("brew install --cask opencode-desktop")
      expect(source).not.toContain("<strong>opencode-desktop</strong>")
      expect(source).not.toContain("opencode-bin")
      expect(source).not.toContain("paru -S opencode")
    })
  })

  test("console GitHub links point to the MiMoCode repository", async () => {
    expect(await config).toContain('repoUrl: "https://github.com/XiaomiMiMo/MiMo-Code"')
    expect(await config).toContain('compact: "4.8K"')
    expect(await config).not.toContain('repoUrl: "https://github.com/anomalyco/opencode"')
    expect(await notFound).toContain("config.github.repoUrl")
    expect(await notFound).not.toContain("https://github.com/anomalyco/opencode")
  })

  test("canonical and footer links do not advertise upstream OpenCode", async () => {
    expect(await config).toContain('baseUrl: "https://mimo.xiaomi.com/mimocode"')
    expect(await config).toContain('issues: "https://github.com/XiaomiMiMo/MiMo-Code/issues"')
    expect(await config).not.toContain("https://opencode.ai")
    expect(await config).not.toContain("https://x.com/opencode")
    expect(await config).not.toContain("https://discord.gg/opencode")
    expect(await localeLinks).toContain("`${config.baseUrl}${route(language.locale(), props.path)}`")
    expect(await footer).toContain("config.social.issues")
    expect(await footer).not.toContain("config.social.twitter")
    expect(await footer).not.toContain('key: "footer.discord"')
    expect(await footer).not.toContain('i18n.t("footer.x")')
  })

  test("temporary routes and onboarding do not send MiMoCode users to upstream OpenCode", async () => {
    const sources = [await tempPage, await discordRoute, await openapiRoute, await newUserSection]

    expect(await tempPage).toContain("https://mimo.xiaomi.com/en/mimocode")
    expect(await tempPage).toContain("https://github.com/XiaomiMiMo/MiMo-Code")
    expect(await discordRoute).toContain("https://github.com/XiaomiMiMo/MiMo-Code/issues")
    expect(await openapiRoute).toContain("../../../../sdk/openapi.json")
    expect(await newUserSection).toContain("<code>mimo auth login</code>")
    sources.forEach((source) => {
      expect(source).not.toContain("https://x.com/opencode")
      expect(source).not.toContain("https://github.com/anomalyco/opencode")
      expect(source).not.toContain("https://opencode.ai/discord")
      expect(source).not.toContain("https://discord.gg/opencode")
      expect(source).not.toContain("raw.githubusercontent.com/anomalyco/opencode")
      expect(source).not.toContain("<code>opencode auth login</code>")
    })
  })

  test("console product surfaces use MiMoCode branding in every locale", async () => {
    const files = (await readdir(i18nDir)).filter((file) => file.endsWith(".ts") && file !== "index.ts")

    await Promise.all(files.map(async (file) => {
      const source = productSurfaceCopy(await Bun.file(path.join(i18nDir, file)).text())

      expect(source).toContain("MiMoCode")
      expect(source).not.toContain("OpenCode")
      expect(source).not.toContain("opencode")
      expect(source).not.toContain("mimocode")
    }))
  })
})
