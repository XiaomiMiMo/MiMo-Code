import path from "node:path"
import { defineConfig } from "electron-vite"
import appPlugin from "@mimo-ai/app/vite"
import * as fs from "node:fs/promises"
import { fileURLToPath } from "node:url"

import * as fsSync from "node:fs"

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OPENCODE_SERVER_DIST = "../opencode/dist/node"
const OPENCODE_SERVER_ABS = path.resolve(__dirname, OPENCODE_SERVER_DIST)

const nodePtyPkg = `@lydell/node-pty-${process.platform}-${process.arch}`

export default defineConfig({
  main: {
    define: {
      "import.meta.env.OPENCODE_CHANNEL": JSON.stringify(channel),
    },
    build: {
      rollupOptions: {
        input: { index: "src/main/index.ts" },
        external: ["electron", /^node:/, nodePtyPkg],
      },
      externalizeDeps: false,
    },
    plugins: [
      {
        name: "opencode:node-pty-narrower",
        enforce: "pre",
        resolveId(s) {
          if (s === "@lydell/node-pty") return nodePtyPkg
        },
      },
      {
        name: "opencode:virtual-server-module",
        enforce: "pre",
        resolveId(id) {
          if (id === "virtual:opencode-server") {
            const nodeDist = path.join(OPENCODE_SERVER_ABS, "node.js")
            if (fsSync.existsSync(nodeDist)) {
              return { id: "./node.js", external: true }
            }
            return path.resolve(__dirname, "../opencode/src/index.ts")
          }
        },
      },
      {
        name: "opencode:copy-server-assets",
        async writeBundle() {
          const ws = path.resolve("out/main")
          await fs.mkdir(ws, { recursive: true }).catch(() => undefined)
          if (fsSync.existsSync(OPENCODE_SERVER_ABS)) {
            for (const l of await fs.readdir(OPENCODE_SERVER_ABS)) {
              await fs.writeFile(`${ws}/${l}`, await fs.readFile(`${OPENCODE_SERVER_ABS}/${l}`))
            }
          }
        },
      },
    ],
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    plugins: [appPlugin],
    publicDir: "../../../app/public",
    root: "src/renderer",
    server: {
      watch: {
        ignored: ["!**/packages/ui/**", "!**/packages/app/**"],
      },
    },
    optimizeDeps: {
      exclude: ["@mimo-ai/ui", "@mimo-ai/app"],
    },
    define: {
      "import.meta.env.VITE_OPENCODE_CHANNEL": JSON.stringify(channel),
    },
    css: {
      transformer: "lightningcss",
    },
    build: {
      cssMinify: "lightningcss",
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
          loading: "src/renderer/loading.html",
        },
      },
    },
  },
})
