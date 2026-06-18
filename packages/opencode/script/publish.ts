#!/usr/bin/env bun
import { $ } from "bun"
import pkg from "../package.json"
import { Script } from "@mimo-ai/script"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

async function published(name: string, version: string) {
  return (await $`npm view ${name}@${version} version`.nothrow()).exitCode === 0
}

async function publish(dir: string, name: string, version: string) {
  if (process.platform !== "win32") await $`chmod -R 755 .`.cwd(dir)
  if (await published(name, version)) {
    console.log(`already published ${name}@${version}`)
    return
  }
  await $`rm -f *.tgz`.cwd(dir).nothrow()
  await $`bun pm pack`.cwd(dir)
  await $`npm publish *.tgz --access public --tag ${Script.channel}`.cwd(dir)
}

const binaries: { dir: string; name: string; version: string }[] = []
for (const filepath of new Bun.Glob("*/package.json").scanSync({ cwd: "./dist" })) {
  const p = await Bun.file(`./dist/${filepath}`).json()
  binaries.push({ dir: `./dist/${filepath.replace("/package.json", "")}`, name: p.name, version: p.version })
}
console.log("binaries", Object.fromEntries(binaries.map((b) => [b.name, b.version])))
const version = binaries[0].version

await $`rm -rf ./dist/${pkg.name}`
await $`mkdir -p ./dist/${pkg.name}`
await $`cp -r ./bin ./dist/${pkg.name}/bin`
await $`cp ./script/postinstall.mjs ./dist/${pkg.name}/postinstall.mjs`
await Bun.file(`./dist/${pkg.name}/LICENSE`).write(await Bun.file("../../LICENSE").text())
await Bun.file(`./dist/${pkg.name}/README.md`).write(await Bun.file("../../README_npm.md").text())

await Bun.file(`./dist/${pkg.name}/package.json`).write(
  JSON.stringify(
    {
      name: pkg.name,
      version: version,
      description: "MiMo Code: Where Models and Agents Co-Evolve",
      license: "MIT",
      author: "Xiaomi MiMo Team",
      homepage: "https://mimo.xiaomi.com/coder",
      repository: {
        type: "git",
        url: "git+https://github.com/XiaomiMiMo/MiMo-Code.git",
      },
      bugs: {
        url: "https://github.com/XiaomiMiMo/MiMo-Code/issues",
      },
      keywords: ["ai", "cli", "code", "xiaomi", "mimo", "mimocode"],
      bin: {
        mimo: "./bin/mimo",
      },
      scripts: {
        postinstall: "bun ./postinstall.mjs || node ./postinstall.mjs",
      },
      optionalDependencies: Object.fromEntries(binaries.map((b) => [b.name, b.version])),
    },
    null,
    2,
  ),
)

const tasks = binaries.map(async (b) => {
  await publish(b.dir, b.name, b.version)
})
await Promise.all(tasks)
await publish(`./dist/${pkg.name}`, pkg.name, version)
