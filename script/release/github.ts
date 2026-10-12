import { mkdir } from "node:fs/promises"
import path from "node:path"
import { command, directory, required, run, type Release } from "./context"
import {
  advanceLatest,
  assetAction,
  compareVersions,
  matchingBuild,
  sameBuild,
  tagVersion,
  validateManifest,
  verifyBytes,
  type Manifest,
} from "./manifest"

type Asset = { id: number; name: string; url: string; size: number; digest?: string | null }
type GitHubRelease = {
  id: number
  tag_name: string
  draft: boolean
  prerelease: boolean
  body: string
  assets: Asset[]
}

function repo() {
  const value = required("GH_REPO")
  if (!/^[\w.-]+\/[\w.-]+$/.test(value)) throw new Error("GH_REPO must be owner/repository")
  return value
}

async function request(route: string, binary = false) {
  const response = await fetch(`https://api.github.com/repos/${repo()}/${route}`, {
    headers: {
      accept: binary ? "application/octet-stream" : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {}),
    },
    signal: AbortSignal.timeout(120_000),
  })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`GitHub request failed: HTTP ${response.status} (${route})`)
  return response
}

export async function findRelease(tag: string): Promise<GitHubRelease | undefined> {
  return (await request(`releases/tags/${encodeURIComponent(tag)}`))?.json()
}

async function assetBytes(asset: Asset) {
  const response = await request(`releases/assets/${asset.id}`, true)
  if (!response) throw new Error(`GitHub asset disappeared: ${asset.name}`)
  return new Uint8Array(await response.arrayBuffer())
}

async function remoteManifest(release: GitHubRelease, expected: Release) {
  const asset =
    release.assets.find((item) => item.name === "manifest.json") ??
    (release.draft ? release.assets.find((item) => item.name === "manifest.previous.json") : undefined)
  if (!asset) return undefined
  return validateManifest(
    JSON.parse(new TextDecoder().decode(await assetBytes(asset))),
    expected.version,
    expected.commit,
  )
}

export async function restoreRelease(
  expected: Release,
): Promise<{ reused: boolean; snapshot?: Uint8Array; source?: string }> {
  const release = await findRelease(expected.tag)
  if (!release) return { reused: false }
  const manifest = await remoteManifest(release, expected)
  if (!manifest) {
    if (!release.draft || release.assets.length) throw new Error("Existing release has assets but no verified manifest")
    return { reused: false }
  }
  if (manifest.bun !== Bun.version) throw new Error("Existing release used a different Bun version")
  const recoverDraft = async () => {
    if (!release.draft)
      throw new Error("Published release has missing or changed assets; recover the original workflow artifact")
    const model = manifest.artifacts.find((item) => item.kind === "models")!
    const asset = release.assets.find((item) => item.name === model.file)
    const bytes = asset ? await assetBytes(asset) : undefined
    const snapshot = bytes && assetAction(model, bytes, true) === "reuse" ? bytes : undefined
    console.log("Rebuilding incomplete draft from the same tag and commit")
    return { reused: false, snapshot, source: manifest.models.source }
  }
  if (
    manifest.artifacts.some((artifact) => {
      const asset = release.assets.find((item) => item.name === artifact.file)
      return !asset || asset.size !== artifact.size || (asset.digest && asset.digest !== `sha256:${artifact.sha256}`)
    })
  )
    return recoverDraft()
  await mkdir(directory, { recursive: true })
  for (const artifact of manifest.artifacts) {
    const local = Bun.file(path.join(directory, artifact.file))
    if ((await local.exists()) && assetAction(artifact, await local.bytes(), true) === "reuse") continue
    const asset = release.assets.find((item) => item.name === artifact.file)
    if (!asset)
      throw new Error(
        `Incomplete GitHub upload (${artifact.file}); rerun the failed upload job with the original workflow artifact`,
      )
    const bytes = await assetBytes(asset)
    if (assetAction(artifact, bytes, release.draft) === "replace") return recoverDraft()
    verifyBytes(artifact, bytes)
    await Bun.write(local, bytes)
  }
  await Bun.write(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
  console.log("Reused immutable GitHub release artifacts")
  return { reused: true }
}

async function previousTag(expected: Release) {
  const candidates: { tag: string; distance: number }[] = []
  for (let page = 1; ; page++) {
    const response = await request(`releases?per_page=100&page=${page}`)
    if (!response) throw new Error("GitHub repository is unavailable")
    const releases = (await response.json()) as GitHubRelease[]
    for (const release of releases) {
      if (release.draft || release.prerelease || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.tag_name))
        continue
      if (compareVersions(tagVersion(release.tag_name), expected.version) >= 0) continue
      const ref = `refs/tags/${release.tag_name}^{commit}`
      const ancestor = await command(["git", "merge-base", "--is-ancestor", ref, expected.commit])
      if (ancestor.exitCode === 1) continue
      if (ancestor.exitCode !== 0)
        throw new Error(`Cannot resolve release baseline ${release.tag_name}; fetch the complete tag history`)
      candidates.push({
        tag: release.tag_name,
        distance: Number(await run(["git", "rev-list", "--count", `${ref}..${expected.commit}`])),
      })
    }
    if (releases.length < 100) break
  }
  return (
    candidates.sort((a, b) => a.distance - b.distance || compareVersions(tagVersion(b.tag), tagVersion(a.tag)))[0]
      ?.tag ?? null
  )
}

export function notesBaseline(body: string, repository: string, tag: string) {
  const prefix = `https://github.com/${repository}/compare/`
  const comparison = body.split(prefix)[1]?.split(/\s|\)/)[0]
  if (!comparison) return null
  const [baseline, target] = comparison.split("...")
  if (target !== tag) return null
  tagVersion(baseline)
  return baseline
}

export async function verifyGitHub(expected: Release, manifest: Manifest) {
  const release = await findRelease(expected.tag)
  if (!release || release.draft || release.prerelease)
    throw new Error("GitHub Release must be published before this stage")
  const remote = await remoteManifest(release, expected)
  if (!remote?.notes || remote.notes.body !== release.body)
    throw new Error("Published release notes or manifest are missing or changed")
  sameBuild(manifest, remote)
  for (const artifact of manifest.artifacts) {
    const asset = release.assets.find((item) => item.name === artifact.file)
    if (!asset) throw new Error(`Missing GitHub asset: ${artifact.file}`)
    if (asset.size !== artifact.size || (asset.digest && asset.digest !== `sha256:${artifact.sha256}`)) {
      throw new Error(`GitHub asset digest conflict: ${artifact.file}`)
    }
    if (!asset.digest) verifyBytes(artifact, await assetBytes(asset))
  }
  return release
}

export async function github(expected: Release, manifest: Manifest) {
  required("GH_TOKEN")
  const existing = await findRelease(expected.tag)
  const saved = existing ? await remoteManifest(existing, expected) : undefined
  if (existing && !existing.draft && !saved) throw new Error("Published release is missing its immutable manifest")
  if (saved && !existing?.draft) sameBuild(manifest, saved)
  const baseline = saved?.notes
    ? saved.notes.baseline
    : existing
      ? notesBaseline(existing.body ?? "", repo(), expected.tag)
      : await previousTag(expected)
  if (baseline) await run(["git", "merge-base", "--is-ancestor", `refs/tags/${baseline}^{commit}`, expected.commit])
  if (!existing) {
    await run([
      "gh",
      "release",
      "create",
      expected.tag,
      "--draft",
      "--verify-tag",
      "--generate-notes",
      "--latest=false",
      "--target",
      expected.commit,
      "--title",
      expected.tag,
      "--repo",
      repo(),
      ...(baseline ? ["--notes-start-tag", baseline] : []),
    ])
  }
  const release = existing ?? (await findRelease(expected.tag))
  if (!release || release.prerelease || !release.body?.trim())
    throw new Error("GitHub did not produce stable release notes")
  if (saved?.notes && saved.notes.body !== release.body)
    throw new Error("Existing release notes differ from the saved manifest")
  if (!saved?.notes && baseline && !release.body.includes(`/compare/${baseline}...${expected.tag}`)) {
    throw new Error("Existing notes do not match the selected ancestor baseline")
  }
  const complete: Manifest = { ...manifest, notes: saved?.notes ?? { baseline, body: release.body } }
  await Bun.write(path.join(directory, "manifest.json"), JSON.stringify(complete, null, 2) + "\n")
  // An unpublished draft can be rebuilt at the same tag/SHA after a partial
  // upload. Published manifests and assets are immutable.
  const prior = release.assets.find((item) => item.name === "manifest.json")
  if (saved && !matchingBuild(saved, manifest) && prior) {
    const backup = release.assets.find((item) => item.name === "manifest.previous.json")
    if (backup) await run(["gh", "api", "--method", "DELETE", `repos/${repo()}/releases/assets/${backup.id}`])
    await run([
      "gh",
      "api",
      "--method",
      "PATCH",
      `repos/${repo()}/releases/assets/${prior.id}`,
      "-f",
      "name=manifest.previous.json",
    ])
  }
  if (!prior || !saved || !matchingBuild(saved, manifest))
    await run(["gh", "release", "upload", expected.tag, path.join(directory, "manifest.json"), "--repo", repo()])
  // Preserve the external build input early so a partial draft can reuse it.
  for (const artifact of [...manifest.artifacts].sort(
    (a, b) => Number(b.kind === "models") - Number(a.kind === "models"),
  )) {
    const asset = release.assets.find((item) => item.name === artifact.file)
    if (asset) {
      if (assetAction(artifact, await assetBytes(asset), release.draft) === "reuse") continue
      await run(["gh", "api", "--method", "DELETE", `repos/${repo()}/releases/assets/${asset.id}`])
    }
    await run(["gh", "release", "upload", expected.tag, path.join(directory, artifact.file), "--repo", repo()])
    const uploaded = (await findRelease(expected.tag))?.assets.find((item) => item.name === artifact.file)
    if (!uploaded) throw new Error(`Uploaded GitHub asset is missing: ${artifact.file}`)
    verifyBytes(artifact, await assetBytes(uploaded))
  }
  const backup = (await findRelease(expected.tag))?.assets.find((item) => item.name === "manifest.previous.json")
  if (backup && release.draft)
    await run(["gh", "api", "--method", "DELETE", `repos/${repo()}/releases/assets/${backup.id}`])
  const latest = await request("releases/latest")
  const current = latest ? tagVersion(((await latest.json()) as GitHubRelease).tag_name) : undefined
  await run([
    "gh",
    "release",
    "edit",
    expected.tag,
    "--draft=false",
    `--latest=${advanceLatest(current, expected.version) || current === expected.version}`,
    "--repo",
    repo(),
  ])
  await verifyGitHub(expected, complete)
  console.log(`Published GitHub Release ${expected.tag}`)
}
