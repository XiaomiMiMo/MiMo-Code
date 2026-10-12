import path from "node:path"
import { directory, required, run, type Release } from "./context"
import type { Manifest } from "./manifest"

export function githubCommand(expected: Release, manifest: Manifest, repository: string) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("GH_REPO must be owner/repository")
  return [
    "gh",
    "release",
    "create",
    expected.tag,
    "--verify-tag",
    "--generate-notes",
    "--title",
    expected.tag,
    "--repo",
    repository,
    path.join(directory, "manifest.json"),
    ...manifest.artifacts.map((artifact) => path.join(directory, artifact.file)),
  ]
}

export async function github(expected: Release, manifest: Manifest) {
  required("GH_TOKEN")
  // gh creates a draft, uploads these assets, and publishes it after upload.
  // An existing release is an error; operators resolve failed drafts explicitly.
  await run(githubCommand(expected, manifest, required("GH_REPO")))
  console.log(`Published GitHub Release ${expected.tag}`)
}
