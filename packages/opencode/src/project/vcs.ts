import { Effect, Layer, Context, Stream, Scope } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { formatPatch, structuredPatch } from "diff"
import path from "path"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect"
import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { FileWatcher } from "@/file/watcher"
import { Git } from "@/git"
import { Log } from "@/util"
import z from "zod"
import {
  envGitHubToken,
  mapPullsResponse,
  noBranch,
  notGitHub,
  parseGitHubRepo,
  requestError,
  type PullRequest as PullRequestInfo,
} from "./github-repo"

const log = Log.create({ service: "vcs" })

const count = (text: string) => {
  if (!text) return 0
  if (!text.endsWith("\n")) return text.split("\n").length
  return text.slice(0, -1).split("\n").length
}

const work = Effect.fnUntraced(function* (fs: AppFileSystem.Interface, cwd: string, file: string) {
  const full = path.join(cwd, file)
  if (!(yield* fs.exists(full).pipe(Effect.orDie))) return ""
  const buf = yield* fs.readFile(full).pipe(Effect.catch(() => Effect.succeed(new Uint8Array())))
  if (Buffer.from(buf).includes(0)) return ""
  return Buffer.from(buf).toString("utf8")
})

const nums = (list: Git.Stat[]) =>
  new Map(list.map((item) => [item.file, { additions: item.additions, deletions: item.deletions }] as const))

const merge = (...lists: Git.Item[][]) => {
  const out = new Map<string, Git.Item>()
  lists.flat().forEach((item) => {
    if (!out.has(item.file)) out.set(item.file, item)
  })
  return [...out.values()]
}

const files = Effect.fnUntraced(function* (
  fs: AppFileSystem.Interface,
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
  list: Git.Item[],
  map: Map<string, { additions: number; deletions: number }>,
) {
  const base = ref ? yield* git.prefix(cwd) : ""
  const patch = (file: string, before: string, after: string) =>
    formatPatch(structuredPatch(file, file, before, after, "", "", { context: Number.MAX_SAFE_INTEGER }))
  const next = yield* Effect.forEach(
    list,
    (item) =>
      Effect.gen(function* () {
        const before = item.status === "added" || !ref ? "" : yield* git.show(cwd, ref, item.file, base)
        const after = item.status === "deleted" ? "" : yield* work(fs, cwd, item.file)
        const stat = map.get(item.file)
        return {
          file: item.file,
          patch: patch(item.file, before, after),
          additions: stat?.additions ?? (item.status === "added" ? count(after) : 0),
          deletions: stat?.deletions ?? (item.status === "deleted" ? count(before) : 0),
          status: item.status,
        } satisfies FileDiff
      }),
    { concurrency: 8 },
  )
  return next.toSorted((a, b) => a.file.localeCompare(b.file))
})

const track = Effect.fnUntraced(function* (
  fs: AppFileSystem.Interface,
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
) {
  if (!ref) return yield* files(fs, git, cwd, ref, yield* git.status(cwd), new Map())
  const [list, stats] = yield* Effect.all([git.status(cwd), git.stats(cwd, ref)], { concurrency: 2 })
  return yield* files(fs, git, cwd, ref, list, nums(stats))
})

const compare = Effect.fnUntraced(function* (
  fs: AppFileSystem.Interface,
  git: Git.Interface,
  cwd: string,
  ref: string,
) {
  const [list, stats, extra] = yield* Effect.all([git.diff(cwd, ref), git.stats(cwd, ref), git.status(cwd)], {
    concurrency: 3,
  })
  return yield* files(
    fs,
    git,
    cwd,
    ref,
    merge(
      list,
      extra.filter((item) => item.code === "??"),
    ),
    nums(stats),
  )
})

export const Mode = z.enum(["git", "branch"])
export type Mode = z.infer<typeof Mode>

export const Event = {
  BranchUpdated: BusEvent.define(
    "vcs.branch.updated",
    z.object({
      branch: z.string().optional(),
    }),
  ),
}

export const Info = z
  .object({
    branch: z.string().optional(),
    default_branch: z.string().optional(),
  })
  .meta({
    ref: "VcsInfo",
  })
export type Info = z.infer<typeof Info>

export const PullRequest = z
  .object({
    status: z.enum(["ok", "none", "unauthorized", "not_github", "rate_limited", "no_branch", "error"]),
    authenticated: z.boolean(),
    owner: z.string().optional(),
    repo: z.string().optional(),
    branch: z.string().optional(),
    pull: z
      .object({
        number: z.number(),
        state: z.string(),
        title: z.string().optional(),
        url: z.string().optional(),
      })
      .optional(),
    message: z.string().optional(),
  })
  .meta({
    ref: "VcsPullRequest",
  })
export type PullRequest = z.infer<typeof PullRequest>

export const FileDiff = z
  .object({
    file: z.string(),
    patch: z.string(),
    additions: z.number(),
    deletions: z.number(),
    status: z.enum(["added", "deleted", "modified"]).optional(),
  })
  .meta({
    ref: "VcsFileDiff",
  })
export type FileDiff = z.infer<typeof FileDiff>

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly branch: () => Effect.Effect<string | undefined>
  readonly defaultBranch: () => Effect.Effect<string | undefined>
  readonly diff: (mode: Mode) => Effect.Effect<FileDiff[]>
  readonly pullRequest: () => Effect.Effect<PullRequest>
}

interface State {
  current: string | undefined
  root: Git.Base | undefined
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Vcs") {}

export const layer: Layer.Layer<
  Service,
  never,
  | AppFileSystem.Service
  | Git.Service
  | Bus.Service
  | HttpClient.HttpClient
  | ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const git = yield* Git.Service
    const bus = yield* Bus.Service
    const scope = yield* Scope.Scope
    const http = yield* HttpClient.HttpClient
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

    const resolveGitHubToken = Effect.fn("Vcs.resolveGitHubToken")(
      function* () {
        const fromEnv = envGitHubToken(process.env)
        if (fromEnv) return fromEnv

        const proc = ChildProcess.make("gh", ["auth", "token"], {
          extendEnv: true,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        })
        const handle = yield* spawner.spawn(proc)
        const [stdout, exitCode] = yield* Effect.all([Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode], {
          concurrency: 2,
        })
        if (exitCode !== 0) return
        const token = stdout.trim()
        return token || undefined
      },
      Effect.scoped,
      Effect.catch(() => Effect.succeed(undefined)),
    )

    const state = yield* InstanceState.make<State>(
      Effect.fn("Vcs.state")(function* (ctx) {
        if (ctx.project.vcs !== "git") {
          return { current: undefined, root: undefined }
        }

        const get = Effect.fnUntraced(function* () {
          return yield* git.branch(ctx.directory)
        })
        const [current, root] = yield* Effect.all([git.branch(ctx.directory), git.defaultBranch(ctx.directory)], {
          concurrency: 2,
        })
        const value = { current, root }
        log.info("initialized", { branch: value.current, default_branch: value.root?.name })

        yield* bus.subscribe(FileWatcher.Event.Updated).pipe(
          Stream.filter((evt) => evt.properties.file.endsWith("HEAD")),
          Stream.runForEach((_evt) =>
            Effect.gen(function* () {
              const next = yield* get()
              if (next !== value.current) {
                log.info("branch changed", { from: value.current, to: next })
                value.current = next
                yield* bus.publish(Event.BranchUpdated, { branch: next })
              }
            }),
          ),
          Effect.forkScoped,
        )

        return value
      }),
    )

    return Service.of({
      init: Effect.fn("Vcs.init")(function* () {
        yield* InstanceState.get(state).pipe(Effect.forkIn(scope))
      }),
      branch: Effect.fn("Vcs.branch")(function* () {
        return yield* InstanceState.use(state, (x) => x.current)
      }),
      defaultBranch: Effect.fn("Vcs.defaultBranch")(function* () {
        return yield* InstanceState.use(state, (x) => x.root?.name)
      }),
      diff: Effect.fn("Vcs.diff")(function* (mode: Mode) {
        const value = yield* InstanceState.get(state)
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") return []
        if (mode === "git") {
          return yield* track(fs, git, ctx.directory, (yield* git.hasHead(ctx.directory)) ? "HEAD" : undefined)
        }

        if (!value.root) return []
        if (value.current && value.current === value.root.name) return []
        const ref = yield* git.mergeBase(ctx.directory, value.root.ref)
        if (!ref) return []
        return yield* compare(fs, git, ctx.directory, ref)
      }),
      pullRequest: Effect.fn("Vcs.pullRequest")(function* () {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") return notGitHub(undefined)

        const [branch, remote] = yield* Effect.all(
          [git.branch(ctx.directory), git.remoteUrl(ctx.directory)],
          { concurrency: 2 },
        )
        if (!branch) return noBranch()

        const repo = parseGitHubRepo(remote)
        if (!repo) return notGitHub(branch)

        const token = yield* resolveGitHubToken()
        const url = new URL(`https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls`)
        url.searchParams.set("state", "all")
        url.searchParams.set("head", `${repo.owner}:${branch}`)
        url.searchParams.set("per_page", "10")

        const headers: Record<string, string> = {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "mimocode",
        }
        if (token) headers.Authorization = `Bearer ${token}`

        const response = yield* HttpClientRequest.get(url.href).pipe(
          HttpClientRequest.setHeaders(headers),
          http.execute,
          Effect.timeout("8 seconds"),
          Effect.catch(() => Effect.succeed(undefined)),
        )
        if (!response) return requestError(Boolean(token))

        const bodyText = yield* response.text.pipe(Effect.catch(() => Effect.succeed("")))
        const body = yield* Effect.sync((): unknown => {
          if (!bodyText) return undefined
          try {
            return JSON.parse(bodyText)
          } catch {
            return undefined
          }
        })

        return mapPullsResponse({
          status: response.status,
          body,
          authenticated: Boolean(token),
          owner: repo.owner,
          repo: repo.repo,
          branch,
        })
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Git.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Bus.layer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
)
