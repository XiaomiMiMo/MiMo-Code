import path from "node:path"
import { defineConfig } from "vite"
import appPlugin from "@mimo-ai/app/vite"

export default defineConfig({
  base: "./",
  plugins: [appPlugin],
  publicDir: "../../app/public",
  root: "src",
  server: {
    fs: {
      allow: ["../.."],
    },
    watch: {
      ignored: ["!**/packages/ui/**", "!**/packages/app/**"],
    },
  },
  optimizeDeps: {
    exclude: ["@mimo-ai/ui", "@mimo-ai/app"],
  },
  define: {
    "import.meta.env.VITE_OPENCODE_CHANNEL": JSON.stringify("dev"),
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
