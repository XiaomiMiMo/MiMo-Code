import path from "node:path"
import { defineConfig, searchForWorkspaceRoot } from "vite"
import appPlugin from "@mimo-ai/app/vite"

export default defineConfig({
  base: "./",
  plugins: [appPlugin],
  publicDir: "../../app/public",
  root: "src",
  server: {
    fs: {
      allow: [
        searchForWorkspaceRoot(process.cwd()),
        path.resolve(__dirname, "../.."),
      ],
    },
    watch: {
      // 忽略 out/ 输出目录（防止写入触发 HMR 循环）和所有 node_modules
      // 不要使用 "!**/packages/xxx/**" —— ignored 数组里 ! 不是排除符，会导致全量监视
      ignored: [
        "**/node_modules/**",
        path.resolve(__dirname, "../out/**"),
        path.resolve(__dirname, "out/**"),
      ],
    },
  },
  optimizeDeps: {
    exclude: ["@mimo-ai/ui", "@mimo-ai/app"],
  },
  define: {
    "import.meta.env.VITE_OPENCODE_CHANNEL": JSON.stringify(process.env.OPENCODE_CHANNEL || "prod"),
  },
  build: {
    outDir: "../out",
    emptyOutDir: true,
    cssMinify: "lightningcss",
  },
  css: {
    transformer: "lightningcss",
  },
})
