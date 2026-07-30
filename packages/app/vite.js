import { readFileSync } from "node:fs"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "url"

const theme = fileURLToPath(new URL("./public/oc-theme-preload.js", import.meta.url))

/**
 * @type {import("vite").PluginOption}
 */
export default [
  {
    name: "opencode-desktop:config",
    config() {
      return {
        css: {
          transformer: "lightningcss",
        },
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
          },
        },
        optimizeDeps: {
          exclude: ["@mimo-ai/ui", "@mimo-ai/app", "@mimo-ai/shared"],
        },
        server: {
          watch: {
            // 忽略 node_modules 防止无限 HMR 循环
            // "!**/packages/xxx/**" 在 ignored 里不是有效的排除语法
            ignored: ["**/node_modules/**"],
          },
        },
        worker: {
          format: "es",
        },
      }
    },
  },
  {
    name: "opencode-desktop:theme-preload",
    transformIndexHtml(html) {
      return html.replace(
        '<script id="oc-theme-preload-script" src="/oc-theme-preload.js"></script>',
        `<script id="oc-theme-preload-script">${readFileSync(theme, "utf8")}</script>`,
      )
    },
  },
  tailwindcss(),
  solidPlugin(),
]
