import path from "node:path"
import { command, directory, required, run, type Release } from "./context"
import { advanceLatest, publicationOrder, registryValue, type Artifact, type Manifest } from "./manifest"
import { verifyFDS } from "./fds"
import { verifyGitHub } from "./github"

async function view(name: string, field: string) {
  return registryValue(
    await command(["npm", "view", name, field, "--json", "--registry", "https://registry.npmjs.org"]),
  )
}

export function verifyIntegrity(artifact: Artifact, value: unknown) {
  if (value !== artifact.integrity) throw new Error(`Existing npm package has different integrity: ${artifact.name}`)
}

export async function npm(expected: Release, manifest: Manifest) {
  required("NODE_AUTH_TOKEN")
  await run(["npm", "whoami", "--registry", "https://registry.npmjs.org"])
  await verifyGitHub(expected, manifest)
  await verifyFDS(expected, manifest)
  for (const artifact of publicationOrder(manifest.artifacts)) {
    const spec = `${artifact.name}@${expected.version}`
    const existing = await view(spec, "dist.integrity")
    if (existing != null) verifyIntegrity(artifact, existing)
    if (existing == null) {
      // A version-specific dist-tag prevents npm publish from implicitly
      // moving latest backwards when an older release is resumed.
      await run([
        "npm",
        "publish",
        path.join(directory, artifact.file),
        "--access",
        "public",
        "--ignore-scripts",
        "--tag",
        `release-${expected.version}`,
        "--registry",
        "https://registry.npmjs.org",
      ])
      verifyIntegrity(artifact, await view(spec, "dist.integrity"))
    }
    const tags = (await view(artifact.name!, "dist-tags")) as Record<string, string> | undefined
    if (advanceLatest(tags?.latest, expected.version)) {
      await run(["npm", "dist-tag", "add", spec, "latest", "--registry", "https://registry.npmjs.org"])
      const updated = (await view(artifact.name!, "dist-tags")) as Record<string, string> | undefined
      if (updated?.latest !== expected.version) throw new Error(`npm latest verification failed: ${artifact.name}`)
    }
    console.log(`Verified npm package ${spec}`)
  }
}
