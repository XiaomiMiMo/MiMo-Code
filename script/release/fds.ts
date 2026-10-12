import path from "node:path"
import { uploadFile } from "../fds-upload"
import { directory, required, type Release } from "./context"
import type { Manifest } from "./manifest"

export async function fds(expected: Release, manifest: Manifest) {
  required("MIMO_FDS_AK")
  required("MIMO_FDS_SK")
  for (const artifact of manifest.artifacts.filter((item) => item.kind === "archive")) {
    await uploadFile(path.join(directory, artifact.file), `releases/${expected.tag}/${artifact.file}`)
  }
  // Advance the installer pointer only after every archive upload succeeds.
  await Bun.write(path.join(directory, "latest.txt"), expected.version)
  await uploadFile(path.join(directory, "latest.txt"), "releases/latest", "text/plain")
  console.log(`Published FDS archives and latest for ${expected.tag}`)
}
