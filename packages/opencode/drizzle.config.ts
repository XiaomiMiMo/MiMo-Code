import { defineConfig } from "drizzle-kit"
import path from "path"
import os from "os"

// Same layout as Global.Path.data / storage Path (`mimocode.db`).
// Override with MIMOCODE_DB when pointing kit at a different file.
const data =
  process.env.MIMOCODE_HOME && path.isAbsolute(process.env.MIMOCODE_HOME)
    ? path.join(process.env.MIMOCODE_HOME, "data")
    : path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "mimocode")

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/**/*.sql.ts",
  out: "./migration",
  dbCredentials: {
    url: process.env.MIMOCODE_DB ?? path.join(data, "mimocode.db"),
  },
})
