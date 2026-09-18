import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { Discovery } from "../../src/skill/discovery"
import { Global } from "../../src/global"
import { Filesystem } from "../../src/util"
import { rm } from "fs/promises"
import path from "path"

let CLOUDFLARE_SKILLS_URL: string
let server: ReturnType<typeof Bun.serve>
let downloadCount = 0
const unsafeRequests: string[] = []

const fixturePath = path.join(import.meta.dir, "../fixture/skills")
const cacheDir = path.join(Global.Path.cache, "skill-sources-v1")
const legacyCacheDir = path.join(Global.Path.cache, "skills")

beforeAll(async () => {
  await rm(cacheDir, { recursive: true, force: true })
  await rm(legacyCacheDir, { recursive: true, force: true })

  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const catalog = url.pathname.split("/")[1]
      if (catalog === "catalog-a" || catalog === "catalog-b" || catalog === "catalog-c") {
        if (url.pathname === `/${catalog}/index.json`) {
          return Response.json({
            skills: [{ name: "collision", files: ["SKILL.md", "references/detail.md", "references/literal%2E.md"] }],
          })
        }
        const pathname = decodeURIComponent(url.pathname)
        if (pathname === `/${catalog}/collision/SKILL.md`)
          return new Response(`---\nname: collision\ndescription: ${catalog}\n---\n${catalog}\n`)
        if (pathname === `/${catalog}/collision/references/detail.md`) return new Response(`${catalog} reference`)
        if (pathname === `/${catalog}/collision/references/literal%2E.md`)
          return new Response(`${catalog} literal filename`)
      }
      if (url.pathname === "/unsafe/index.json") {
        return Response.json({
          skills: [
            { name: "../escape", files: ["SKILL.md"] },
            { name: "bad\\name", files: ["SKILL.md"] },
            { name: "parent-file", files: ["SKILL.md", "../escape.md"] },
            { name: "drive-file", files: ["SKILL.md", "C:\\escape.md"] },
            { name: "absolute-file", files: ["SKILL.md", "/escape.md"] },
            { name: "url-file", files: ["SKILL.md", `${url.origin}/unexpected.md`] },
            { name: "CON", files: ["SKILL.md"] },
            { name: "trailing.", files: ["SKILL.md"] },
            { name: "device-file", files: ["SKILL.md", "references/NUL.txt"] },
            { name: "safe", files: ["SKILL.md", "references/note.md"] },
          ],
        })
      }
      if (
        url.pathname.startsWith("/unsafe/") ||
        url.pathname === "/escape/SKILL.md" ||
        url.pathname === "/unexpected.md" ||
        url.pathname === "/escape.md"
      ) {
        unsafeRequests.push(url.pathname)
        return new Response("safe test content")
      }

      // route /.well-known/skills/* to the fixture directory
      if (url.pathname.startsWith("/.well-known/skills/")) {
        const filePath = url.pathname.replace("/.well-known/skills/", "")
        const fullPath = path.join(fixturePath, filePath)

        if (await Filesystem.exists(fullPath)) {
          if (!fullPath.endsWith("index.json")) {
            downloadCount++
          }
          return new Response(Bun.file(fullPath))
        }
      }

      return new Response("Not Found", { status: 404 })
    },
  })

  CLOUDFLARE_SKILLS_URL = `http://localhost:${server.port}/.well-known/skills/`
})

afterAll(async () => {
  void server?.stop()
  await rm(cacheDir, { recursive: true, force: true })
  await rm(legacyCacheDir, { recursive: true, force: true })
})

describe("Discovery.pull", () => {
  const pull = (url: string) =>
    Effect.runPromise(Discovery.Service.use((s) => s.pull(url)).pipe(Effect.provide(Discovery.defaultLayer)))

  test("downloads skills from cloudflare url", async () => {
    const dirs = await pull(CLOUDFLARE_SKILLS_URL)
    expect(dirs.length).toBeGreaterThan(0)
    for (const dir of dirs) {
      expect(dir).toStartWith(cacheDir)
      const md = path.join(dir, "SKILL.md")
      expect(await Filesystem.exists(md)).toBe(true)
    }
  })

  test("url without trailing slash works", async () => {
    const dirs = await pull(CLOUDFLARE_SKILLS_URL.replace(/\/$/, ""))
    expect(dirs.length).toBeGreaterThan(0)
    for (const dir of dirs) {
      const md = path.join(dir, "SKILL.md")
      expect(await Filesystem.exists(md)).toBe(true)
    }
  })

  test("returns empty array for invalid url", async () => {
    const dirs = await pull(`http://localhost:${server.port}/invalid-url/`)
    expect(dirs).toEqual([])
  })

  test("returns empty array for non-json response", async () => {
    // any url not explicitly handled in server returns 404 text "Not Found"
    const dirs = await pull(`http://localhost:${server.port}/some-other-path/`)
    expect(dirs).toEqual([])
  })

  test("downloads reference files alongside SKILL.md", async () => {
    const dirs = await pull(CLOUDFLARE_SKILLS_URL)
    // find a skill dir that should have reference files (e.g. agents-sdk)
    const agentsSdk = dirs.find((d) => d.endsWith(path.sep + "agents-sdk"))
    expect(agentsSdk).toBeDefined()
    if (agentsSdk) {
      const refs = path.join(agentsSdk, "references")
      expect(await Filesystem.exists(path.join(agentsSdk, "SKILL.md"))).toBe(true)
      // agents-sdk has reference files per the index
      const refDir = await Array.fromAsync(new Bun.Glob("**/*.md").scan({ cwd: refs, onlyFiles: true }))
      expect(refDir.length).toBeGreaterThan(0)
    }
  })

  test("caches downloaded files on second pull", async () => {
    // clear dir and downloadCount
    await rm(cacheDir, { recursive: true, force: true })
    downloadCount = 0

    // first pull to populate cache
    const first = await pull(CLOUDFLARE_SKILLS_URL)
    expect(first.length).toBeGreaterThan(0)
    const firstCount = downloadCount
    expect(firstCount).toBeGreaterThan(0)

    // second pull should return same results from cache
    const second = await pull(CLOUDFLARE_SKILLS_URL)
    expect(second.length).toBe(first.length)
    expect(second.sort()).toEqual(first.sort())

    // second pull should NOT increment download count
    expect(downloadCount).toBe(firstCount)
  })

  // [TP-R12-09]
  test("keeps same-name skills and references from different source URLs separate", async () => {
    const legacy = path.join(legacyCacheDir, "collision", "SKILL.md")
    await Bun.write(legacy, "legacy source without URL identity")
    const first = await pull(`http://localhost:${server.port}/catalog-a/`)
    const second = await pull(`http://localhost:${server.port}/catalog-b/`)
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(first[0]).not.toBe(second[0])
    expect(await Filesystem.readText(path.join(first[0], "SKILL.md"))).toContain("catalog-a")
    expect(await Filesystem.readText(path.join(second[0], "SKILL.md"))).toContain("catalog-b")
    expect(await Filesystem.readText(path.join(first[0], "references/detail.md"))).toBe("catalog-a reference")
    expect(await Filesystem.readText(path.join(second[0], "references/detail.md"))).toBe("catalog-b reference")
    expect(await pull(`http://localhost:${server.port}/catalog-a`)).toEqual(first)
    expect(await Filesystem.readText(legacy)).toBe("legacy source without URL identity")
  })

  // [TP-R12-09]
  test("does not trust legacy nested files whose skill name equals a source digest", async () => {
    const url = `http://localhost:${server.port}/catalog-c/`
    const digest = createHash("sha256").update(url).digest("hex")
    const legacy = path.join(legacyCacheDir, digest, "collision", "SKILL.md")
    await Bun.write(legacy, "legacy nested content without source proof")
    const dirs = await pull(url)
    expect(dirs).toHaveLength(1)
    expect(await Filesystem.readText(path.join(dirs[0], "SKILL.md"))).toContain("catalog-c")
    expect(dirs[0]).toStartWith(cacheDir + path.sep)
    expect(await Filesystem.readText(legacy)).toBe("legacy nested content without source proof")
  })

  // [TP-R12-09]
  test("encodes declared filenames without interpreting their percent escapes", async () => {
    const dirs = await pull(`http://localhost:${server.port}/catalog-a/`)
    expect(await Filesystem.readText(path.join(dirs[0], "references/literal%2E.md"))).toBe("catalog-a literal filename")
  })

  // [TP-R12-09]
  test("rejects unsafe index paths before issuing downloads or writing outside the source", async () => {
    unsafeRequests.length = 0
    const dirs = await pull(`http://localhost:${server.port}/unsafe/`)
    expect(dirs).toHaveLength(1)
    expect(path.basename(dirs[0])).toBe("safe")
    expect(unsafeRequests.sort()).toEqual(["/unsafe/safe/SKILL.md", "/unsafe/safe/references/note.md"])
    expect(await Filesystem.exists(path.join(Global.Path.cache, "escape", "SKILL.md"))).toBe(false)
  })

  // [TP-R12-09]
  test("rejects malformed and non-HTTP sources", async () => {
    expect(await pull("not a URL")).toEqual([])
    expect(await pull("file:///tmp/example-skill-source")).toEqual([])
  })
})
