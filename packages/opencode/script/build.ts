#!/usr/bin/env bun

import { $ } from "bun"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

await import("./generate.ts")

import { Script } from "@mimo-ai/script"
import pkg from "../package.json"

const BINARY_PREFIX = "mimocode"

// Load migrations from migration directories
const migrationDirs = (
  await fs.promises.readdir(path.join(dir, "migration"), {
    withFileTypes: true,
  })
)
  .filter((entry) => entry.isDirectory() && /^\d{4}\d{2}\d{2}\d{2}\d{2}\d{2}/.test(entry.name))
  .map((entry) => entry.name)
  .sort()

const migrations = await Promise.all(
  migrationDirs.map(async (name) => {
    const file = path.join(dir, "migration", name, "migration.sql")
    const sql = await Bun.file(file).text()
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name)
    const timestamp = match
      ? Date.UTC(
          Number(match[1]),
          Number(match[2]) - 1,
          Number(match[3]),
          Number(match[4]),
          Number(match[5]),
          Number(match[6]),
        )
      : 0
    return { sql, timestamp, name }
  }),
)
console.log(`Loaded ${migrations.length} migrations`)

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const skipInstall = process.argv.includes("--skip-install")
const plugin = createSolidTransformPlugin()
// const skipEmbedWebUi = process.argv.includes("--skip-embed-web-ui")
// Web UI temporarily disabled
const skipEmbedWebUi = true

const createEmbeddedWebUIBundle = async () => {
  console.log(`Building Web UI to embed in the binary`)
  const appDir = path.join(import.meta.dirname, "../../app")
  const dist = path.join(appDir, "dist")
  await $`bun run --cwd ${appDir} build`
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dist })))
    .map((file) => file.replaceAll("\\", "/"))
    .sort()
  const imports = files.map((file, i) => {
    const spec = path.relative(dir, path.join(dist, file)).replaceAll("\\", "/")
    return `import file_${i} from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)} with { type: "file" };`
  })
  const entries = files.map((file, i) => `  ${JSON.stringify(file)}: file_${i},`)
  return [
    `// Import all files as file_$i with type: "file"`,
    ...imports,
    `// Export with original mappings`,
    `export default {`,
    ...entries,
    `}`,
  ].join("\n")
}

const embeddedFileMap = skipEmbedWebUi ? null : await createEmbeddedWebUIBundle()

const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [
  {
    os: "linux",
    arch: "arm64",
  },
  {
    os: "linux",
    arch: "x64",
  },
  {
    os: "linux",
    arch: "x64",
    avx2: false,
  },
  {
    os: "linux",
    arch: "arm64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
  },
  {
    os: "linux",
    arch: "x64",
    abi: "musl",
    avx2: false,
  },
  {
    os: "darwin",
    arch: "arm64",
  },
  {
    os: "darwin",
    arch: "x64",
  },
  {
    os: "darwin",
    arch: "x64",
    avx2: false,
  },
  {
    os: "win32",
    arch: "arm64",
  },
  {
    os: "win32",
    arch: "x64",
  },
  {
    os: "win32",
    arch: "x64",
    avx2: false,
  },
]

const targets = singleFlag
  ? allTargets.filter((item) => {
      if (item.os !== process.platform || item.arch !== process.arch) {
        return false
      }

      // When building for the current platform, prefer a single native binary by default.
      // Baseline binaries require additional Bun artifacts and can be flaky to download.
      if (item.avx2 === false) {
        return baselineFlag
      }

      // also skip abi-specific builds for the same reason
      if (item.abi !== undefined) {
        return false
      }

      return true
    })
  : allTargets

await $`rm -rf dist`

const extDir = path.join(dir, "src", "ext")
let stagedExt = false
if (!fs.existsSync(extDir)) {
  const overlaySrc = path.resolve(dir, "../../mimoapi/packages/opencode/src/ext")
  if (fs.existsSync(overlaySrc)) {
    console.log(`Staging overlay entrypoints from ${overlaySrc}`)
    fs.cpSync(overlaySrc, extDir, { recursive: true })
    stagedExt = true
  }
}
// Emit a manifest with a fixed import path so runtime loaders resolve src/ext
// modules from the dependency graph rather than scanning the filesystem, which
// does not work inside Bun single-file executables. The manifest is empty when
// src/ext has no modules.
const createdExtDir = !fs.existsSync(extDir)
if (createdExtDir) fs.mkdirSync(extDir, { recursive: true })
const extFiles = fs
  .readdirSync(extDir)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && f !== "_manifest.ts")
  .sort()
const manifestImports = extFiles.map((f, i) => `import * as m${i} from "./${f.replace(/\.ts$/, "")}"`).join("\n")
const manifestEntries = extFiles.map((f, i) => `  ["${f.replace(/\.ts$/, "")}", m${i}],`).join("\n")
fs.writeFileSync(
  path.join(extDir, "_manifest.ts"),
  `// Generated by script/build.ts. Do not edit.\n${manifestImports}\nexport const modules: Record<string, Record<string, unknown>> = Object.fromEntries([\n${manifestEntries}\n])\n`,
)
if (extFiles.length) console.log(`Including overlay entrypoints: ${extFiles.map((f) => `./src/ext/${f}`).join(", ")}`)
process.on("exit", () => {
  try {
    if (stagedExt || createdExtDir) fs.rmSync(extDir, { recursive: true, force: true })
    else fs.rmSync(path.join(extDir, "_manifest.ts"), { force: true })
  } catch {}
})

const binaries: Record<string, string> = {}
if (!skipInstall) {
  await $`bun install --os="*" --cpu="*" @opentui/core@${pkg.dependencies["@opentui/core"]}`
  await $`bun install --os="*" --cpu="*" @parcel/watcher@${pkg.dependencies["@parcel/watcher"]}`
}
for (const item of targets) {
  const name = [
    BINARY_PREFIX,
    // changing to win32 flags npm for some reason
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi === undefined ? undefined : item.abi,
  ]
    .filter(Boolean)
    .join("-")
  console.log(`building ${name}`)
  await $`mkdir -p dist/${name}/bin`

  const localPath = path.resolve(dir, "node_modules/@opentui/core/parser.worker.js")
  const rootPath = path.resolve(dir, "../../node_modules/@opentui/core/parser.worker.js")
  const parserWorker = fs.realpathSync(fs.existsSync(localPath) ? localPath : rootPath)
  const workerPath = "./src/cli/cmd/tui/worker.ts"

  // Use platform-specific bunfs root path based on target OS
  const bunfsRoot = item.os === "win32" ? "B:/~BUN/root/" : "/$bunfs/root/"
  const workerRelativePath = path.relative(dir, parserWorker).replaceAll("\\", "/")

  await Bun.build({
    conditions: ["browser"],
    tsconfig: "./tsconfig.json",
    plugins: [plugin],
    external: ["node-gyp"],
    format: "esm",
    minify: true,
    splitting: true,
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: name.replace(BINARY_PREFIX, "bun") as any,
      outfile: `dist/${name}/bin/mimo`,
      execArgv: [`--user-agent=mimocode/${Script.version}`, "--use-system-ca", "--"],
      windows: {},
    },
    files: embeddedFileMap ? { "opencode-web-ui.gen.ts": embeddedFileMap } : {},
    entrypoints: ["./src/index.ts", parserWorker, workerPath, ...(embeddedFileMap ? ["opencode-web-ui.gen.ts"] : [])],
    define: {
      MIMOCODE_VERSION: `'${Script.version}'`,
      OPENCODE_MIGRATIONS: JSON.stringify(migrations),
      OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + workerRelativePath,
      OPENCODE_WORKER_PATH: workerPath,
      MIMOCODE_CHANNEL: `'${Script.channel}'`,
      OPENCODE_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "",
    },
  })

  // Smoke test: only run if binary is for current platform
  if (item.os === process.platform && item.arch === process.arch && !item.abi) {
    const binaryPath = `dist/${name}/bin/mimo`
    console.log(`Running smoke test: ${binaryPath} --version`)
    try {
      const versionOutput = await $`${binaryPath} --version`.text()
      console.log(`Smoke test passed: ${versionOutput.trim()}`)
    } catch (e) {
      console.error(`Smoke test failed for ${name}:`, e)
      process.exit(1)
    }
  }

  await $`rm -rf ./dist/${name}/bin/tui`
  await Bun.file(`dist/${name}/README.md`).write(
    `This is the ${item.os}-${item.arch} binary for [@mimo-ai/cli](https://www.npmjs.com/package/@mimo-ai/cli). Install that package directly.\n`,
  )
  await Bun.file(`dist/${name}/package.json`).write(
    JSON.stringify(
      {
        name: `@mimo-ai/${name}`,
        version: Script.version,
        description: "Platform-specific binary for @mimo-ai/cli.",
        license: "MIT",
        author: "Xiaomi MiMo Team",
        homepage: "https://mimo.xiaomi.com/coder",
        repository: {
          type: "git",
          url: "git+https://github.com/XiaomiMiMo/MiMo-Code.git",
        },
        keywords: ["ai", "coding", "agent", "cli", "mimo"],
        os: [item.os],
        cpu: [item.arch],
      },
      null,
      2,
    ),
  )
  binaries[name] = Script.version
}

if (Script.release) {
  for (const key of Object.keys(binaries)) {
    if (key.includes("linux")) {
      await $`tar -czf ../../${key}.tar.gz *`.cwd(`dist/${key}/bin`)
    } else {
      await $`zip -r ../../${key}.zip *`.cwd(`dist/${key}/bin`)
    }
  }
  await $`gh release upload v${Script.version} ./dist/*.zip ./dist/*.tar.gz --clobber --repo ${process.env.GH_REPO}`

  // Also publish to Xiaomi FDS (fast download in mainland China; the install
  // script reads from there). Skipped when credentials are absent so local
  // release builds still work.
  if (process.env.MIMO_FDS_AK && process.env.MIMO_FDS_SK) {
    const { uploadFile } = await import("./fds-upload.ts")
    const archives = fs.readdirSync("dist").filter((f) => f.endsWith(".zip") || f.endsWith(".tar.gz"))
    for (const file of archives) {
      await uploadFile(`dist/${file}`, `releases/v${Script.version}/${file}`)
      console.log(`Uploaded to FDS: releases/v${Script.version}/${file}`)
    }
    const tmpLatest = "dist/_latest.txt"
    await Bun.write(tmpLatest, Script.version)
    await uploadFile(tmpLatest, "releases/latest", "text/plain")
    console.log(`Uploaded to FDS: releases/latest -> ${Script.version}`)
  } else {
    console.log("Skipping FDS upload (MIMO_FDS_AK / MIMO_FDS_SK not set)")
  }
}

export { binaries }
