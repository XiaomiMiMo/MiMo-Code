import path from "node:path"
import { directory, required, run } from "./context"
import { publicationOrder, type Manifest } from "./manifest"

export function npmCommands(manifest: Manifest) {
  return publicationOrder(manifest.artifacts).map((artifact) => [
    "npm",
    "publish",
    path.join(directory, artifact.file),
    "--access",
    "public",
    "--ignore-scripts",
    "--tag",
    "latest",
    "--registry",
    "https://registry.npmjs.org",
  ])
}

export async function npm(manifest: Manifest) {
  required("NODE_AUTH_TOKEN")
  // Keep the existing transition set: SDK, plugin, platforms, then wrapper.
  for (const args of npmCommands(manifest)) await run(args)
  console.log(`Published all 15 npm packages for ${manifest.tag}`)
}
