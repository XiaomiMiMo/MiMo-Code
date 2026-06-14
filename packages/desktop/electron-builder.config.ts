import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"

const execFileAsync = promisify(execFile)
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

const channel = (() => {
  const raw = process.env.DEVORA_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const updateRepository = (() => {
  const fallback = process.env.GITHUB_REPOSITORY?.split("/")
  return {
    owner: process.env.DEVORA_UPDATE_OWNER || fallback?.[0] || "SheriAkhtamov",
    repo: process.env.DEVORA_UPDATE_REPO || fallback?.[1] || "Devora",
  }
})()

const macSigningEnabled = process.env.DEVORA_SIGN_MAC === "true"
const macNotarizeEnabled =
  macSigningEnabled &&
  !!process.env.APPLE_ID &&
  !!process.env.APPLE_APP_SPECIFIC_PASSWORD &&
  !!process.env.APPLE_TEAM_ID

const githubPublish = {
  provider: "github" as const,
  owner: updateRepository.owner,
  repo: updateRepository.repo,
  channel: "latest",
  releaseType: "release",
}

const getBase = (): Configuration => ({
  artifactName: "devora-desktop-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: ["out/**/*", "resources/**/*"],
  extraResources: [
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    identity: macSigningEnabled ? undefined : null,
    hardenedRuntime: macSigningEnabled,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: macNotarizeEnabled,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: macSigningEnabled,
  },
  protocols: {
    name: "Devora",
    schemes: ["devora"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
    },
    target: ["nsis"],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const base = getBase()

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId: "io.github.sheriakhtamov.devora.dev",
        productName: "Devora Dev",
        rpm: { packageName: "devora-dev" },
      }
    }
    case "beta": {
      return {
        ...base,
        appId: "io.github.sheriakhtamov.devora.beta",
        productName: "Devora Beta",
        protocols: { name: "Devora Beta", schemes: ["devora"] },
        publish: githubPublish,
        rpm: { packageName: "devora-beta" },
      }
    }
    case "prod": {
      return {
        ...base,
        appId: "io.github.sheriakhtamov.devora",
        productName: "Devora",
        protocols: { name: "Devora", schemes: ["devora"] },
        publish: githubPublish,
        rpm: { packageName: "devora" },
      }
    }
  }
}

export default getConfig()
