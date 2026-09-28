import { defineConfig } from "drizzle-kit"
import path from "path"
import os from "os"

// Mirror packages/opencode/src/storage/db.ts `Path` so kit and the runtime
// open the same SQLite file.
const APP = "mimocode"
const data =
  process.env.MIMOCODE_HOME && path.isAbsolute(process.env.MIMOCODE_HOME)
    ? path.join(process.env.MIMOCODE_HOME, "data")
    : path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), APP)

function resolveDbPath() {
  const raw = process.env.MIMOCODE_DB
  if (raw === ":memory:" || (raw && path.isAbsolute(raw))) return raw
  if (raw) return path.join(data, raw)
  return path.join(data, "mimocode.db")
}

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/**/*.sql.ts",
  out: "./migration",
  dbCredentials: {
    url: resolveDbPath(),
  },
})
