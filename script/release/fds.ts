import path from "node:path"
import { authHeader, FDS_BUCKET, FDS_ENDPOINT, objectName, setPublicReadAcl, uploadFile } from "../fds-upload"
import { directory, required, type Release } from "./context"
import { advanceLatest, compareVersions, stableVersion, verifyBytes, type Manifest } from "./manifest"
import { verifyGitHub } from "./github"

function base() {
  return (process.env.MIMO_FDS_BASE || "https://mimocode.cnbj1.mi-fds.com/mimocode/mimocode").replace(/\/$/, "")
}

async function publicRead(subpath: string) {
  const response = await fetch(`${base()}/${subpath}?release-check=${Date.now()}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(120_000),
  })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`FDS public read failed: HTTP ${response.status} (${subpath})`)
  return new Uint8Array(await response.arrayBuffer())
}

async function originRead(subpath: string) {
  const url = `https://${FDS_ENDPOINT}/${FDS_BUCKET}/${objectName(subpath)}`
  const date = new Date().toUTCString()
  const response = await fetch(url, {
    headers: {
      date,
      authorization: authHeader({
        accessKey: required("MIMO_FDS_AK"),
        secret: required("MIMO_FDS_SK"),
        method: "GET",
        url,
        date,
      }),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(120_000),
  })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`FDS origin read failed: HTTP ${response.status} (${subpath})`)
  return new Uint8Array(await response.arrayBuffer())
}

function latest(bytes: Uint8Array | undefined) {
  return bytes ? stableVersion(new TextDecoder().decode(bytes).trim()) : undefined
}

export async function verifyFDS(expected: Release, manifest: Manifest) {
  const current = latest(await publicRead("releases/latest"))
  if (!current || compareVersions(current, expected.version) < 0)
    throw new Error("FDS latest has not completed this release")
  for (const artifact of manifest.artifacts.filter((item) => item.kind === "archive")) {
    const bytes = await publicRead(`releases/${expected.tag}/${artifact.file}`)
    if (!bytes) throw new Error(`FDS archive is not publicly readable: ${artifact.file}`)
    verifyBytes(artifact, bytes)
  }
}

export async function fds(expected: Release, manifest: Manifest) {
  required("MIMO_FDS_AK")
  required("MIMO_FDS_SK")
  await verifyGitHub(expected, manifest)
  for (const artifact of manifest.artifacts.filter((item) => item.kind === "archive")) {
    const subpath = `releases/${expected.tag}/${artifact.file}`
    const existing = await originRead(subpath)
    if (existing) {
      verifyBytes(artifact, existing)
      // A previous PUT may have succeeded before its public ACL request failed.
      await setPublicReadAcl({
        accessKey: required("MIMO_FDS_AK"),
        secret: required("MIMO_FDS_SK"),
        name: objectName(subpath),
      })
    }
    if (!existing) await uploadFile(path.join(directory, artifact.file), subpath)
    const bytes = await publicRead(subpath)
    if (!bytes) throw new Error(`FDS upload is not publicly readable: ${artifact.file}`)
    verifyBytes(artifact, bytes)
  }
  // Read the authoritative pointer immediately before advancing it. Release
  // jobs hold the repository-wide publication lock across all three channels.
  const current = latest(await originRead("releases/latest"))
  if (advanceLatest(current, expected.version)) {
    await Bun.write(path.join(directory, "latest.txt"), expected.version)
    await uploadFile(path.join(directory, "latest.txt"), "releases/latest", "text/plain")
  }
  if (current === expected.version) {
    await setPublicReadAcl({
      accessKey: required("MIMO_FDS_AK"),
      secret: required("MIMO_FDS_SK"),
      name: objectName("releases/latest"),
    })
  }
  await verifyFDS(expected, manifest)
  console.log(`Verified FDS archives for ${expected.tag}; latest never moves backwards`)
}
