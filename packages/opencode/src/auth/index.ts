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

/** Whether reads currently come from a snapshot rather than the file. */
const snapshotActive = () => injected !== undefined || process.env.MIMOCODE_AUTH_CONTENT !== undefined

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

    const all = Effect.fn("Auth.all")(function* () {
      const raw = injected ?? process.env.MIMOCODE_AUTH_CONTENT
      if (raw) {
        try {
          return JSON.parse(raw)
        } catch (err) {}
      }

      const data = (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
      return Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    // A mutation through this service is authoritative, so the snapshot has to move with the write.
    // Otherwise a write while `inject` (or the env fallback) is active reaches only the file while
    // every later read keeps returning the pre-write state: an OAuth refresh, a key rotation or a
    // logout looks like it succeeded and changes nothing. Updated only after the write lands, so a
    // failed write cannot leave memory and disk disagreeing. The host re-injects from the file on its
    // own schedule, which converges on the same content.
    const persist = Effect.fn("Auth.persist")(function* (data: Record<string, Info>) {
      yield* fsys.writeJson(file, data, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
      if (snapshotActive()) injected = JSON.stringify(data)
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* all()
      if (norm !== key) delete data[key]
      delete data[norm + "/"]
      yield* persist({ ...data, [norm]: info })
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* all()
      delete data[key]
      delete data[norm]
      yield* persist(data)
    })

    return Service.of({ get, all, set, remove })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer))

export * as Auth from "."
