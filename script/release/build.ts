import { cp, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { clean, directory, root, run, type Release } from "./context"
import { digest, platforms, validateManifest, verifyFiles, type Artifact, type Manifest } from "./manifest"
import { packCLI, packLibrary } from "./pack"
import { restoreRelease } from "./github"

export async function build(release: Release) {
  const recovery = await restoreRelease(release)
  if (recovery.reused) return
  if (await Bun.file(path.join(directory, "manifest.json")).exists()) {
    await verifyFiles(
      directory,
      validateManifest(await Bun.file(path.join(directory, "manifest.json")).json(), release.version, release.commit),
    )
    console.log("Reusing verified local release artifacts")
    return
  }
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })
  const source =
    recovery.source ?? `${(process.env.MIMOCODE_MODELS_URL || "https://models.dev").replace(/\/$/, "")}/api.json`
  const snapshot =
    recovery.snapshot ??
    (await (async () => {
      const response = await fetch(source, { signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error(`models snapshot request failed: HTTP ${response.status}`)
      return new Uint8Array(await response.arrayBuffer())
    })())
  await Bun.write(path.join(directory, "models.json"), snapshot)
  await run([process.execPath, "run", "packages/cli/script/build.ts", "--skip-install", "--archive"], root, {
    ...process.env,
    MIMOCODE_VERSION: release.version,
    MIMOCODE_CHANNEL: "latest",
    MODELS_DEV_API_JSON: path.join(directory, "models.json"),
  })
  await Promise.all(
    platforms.map((name) => {
      const file = `${name}.${name.includes("linux") ? "tar.gz" : "zip"}`
      return cp(path.join(root, "packages/cli/dist", file), path.join(directory, file))
    }),
  )
  const libraries = await Promise.all([packLibrary("sdk", directory), packLibrary("plugin", directory)])
  const packages = [...libraries, ...(await packCLI(directory, release.version))]
  await rm(path.join(directory, ".pack"), { recursive: true, force: true })
  const artifacts: Artifact[] = []
  // Hash large binaries one at a time to bound release-runner memory.
  for (const item of [
    ...platforms.map((name) => ({
      file: `${name}.${name.includes("linux") ? "tar.gz" : "zip"}`,
      kind: "archive" as const,
    })),
    ...packages.map((item) => ({ ...item, kind: "npm" as const })),
    { file: "models.json", kind: "models" as const },
  ]) {
    const bytes = await Bun.file(path.join(directory, item.file)).bytes()
    artifacts.push({
      ...item,
      size: bytes.length,
      sha256: digest(bytes),
      ...(item.kind === "npm" ? { integrity: `sha512-${digest(bytes, "sha512")}` } : {}),
    })
  }
  const manifest: Manifest = {
    schema: 1,
    ...release,
    bun: Bun.version,
    models: { source, sha256: digest(snapshot) },
    artifacts,
  }
  validateManifest(manifest, release.version, release.commit)
  await clean()
  await Bun.write(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
  console.log(`Built ${artifacts.length} verified artifacts for ${release.tag}`)
}
