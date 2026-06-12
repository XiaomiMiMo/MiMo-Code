import { describe, expect, test } from "bun:test"
import path from "node:path"

const read = (file: string) => Bun.file(path.resolve(import.meta.dir, "../src", file)).text()
const readPackage = (file: string) => Bun.file(path.resolve(import.meta.dir, "..", file)).text()
const readRoot = (file: string) => Bun.file(path.resolve(import.meta.dir, "../../..", file)).text()

describe("user-visible branding copy", () => {
  test("OAuth browser pages use MiMoCode branding", async () => {
    const mcpCallback = await read("mcp/oauth-callback.ts")
    const mcpProvider = await read("mcp/oauth-provider.ts")
    const codexPlugin = await read("plugin/codex.ts")

    expect(mcpCallback).toContain("MiMoCode - Authorization Successful")
    expect(mcpCallback).toContain("return to MiMoCode")
    expect(mcpCallback).not.toContain("return to OpenCode")
    expect(mcpProvider).toContain('client_name: "MiMoCode"')
    expect(mcpProvider).toContain('client_uri: "https://mimo.xiaomi.com/en/mimocode"')
    expect(mcpProvider).not.toContain('client_uri: "https://opencode.ai"')
    expect(codexPlugin).toContain("MiMoCode - Codex Authorization Successful")
    expect(codexPlugin).toContain("return to MiMoCode")
    expect(codexPlugin).not.toContain("OpenCode - Codex Authorization")
  })

  test("ACP auth metadata advertises the mimo CLI", async () => {
    const source = await read("acp/agent.ts")
    const readme = await read("acp/README.md")

    expect(source).toContain("Run `mimo auth login` in the terminal")
    expect(source).toContain('command: "mimo"')
    expect(source).toContain('label: "MiMoCode Login"')
    expect(source).toContain('name: "MiMoCode"')
    expect(source).not.toContain("Run `opencode auth login`")
    expect(readme).toContain('"MiMoCode"')
    expect(readme).toContain('"command": "mimo"')
    expect(readme).toContain("mimo acp")
    expect(readme).toContain("MIMOCODE_ENABLE_QUESTION_TOOL=1 mimo acp")
    expect(readme).not.toContain('"command": "opencode"')
    expect(readme).not.toContain("opencode acp")
    expect(readme).not.toContain("OPENCODE_ENABLE_QUESTION_TOOL")
  })

  test("provider gateway guidance suggests mimo auth login", async () => {
    const source = await read("provider/error.ts")
    const mcp = await read("mcp/index.ts")
    const status = await read("cli/cmd/tui/component/dialog-status.tsx")

    expect(source).toContain("`mimo auth login <your provider URL>`")
    expect(source).not.toContain("`opencode auth login <your provider URL>`")
    expect(mcp).toContain("Run: mimo mcp auth")
    expect(status).toContain("run: mimo mcp auth")
    expect(mcp).not.toContain("Run: opencode mcp auth")
    expect(status).not.toContain("run: opencode mcp auth")
  })

  test("init template writes MiMoCode-oriented AGENTS guidance", async () => {
    const source = await read("command/template/initialize.txt")

    expect(source).toContain("future MiMoCode sessions")
    expect(source).toContain("repo-local MiMoCode config such as `mimocode.json`")
    expect(source).not.toContain("future OpenCode sessions")
    expect(source).not.toContain("repo-local OpenCode config")
  })

  test("server route docs use MiMoCode branding", async () => {
    const source = await read("server/routes/global.ts")
    const control = await read("server/routes/control/index.ts")
    const httpapiConfig = await read("server/routes/instance/httpapi/config.ts")
    const httpapiPermission = await read("server/routes/instance/httpapi/permission.ts")
    const httpapiProvider = await read("server/routes/instance/httpapi/provider.ts")
    const httpapiProject = await read("server/routes/instance/httpapi/project.ts")
    const httpapiQuestion = await read("server/routes/instance/httpapi/question.ts")
    const experimentalHttpApiDocs = [httpapiConfig, httpapiPermission, httpapiProvider, httpapiProject]

    expect(source).toContain('summary: "Upgrade mimocode"')
    expect(source).toContain("Upgrade mimocode to the specified version")
    expect(source).not.toContain("Upgrade opencode")
    expect(source).not.toContain("OpenCode server")
    expect(control).toContain('title: "mimocode"')
    expect(control).toContain('description: "mimocode api"')
    expect(control).not.toContain('title: "opencode"')
    expect(control).not.toContain('description: "opencode api"')
    experimentalHttpApiDocs.forEach((httpapi) => {
      expect(httpapi).toContain('title: "MiMoCode experimental HttpApi"')
      expect(httpapi).not.toContain('title: "opencode experimental HttpApi"')
    })
    expect(httpapiQuestion).toContain('title: "MiMoCode HttpApi"')
    expect(httpapiQuestion).not.toContain('title: "opencode HttpApi"')
  })

  test("published npm wrapper resolves MiMoCode platform binaries", async () => {
    const wrapper = await readPackage("bin/mimo")
    const postinstall = await readPackage("script/postinstall.mjs")

    expect(wrapper).toContain('"mimocode-" + platform + "-" + arch')
    expect(wrapper).toContain('platform === "windows" ? "mimo.exe" : "mimo"')
    expect(wrapper).not.toContain('"opencode-" + platform + "-" + arch')
    expect(wrapper).not.toContain('platform === "windows" ? "opencode.exe" : "opencode"')
    expect(postinstall).toContain("`mimocode-${platform}-${arch}`")
    expect(postinstall).toContain('platform === "windows" ? "mimo.exe" : "mimo"')
    expect(postinstall).toContain('path.join(__dirname, "bin", ".mimocode")')
    expect(postinstall).not.toContain("`opencode-${platform}-${arch}`")
    expect(postinstall).not.toContain('path.join(__dirname, "bin", ".opencode")')
  })

  test("repo-facing docs and editor extensions point to MiMoCode", async () => {
    const security = await readRoot("SECURITY.md")
    const contributing = await readRoot("CONTRIBUTING.md")
    const enterpriseShare = await readRoot("packages/enterprise/src/routes/share/[shareID].tsx")
    const zed = await readRoot("packages/extensions/zed/extension.toml")
    const vscodeReadme = await readRoot("sdks/vscode/README.md")
    const vscodePackage = await readRoot("sdks/vscode/package.json")
    const vscodeExtension = await readRoot("sdks/vscode/src/extension.ts")
    const vscodePublish = await readRoot("sdks/vscode/script/publish")
    const sources = [security, contributing, enterpriseShare, zed, vscodeReadme, vscodePackage, vscodeExtension, vscodePublish]

    expect(security).toContain("github.com/XiaomiMiMo/MiMo-Code/security/advisories/new")
    expect(contributing).toContain("github.com/XiaomiMiMo/MiMo-Code/issues")
    expect(contributing).toContain("./packages/opencode/dist/mimocode-<platform>/bin/mimo")
    expect(enterpriseShare).toContain("<Title>{info().title} | MiMoCode</Title>")
    expect(enterpriseShare).toContain('href="https://github.com/XiaomiMiMo/MiMo-Code"')
    expect(enterpriseShare).toContain('href="https://github.com/XiaomiMiMo/MiMo-Code/issues"')
    expect(zed).toContain('id = "mimocode"')
    expect(zed).toContain('repository = "https://github.com/XiaomiMiMo/MiMo-Code"')
    expect(zed).toContain('version = "0.1.0"')
    expect(zed).toContain("releases/download/v0.1.0/mimocode-darwin-arm64.zip")
    expect(zed).toContain('cmd = "./mimo"')
    expect(vscodeReadme).toContain("MiMoCode VS Code Extension")
    expect(vscodePackage).toContain('"name": "mimocode"')
    expect(vscodePackage).toContain('"command": "mimocode.openTerminal"')
    expect(vscodeExtension).toContain("terminal.sendText(`mimo --port ${port}`)")
    expect(vscodePublish).toContain("dist/mimocode.vsix")
    sources.forEach((source) => {
      expect(source).not.toContain("github.com/anomalyco/opencode")
      expect(source).not.toContain("https://opencode.ai/discord")
      expect(source).not.toContain("https://discord.gg/opencode")
      expect(source).not.toContain("dist/opencode.vsix")
      expect(source).not.toContain("terminal.sendText(`opencode --port ${port}`)")
    })
    expect(zed).not.toContain("opencode-darwin-arm64.zip")
    expect(zed).not.toContain("v1.14.19")
    expect(zed).not.toContain('cmd = "./opencode"')
  })
})
