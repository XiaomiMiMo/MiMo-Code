import { createHash } from "node:crypto"
import { NodePath } from "@effect/platform-node"
import { Effect, Layer, Path, Schema, Context } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Global } from "../global"
import { Log } from "../util"

const skillConcurrency = 4
const fileConcurrency = 8

function sourceURL(input: string): URL | undefined {
  try {
    const url = new URL(input)
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return undefined
    if (!url.pathname.endsWith("/")) url.pathname += "/"
    url.hash = ""
    return url
  } catch {
    return undefined
  }
}

function safeSegment(value: string) {
  if (!value || value === "." || value === ".." || value.endsWith(".") || value.endsWith(" ")) return false
  if (/[\\/:<>"|?*]/.test(value)) return false
  for (const char of value) {
    if (char.charCodeAt(0) < 32) return false
  }
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/i.test(value)) return false
  try {
    encodeURIComponent(value)
    return true
  } catch {
    return false
  }
}

class IndexSkill extends Schema.Class<IndexSkill>("IndexSkill")({
  name: Schema.String,
  files: Schema.Array(Schema.String),
}) {}

class Index extends Schema.Class<Index>("Index")({
  skills: Schema.Array(IndexSkill),
}) {}

export interface Interface {
  readonly pull: (url: string) => Effect.Effect<string[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SkillDiscovery") {}

export const layer: Layer.Layer<Service, never, AppFileSystem.Service | Path.Path | HttpClient.HttpClient> =
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const log = Log.create({ service: "skill-discovery" })
      const fs = yield* AppFileSystem.Service
      const path = yield* Path.Path
      const http = HttpClient.filterStatusOk(withTransientReadRetry(yield* HttpClient.HttpClient))
      const cache = path.join(Global.Path.cache, "skill-sources-v1")

      const download = Effect.fn("Discovery.download")(function* (url: string, dest: string) {
        if (yield* fs.exists(dest).pipe(Effect.orDie)) return true

        return yield* HttpClientRequest.get(url).pipe(
          http.execute,
          Effect.flatMap((res) => res.arrayBuffer),
          Effect.flatMap((body) => fs.writeWithDirs(dest, new Uint8Array(body))),
          Effect.as(true),
          Effect.catch((err) =>
            Effect.sync(() => {
              log.error("failed to download", { url, err })
              return false
            }),
          ),
        )
      })

      const pull = Effect.fn("Discovery.pull")(function* (url: string) {
        const base = sourceURL(url)
        if (!base) return []
        const index = new URL("index.json", base).href
        const source = createHash("sha256").update(base.href).digest("hex")
        const sourceCache = path.join(cache, source)

        log.info("fetching index", { url: index })

        const data = yield* HttpClientRequest.get(index).pipe(
          HttpClientRequest.acceptJson,
          http.execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Index)),
          Effect.catch((err) =>
            Effect.sync(() => {
              log.error("failed to fetch index", { url: index, err })
              return null
            }),
          ),
        )

        if (!data) return []

        const list = data.skills.filter((skill) => {
          if (!safeSegment(skill.name) || !skill.files.every((file) => file.split("/").every(safeSegment))) {
            log.warn("skill entry has an unsafe path", { source })
            return false
          }
          if (!skill.files.includes("SKILL.md")) {
            log.warn("skill entry missing SKILL.md", { url: index, skill: skill.name })
            return false
          }
          return true
        })

        const dirs = yield* Effect.forEach(
          list,
          (skill) =>
            Effect.gen(function* () {
              const root = path.join(sourceCache, skill.name)
              const skillURL = new URL(`${encodeURIComponent(skill.name)}/`, base)

              yield* Effect.forEach(
                skill.files,
                (file) =>
                  download(
                    new URL(file.split("/").map(encodeURIComponent).join("/"), skillURL).href,
                    path.join(root, file),
                  ),
                {
                  concurrency: fileConcurrency,
                },
              )

              const md = path.join(root, "SKILL.md")
              return (yield* fs.exists(md).pipe(Effect.orDie)) ? root : null
            }),
          { concurrency: skillConcurrency },
        )

        return dirs.filter((dir): dir is string => dir !== null)
      })

      return Service.of({ pull })
    }),
  )

export const defaultLayer: Layer.Layer<Service> = layer.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(NodePath.layer),
)

export * as Discovery from "./discovery"
