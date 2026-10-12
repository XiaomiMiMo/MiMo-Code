import { createHash } from "node:crypto"
import path from "node:path"

export const platforms = [
  "linux-arm64",
  "linux-x64",
  "linux-x64-baseline",
  "linux-arm64-musl",
  "linux-x64-musl",
  "linux-x64-baseline-musl",
  "darwin-arm64",
  "darwin-x64",
  "darwin-x64-baseline",
  "windows-arm64",
  "windows-x64",
  "windows-x64-baseline",
].map((name) => `mimocode-${name}`)

export type Artifact = {
  file: string
  size: number
  sha256: string
  kind: "archive" | "npm" | "models"
  name?: string
  integrity?: string
}

export type Manifest = {
  schema: 1
  version: string
  tag: string
  commit: string
  bun: string
  models: { source: string; sha256: string }
  artifacts: Artifact[]
  notes?: { baseline: string | null; body: string }
}

export function stableVersion(value: string) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`Expected a stable MAJOR.MINOR.PATCH version, received ${value}`)
  }
  return value
}

export function tagVersion(tag: string) {
  if (!tag.startsWith("v")) throw new Error(`Expected a vMAJOR.MINOR.PATCH tag, received ${tag}`)
  return stableVersion(tag.slice(1))
}

export function compareVersions(a: string, b: string) {
  const left = stableVersion(a).split(".").map(BigInt)
  const right = stableVersion(b).split(".").map(BigInt)
  const index = left.findIndex((value, i) => value !== right[i])
  return index < 0 ? 0 : left[index] > right[index] ? 1 : -1
}

export function advanceLatest(current: string | undefined, version: string) {
  stableVersion(version)
  return !current || compareVersions(current, version) < 0
}

export function digest(bytes: Uint8Array, algorithm: "sha256" | "sha512" = "sha256") {
  return createHash(algorithm)
    .update(bytes)
    .digest(algorithm === "sha512" ? "base64" : "hex")
}

export function verifyBytes(artifact: Artifact, bytes: Uint8Array) {
  if (bytes.byteLength !== artifact.size || digest(bytes) !== artifact.sha256) {
    throw new Error(`Artifact content conflict: ${artifact.file}`)
  }
  if (artifact.integrity && artifact.integrity !== `sha512-${digest(bytes, "sha512")}`) {
    throw new Error(`npm integrity conflict: ${artifact.file}`)
  }
}

export function publicationOrder(artifacts: Artifact[]) {
  const order = ["@mimo-ai/sdk", "@mimo-ai/plugin", ...platforms.map((name) => `@mimo-ai/${name}`), "@mimo-ai/cli"]
  return order.map((name) => {
    const artifact = artifacts.find((item) => item.kind === "npm" && item.name === name)
    if (!artifact) throw new Error(`Missing npm tarball: ${name}`)
    return artifact
  })
}

export function validateManifest(value: unknown, version: string, commit: string): Manifest {
  const manifest = value as Manifest
  if (
    !manifest ||
    manifest.schema !== 1 ||
    manifest.version !== stableVersion(version) ||
    manifest.tag !== `v${version}` ||
    manifest.commit !== commit ||
    !/^[a-f0-9]{40}$/.test(manifest.commit) ||
    typeof manifest.bun !== "string" ||
    typeof manifest.models?.source !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.models?.sha256) ||
    !Array.isArray(manifest.artifacts)
  ) {
    throw new Error("Release manifest does not match the version and commit being published")
  }
  const names = new Set<string>()
  for (const artifact of manifest.artifacts) {
    if (
      !artifact ||
      typeof artifact.file !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(artifact.file) ||
      names.has(artifact.file) ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size <= 0 ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      !["archive", "npm", "models"].includes(artifact.kind) ||
      (artifact.kind === "npm" && (!artifact.name || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(artifact.integrity ?? "")))
    ) {
      throw new Error("Invalid or duplicate release artifact")
    }
    names.add(artifact.file)
  }
  const archives = platforms.map((name) => `${name}.${name.includes("linux") ? "tar.gz" : "zip"}`)
  if (
    manifest.artifacts.length !== platforms.length * 2 + 4 ||
    manifest.artifacts.filter((item) => item.kind === "archive").length !== platforms.length ||
    !archives.every((file) => manifest.artifacts.some((item) => item.kind === "archive" && item.file === file)) ||
    manifest.artifacts.filter((item) => item.kind === "models").length !== 1 ||
    !manifest.artifacts.some((item) => item.kind === "models" && item.sha256 === manifest.models.sha256)
  ) {
    throw new Error("Release manifest must include all 12 archives, 15 npm tarballs and the models snapshot")
  }
  publicationOrder(manifest.artifacts)
  if (manifest.notes) {
    if (typeof manifest.notes.body !== "string" || !manifest.notes.body.trim()) throw new Error("Empty release notes")
    if (manifest.notes.baseline && compareVersions(tagVersion(manifest.notes.baseline), version) >= 0) {
      throw new Error("Release notes baseline must be an earlier stable version")
    }
  }
  return manifest
}

export async function verifyFiles(directory: string, manifest: Manifest) {
  // Compiled binaries are large; keep only one archive in memory at a time.
  for (const artifact of manifest.artifacts) {
    verifyBytes(artifact, await Bun.file(path.join(directory, artifact.file)).bytes())
  }
}

export function matchingBuild(a: Manifest, b: Manifest) {
  const build = (value: Manifest) => JSON.stringify({ ...value, notes: undefined })
  return build(a) === build(b)
}

export function sameBuild(a: Manifest, b: Manifest) {
  if (!matchingBuild(a, b)) throw new Error("Existing release manifest has different build inputs or artifacts")
}

export function assetAction(artifact: Artifact, bytes: Uint8Array, draft: boolean) {
  if (bytes.byteLength === artifact.size && digest(bytes) === artifact.sha256) return "reuse"
  if (draft) return "replace"
  throw new Error(`Published artifact content conflict: ${artifact.file}`)
}

export function registryValue(result: { exitCode: number; stdout: string; stderr: string }): unknown {
  const value = result.stdout.trim() ? JSON.parse(result.stdout) : undefined
  if (result.exitCode === 0) {
    if (value == null) throw new Error("npm registry returned no metadata for an existing package")
    return value
  }
  const error = value as { error?: { code?: string } } | undefined
  if (error?.error?.code === "E404") return undefined
  throw new Error("npm registry lookup failed; only E404 means a version is absent")
}
