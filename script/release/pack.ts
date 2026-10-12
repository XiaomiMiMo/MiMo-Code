import { cp, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { root, run } from "./context"
import { platforms } from "./manifest"

export function transformExports(exports: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(exports).map(([key, value]) => {
      if (typeof value === "string") {
        const file = value.replace("./src/", "./dist/").replace(/\.ts$/, "")
        return [key, { types: file + ".d.ts", import: file + ".js" }]
      }
      if (value && typeof value === "object" && !Array.isArray(value))
        return [key, transformExports(value as Record<string, unknown>)]
      return [key, value]
    }),
  )
}

async function checkExports(value: unknown, cwd: string): Promise<void> {
  if (typeof value === "string") {
    if (!value.startsWith("./dist/") || !(await Bun.file(path.join(cwd, value)).exists())) {
      throw new Error(`Missing compiled export: ${value}`)
    }
    return
  }
  if (value && typeof value === "object") await Promise.all(Object.values(value).map((item) => checkExports(item, cwd)))
}

async function pack(cwd: string, output: string, name: string, version: string) {
  const file = `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`
  await run([process.execPath, "pm", "pack", "--ignore-scripts", "--filename", path.join(output, file)], cwd)
  const packed = JSON.parse(await run(["tar", "-xOf", path.join(output, file), "package/package.json"]))
  if (packed.name !== name || packed.version !== version) throw new Error(`Invalid tarball metadata: ${file}`)
  return { file, name }
}

export async function packLibrary(name: "sdk" | "plugin", output: string) {
  const cwd = path.join(root, "packages", name)
  const pkg = await Bun.file(path.join(cwd, "package.json")).json()
  const catalog = (await Bun.file(path.join(root, "package.json")).json()).workspaces.catalog as Record<string, string>
  await rm(path.join(cwd, "dist"), { recursive: true, force: true })
  // Compile committed SDK sources. The SDK build script performs code generation
  // and must never be invoked by a release.
  await run(
    [
      process.execPath,
      path.join(root, "node_modules/typescript/bin/tsc"),
      "--incremental",
      "false",
      "--composite",
      "false",
    ],
    cwd,
  )
  const stage = path.join(output, ".pack", name)
  await mkdir(stage, { recursive: true })
  await cp(path.join(cwd, "dist"), path.join(stage, "dist"), { recursive: true })
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"] as const) {
    if (!pkg[field]) continue
    pkg[field] = Object.fromEntries(
      Object.entries(pkg[field] as Record<string, string>).map(([key, value]) => {
        if (value === "catalog:") {
          if (!catalog[key]) throw new Error(`Unknown catalog dependency: ${key}`)
          return [key, catalog[key]]
        }
        if (value === "workspace:*" && key === "@mimo-ai/sdk") return [key, pkg.version]
        if (value.startsWith("workspace:") || value.startsWith("catalog:"))
          throw new Error(`Unresolved dependency: ${key}`)
        return [key, value]
      }),
    )
  }
  pkg.exports = transformExports(pkg.exports)
  await checkExports(pkg.exports, stage)
  await Bun.write(path.join(stage, "package.json"), JSON.stringify(pkg, null, 2) + "\n")
  await cp(path.join(root, "README_npm.md"), path.join(stage, "README.md"))
  await cp(path.join(root, "LICENSE"), path.join(stage, "LICENSE"))
  return pack(stage, output, pkg.name, pkg.version)
}

export async function packCLI(output: string, version: string) {
  const binaries = await Promise.all(
    platforms.map(async (name) => {
      const cwd = path.join(root, "packages/cli/dist", name)
      const pkg = await Bun.file(path.join(cwd, "package.json")).json()
      if (pkg.version !== version || pkg.name !== `@mimo-ai/${name}`)
        throw new Error(`Invalid CLI platform package: ${name}`)
      return pack(cwd, output, pkg.name, version)
    }),
  )
  const stage = path.join(output, ".pack/cli")
  await mkdir(stage, { recursive: true })
  await cp(path.join(root, "packages/cli/bin"), path.join(stage, "bin"), { recursive: true })
  await cp(path.join(root, "packages/cli/script/postinstall.mjs"), path.join(stage, "postinstall.mjs"))
  await cp(path.join(root, "README_npm.md"), path.join(stage, "README.md"))
  await cp(path.join(root, "LICENSE"), path.join(stage, "LICENSE"))
  await Bun.write(
    path.join(stage, "package.json"),
    JSON.stringify(
      {
        name: "@mimo-ai/cli",
        version,
        description: "MiMo Code: Where Models and Agents Co-Evolve",
        license: "MIT",
        author: "Xiaomi MiMo Team",
        homepage: "https://mimo.xiaomi.com/coder",
        repository: { type: "git", url: "git+https://github.com/XiaomiMiMo/MiMo-Code.git" },
        bugs: { url: "https://github.com/XiaomiMiMo/MiMo-Code/issues" },
        keywords: ["ai", "cli", "code", "xiaomi", "mimo", "mimocode"],
        bin: { mimo: "./bin/mimo" },
        scripts: { postinstall: "bun ./postinstall.mjs || node ./postinstall.mjs" },
        optionalDependencies: Object.fromEntries(binaries.map((item) => [item.name, version])),
      },
      null,
      2,
    ) + "\n",
  )
  return [...binaries, await pack(stage, output, "@mimo-ai/cli", version)]
}
