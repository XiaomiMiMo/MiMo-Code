import path from "path"
import { Effect, Layer, Record, Result, Schema, Context } from "effect"
import { zod } from "@/util/effect-zod"
import { Global } from "../global"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"

export const OAUTH_DUMMY_KEY = "mimocode-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")

/**
 * Credentials supplied by an embedding host (the desktop app runs the engine in-process).
 *
 * Kept in memory on purpose: the previous channel was `MIMOCODE_AUTH_CONTENT`, and anything in
 * the environment is readable by every child the engine spawns — the bash tool alone turns
 * `echo $MIMOCODE_AUTH_CONTENT` into a credential dump, and a sibling can still read
 * `/proc/<pid>/environ` even after the child's own env is scrubbed. A module-level value has no
 * such surface. The env var is still honored so workspace children keep working (they receive it
 * explicitly), but hosts should prefer `inject`.
 */
let injected: string | undefined

/** Set (or clear, with `undefined`) the in-process credentials. Read on every `all()`. */
export function inject(content: string | undefined) {
  injected = content
}

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: Schema.Number,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

const _Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export const Info = Object.assign(_Info, { zod: zod(_Info) })
export type Info = Schema.Schema.Type<typeof _Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

/**
 * `metadata` is typed as string → string, but hosts sharing auth.json may add
 * non-string fields (MiMo Desktop's `platform_linked: true`). Drop those from the
 * decoded view instead of rejecting the whole credential.
 */
function stringMetadata(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const entry = value as { type?: unknown; metadata?: unknown }
  const metadata = entry.metadata
  if (entry.type !== "api" || !metadata || typeof metadata !== "object" || Array.isArray(metadata)) return value
  return {
    ...entry,
    metadata: Object.fromEntries(Object.entries(metadata).filter(([, field]) => typeof field === "string")),
  }
}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* AppFileSystem.Service
    const decode = Schema.decodeUnknownOption(Info)

    // Host-supplied JSON is trusted as-is; the file is decoded per entry.
    const source = Effect.fn("Auth.source")(function* () {
      const raw = injected ?? process.env.MIMOCODE_AUTH_CONTENT
      if (raw) {
        try {
          return { data: JSON.parse(raw) as Record<string, unknown>, trusted: true }
        } catch (err) {}
      }
      const data = (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
      return { data, trusted: false }
    })

    const all = Effect.fn("Auth.all")(function* () {
      const { data, trusted } = yield* source()
      if (trusted) return data as Record<string, Info>
      return Record.filterMap(data, (value) => Result.fromOption(decode(stringMetadata(value)), () => undefined))
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    // Writes mutate the raw JSON so entries (or metadata fields) this build does not
    // understand — e.g. a host's `platform_linked: true` — survive the rewrite.
    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      const norm = key.replace(/\/+$/, "")
      const { data } = yield* source()
      if (norm !== key) delete data[key]
      delete data[norm + "/"]
      yield* fsys
        .writeJson(file, { ...data, [norm]: info }, 0o600)
        .pipe(Effect.mapError(fail("Failed to write auth data")))
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      const norm = key.replace(/\/+$/, "")
      const { data } = yield* source()
      delete data[key]
      delete data[norm]
      yield* fsys.writeJson(file, data, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
    })

    return Service.of({ get, all, set, remove })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer))

export * as Auth from "."
