import { Cause, Duration, Effect, Layer, Schedule, Semaphore, Context, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { PreviewBuilder, PreviewLimits, boundPreview, type PreviewSummary } from "./preview"
import path from "path"
import { readLimited } from "@/util/bounded-stream"
import z from "zod"
import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"
import { InstanceState } from "@/effect"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Hash } from "@mimo-ai/shared/util/hash"
import { Config } from "../config"
import { Global } from "../global"
import { Log } from "../util"

export const Patch = z.object({
  hash: z.string(),
  files: z.string().array(),
})
export type Patch = z.infer<typeof Patch>

export { FileDiff, PreviewStats } from "./schema"
import type { FileDiff } from "./schema"

const log = Log.create({ service: "snapshot" })
const prune = "7.days"
const limit = 2 * 1024 * 1024
const core = ["-c", "core.longpaths=true", "-c", "core.symlinks=true"]
const cfg = ["-c", "core.autocrlf=false", ...core]
const quote = [...cfg, "-c", "core.quotepath=false"]
interface GitResult {
  readonly code: ChildProcessSpawner.ExitCode
  readonly text: string
  readonly stderr: string
  readonly bytes?: Uint8Array
}

type State = Omit<Interface, "init">

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly cleanup: () => Effect.Effect<void>
  readonly track: () => Effect.Effect<string | undefined>
  readonly patch: (hash: string) => Effect.Effect<Patch>
  readonly restore: (snapshot: string) => Effect.Effect<void>
  readonly revert: (patches: Patch[]) => Effect.Effect<void>
  readonly diff: (hash: string, options?: { onTruncated?: () => void }) => Effect.Effect<string>
  readonly diffFull: (
    from: string,
    to: string,
    options?: { onSummary?: (summary: PreviewSummary) => void },
  ) => Effect.Effect<FileDiff[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Snapshot") {}

export const layer: Layer.Layer<
  Service,
  never,
  AppFileSystem.Service | ChildProcessSpawner.ChildProcessSpawner | Config.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const config = yield* Config.Service
    const locks = new Map<string, Semaphore.Semaphore>()

    const lock = (key: string) => {
      const hit = locks.get(key)
      if (hit) return hit

      const next = Semaphore.makeUnsafe(1)
      locks.set(key, next)
      return next
    }

    const state = yield* InstanceState.make<State>(
      Effect.fn("Snapshot.state")(function* (ctx) {
        const state = {
          directory: ctx.directory,
          worktree: ctx.worktree,
          gitdir: path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree)),
          vcs: ctx.project.vcs,
        }

        const args = (cmd: string[]) => ["--git-dir", state.gitdir, "--work-tree", state.worktree, ...cmd]

        const enc = new TextEncoder()
        const feed = (list: string[]) => Stream.make(enc.encode(list.join("\0") + "\0"))

        const git = Effect.fnUntraced(
          function* (
            cmd: string[],
            opts?: { cwd?: string; env?: Record<string, string>; stdin?: ChildProcess.CommandInput; maxBytes?: number },
          ) {
            const proc = ChildProcess.make("git", cmd, {
              cwd: opts?.cwd,
              env: opts?.env,
              extendEnv: true,
              stdin: opts?.stdin,
            })
            const handle = yield* spawner.spawn(proc)
            const [output, stderr] = yield* Effect.all(
              [
                opts?.maxBytes === undefined
                  ? Stream.mkString(Stream.decodeText(handle.stdout))
                  : readLimited(handle.stdout, opts.maxBytes),
                readLimited(handle.stderr, 64 * 1024).pipe(Effect.map((bytes) => bytes.toString("utf8"))),
              ],
              { concurrency: 2 },
            )
            const code = yield* handle.exitCode
            return {
              code,
              text: typeof output === "string" ? output : output.toString("utf8"),
              stderr,
              bytes: typeof output === "string" ? undefined : output,
            } satisfies GitResult
          },
          Effect.scoped,
          Effect.catch((err) =>
            Effect.succeed({
              code: ChildProcessSpawner.ExitCode(1),
              text: "",
              stderr: err instanceof Error ? err.message : String(err),
              bytes: undefined,
            }),
          ),
        )

        const ignore = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return new Set<string>()
          const check = yield* git(
            [
              ...quote,
              "--git-dir",
              path.join(state.worktree, ".git"),
              "--work-tree",
              state.worktree,
              "check-ignore",
              "--no-index",
              "--stdin",
              "-z",
            ],
            {
              cwd: state.directory,
              stdin: feed(files),
            },
          )
          if (check.code !== 0 && check.code !== 1) return new Set<string>()
          return new Set(check.text.split("\0").filter(Boolean))
        })

        const drop = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return
          yield* git(
            [
              ...cfg,
              ...args(["rm", "--cached", "-f", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"]),
            ],
            {
              cwd: state.directory,
              stdin: feed(files),
            },
          )
        })

        const stage = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return
          const result = yield* git(
            [...cfg, ...args(["add", "--all", "--sparse", "--pathspec-from-file=-", "--pathspec-file-nul"])],
            {
              cwd: state.directory,
              stdin: feed(files),
            },
          )
          if (result.code === 0) return
          log.warn("failed to add snapshot files", {
            exitCode: result.code,
            stderr: result.stderr,
          })
        })

        const exists = (file: string) => fs.exists(file).pipe(Effect.orDie)
        const read = (file: string) => fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")))
        const remove = (file: string) => fs.remove(file).pipe(Effect.catch(() => Effect.void))
        const locked = <A, E, R>(fx: Effect.Effect<A, E, R>) => lock(state.gitdir).withPermits(1)(fx)

        const enabled = Effect.fnUntraced(function* () {
          if (state.vcs !== "git") return false
          return (yield* config.get()).snapshot !== false
        })

        const excludes = Effect.fnUntraced(function* () {
          const result = yield* git(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], {
            cwd: state.worktree,
          })
          const file = result.text.trim()
          if (!file) return
          if (!(yield* exists(file))) return
          return file
        })

        const sync = Effect.fnUntraced(function* (list: string[] = []) {
          const file = yield* excludes()
          const target = path.join(state.gitdir, "info", "exclude")
          const text = [
            file ? (yield* read(file)).trimEnd() : "",
            ...list.map((item) => `/${item.replaceAll("\\", "/")}`),
          ]
            .filter(Boolean)
            .join("\n")
          yield* fs.ensureDir(path.join(state.gitdir, "info")).pipe(Effect.orDie)
          yield* fs.writeFileString(target, text ? `${text}\n` : "").pipe(Effect.orDie)
        })

        const add = Effect.fnUntraced(function* () {
          yield* sync()
          const [diff, other] = yield* Effect.all(
            [
              git([...quote, ...args(["diff-files", "--name-only", "-z", "--", "."])], {
                cwd: state.directory,
              }),
              git([...quote, ...args(["ls-files", "--others", "--exclude-standard", "-z", "--", "."])], {
                cwd: state.directory,
              }),
            ],
            { concurrency: 2 },
          )
          if (diff.code !== 0 || other.code !== 0) {
            log.warn("failed to list snapshot files", {
              diffCode: diff.code,
              diffStderr: diff.stderr,
              otherCode: other.code,
              otherStderr: other.stderr,
            })
            return
          }

          const tracked = diff.text.split("\0").filter(Boolean)
          const untracked = other.text.split("\0").filter(Boolean)
          const all = Array.from(new Set([...tracked, ...untracked]))
          if (!all.length) return

          // Resolve source-repo ignore rules against the exact candidate set.
          // --no-index keeps this pattern-based even when a path is already tracked.
          const ignored = yield* ignore(all)

          // Remove newly-ignored files from snapshot index to prevent re-adding
          if (ignored.size > 0) {
            const ignoredFiles = Array.from(ignored)
            log.info("removing gitignored files from snapshot", { count: ignoredFiles.length })
            yield* drop(ignoredFiles)
          }

          const allow = all.filter((item) => !ignored.has(item))
          if (!allow.length) return

          const large = new Set(
            (yield* Effect.all(
              allow.map((item) =>
                fs
                  .stat(path.join(state.directory, item))
                  .pipe(Effect.catch(() => Effect.void))
                  .pipe(
                    Effect.map((stat) => {
                      if (!stat || stat.type !== "File") return
                      const size = typeof stat.size === "bigint" ? Number(stat.size) : stat.size
                      return size > limit ? item : undefined
                    }),
                  ),
              ),
              { concurrency: 8 },
            )).filter((item): item is string => Boolean(item)),
          )
          const block = new Set(untracked.filter((item) => large.has(item)))
          yield* sync(Array.from(block))
          // Stage only the allowed candidate paths so snapshot updates stay scoped.
          yield* stage(allow.filter((item) => !block.has(item)))
        })

        const cleanup = Effect.fnUntraced(function* () {
          return yield* locked(
            Effect.gen(function* () {
              if (!(yield* enabled())) return
              if (!(yield* exists(state.gitdir))) return
              const result = yield* git(args(["gc", `--prune=${prune}`]), { cwd: state.directory })
              if (result.code !== 0) {
                log.warn("cleanup failed", {
                  exitCode: result.code,
                  stderr: result.stderr,
                })
                return
              }
              log.info("cleanup", { prune })
            }),
          )
        })

        const track = Effect.fnUntraced(function* () {
          return yield* locked(
            Effect.gen(function* () {
              if (!(yield* enabled())) return
              const existed = yield* exists(state.gitdir)
              yield* fs.ensureDir(state.gitdir).pipe(Effect.orDie)
              if (!existed) {
                yield* git(["init"], {
                  env: { GIT_DIR: state.gitdir, GIT_WORK_TREE: state.worktree },
                })
                yield* git(["--git-dir", state.gitdir, "config", "core.autocrlf", "false"])
                yield* git(["--git-dir", state.gitdir, "config", "core.longpaths", "true"])
                yield* git(["--git-dir", state.gitdir, "config", "core.symlinks", "true"])
                yield* git(["--git-dir", state.gitdir, "config", "core.fsmonitor", "false"])
                log.info("initialized")
              }
              yield* add()
              const result = yield* git(args(["write-tree"]), { cwd: state.directory })
              const hash = result.text.trim()
              log.info("tracking", { hash, cwd: state.directory, git: state.gitdir })
              return hash
            }),
          )
        })

        const patch = Effect.fnUntraced(function* (hash: string) {
          return yield* locked(
            Effect.gen(function* () {
              yield* add()
              const result = yield* git(
                [...quote, ...args(["diff", "--cached", "--no-ext-diff", "--name-only", hash, "--", "."])],
                {
                  cwd: state.directory,
                },
              )
              if (result.code !== 0) {
                log.warn("failed to get diff", { hash, exitCode: result.code })
                return { hash, files: [] }
              }
              const files = result.text
                .trim()
                .split("\n")
                .map((x) => x.trim())
                .filter(Boolean)

              // Hide ignored-file removals from the user-facing patch output.
              const ignored = yield* ignore(files)

              return {
                hash,
                files: files
                  .filter((item) => !ignored.has(item))
                  .map((x) => path.join(state.worktree, x).replaceAll("\\", "/")),
              }
            }),
          )
        })

        const restore = Effect.fnUntraced(function* (snapshot: string) {
          return yield* locked(
            Effect.gen(function* () {
              log.info("restore", { commit: snapshot })
              const result = yield* git([...core, ...args(["read-tree", snapshot])], { cwd: state.worktree })
              if (result.code === 0) {
                const checkout = yield* git([...core, ...args(["checkout-index", "-a", "-f"])], {
                  cwd: state.worktree,
                })
                if (checkout.code === 0) return
                log.error("failed to restore snapshot", {
                  snapshot,
                  exitCode: checkout.code,
                  stderr: checkout.stderr,
                })
                return
              }
              log.error("failed to restore snapshot", {
                snapshot,
                exitCode: result.code,
                stderr: result.stderr,
              })
            }),
          )
        })

        const revert = Effect.fnUntraced(function* (patches: Patch[]) {
          return yield* locked(
            Effect.gen(function* () {
              const ops: { hash: string; file: string; rel: string }[] = []
              const seen = new Set<string>()
              for (const item of patches) {
                for (const file of item.files) {
                  if (seen.has(file)) continue
                  seen.add(file)
                  ops.push({
                    hash: item.hash,
                    file,
                    rel: path.relative(state.worktree, file).replaceAll("\\", "/"),
                  })
                }
              }

              const single = Effect.fnUntraced(function* (op: (typeof ops)[number]) {
                log.info("reverting", { file: op.file, hash: op.hash })
                const result = yield* git([...core, ...args(["checkout", op.hash, "--", op.file])], {
                  cwd: state.worktree,
                })
                if (result.code === 0) return
                const tree = yield* git([...core, ...args(["ls-tree", op.hash, "--", op.rel])], {
                  cwd: state.worktree,
                })
                if (tree.code === 0 && tree.text.trim()) {
                  log.info("file existed in snapshot but checkout failed, keeping", { file: op.file, hash: op.hash })
                  return
                }
                log.info("file did not exist in snapshot, deleting", { file: op.file, hash: op.hash })
                yield* remove(op.file)
              })

              const clash = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)

              for (let i = 0; i < ops.length; ) {
                const first = ops[i]!
                const run = [first]
                let j = i + 1
                // Only batch adjacent files when their paths cannot affect each other.
                while (j < ops.length && run.length < 100) {
                  const next = ops[j]!
                  if (next.hash !== first.hash) break
                  if (run.some((item) => clash(item.rel, next.rel))) break
                  run.push(next)
                  j += 1
                }

                if (run.length === 1) {
                  yield* single(first)
                  i = j
                  continue
                }

                const tree = yield* git(
                  [...core, ...args(["ls-tree", "--name-only", first.hash, "--", ...run.map((item) => item.rel)])],
                  {
                    cwd: state.worktree,
                  },
                )

                if (tree.code !== 0) {
                  log.info("batched ls-tree failed, falling back to single-file revert", {
                    hash: first.hash,
                    files: run.length,
                  })
                  for (const op of run) {
                    yield* single(op)
                  }
                  i = j
                  continue
                }

                const have = new Set(
                  tree.text
                    .trim()
                    .split("\n")
                    .map((item) => item.trim())
                    .filter(Boolean),
                )
                const list = run.filter((item) => have.has(item.rel))
                if (list.length) {
                  log.info("reverting", { hash: first.hash, files: list.length })
                  const result = yield* git(
                    [...core, ...args(["checkout", first.hash, "--", ...list.map((item) => item.file)])],
                    {
                      cwd: state.worktree,
                    },
                  )
                  if (result.code !== 0) {
                    log.info("batched checkout failed, falling back to single-file revert", {
                      hash: first.hash,
                      files: list.length,
                    })
                    for (const op of run) {
                      yield* single(op)
                    }
                    i = j
                    continue
                  }
                }

                for (const op of run) {
                  if (have.has(op.rel)) continue
                  log.info("file did not exist in snapshot, deleting", { file: op.file, hash: op.hash })
                  yield* remove(op.file)
                }

                i = j
              }
            }),
          )
        })

        const diff = Effect.fnUntraced(function* (hash: string, options?: { onTruncated?: () => void }) {
          const to = yield* track()
          if (!to) return ""
          const diffs = yield* diffFull(hash, to, {
            onSummary: (summary) => {
              if (summary.omittedFiles || summary.omittedPatches) options?.onTruncated?.()
            },
          })
          return diffs
            .map((item) => item.patch)
            .filter(Boolean)
            .join("\n")
        })

        const diffFull = Effect.fnUntraced(function* (
          from: string,
          to: string,
          options?: { onSummary?: (summary: PreviewSummary) => void },
        ) {
          return yield* locked(
            Effect.gen(function* () {
              type Row = { file: string; additions: number; deletions: number; binary: boolean }
              const builder = new PreviewBuilder()
              const rows: Row[] = []
              const binary = new Set<string>()
              const consume = Effect.fnUntraced(function* () {
                const ignored = yield* ignore(rows.map((row) => row.file))
                for (const row of rows) {
                  if (ignored.has(row.file)) continue
                  const item = builder.add({
                    file: row.file,
                    additions: row.additions,
                    deletions: row.deletions,
                    patch: "",
                  })
                  if (item && row.binary) binary.add(row.file)
                }
                rows.length = 0
              })
              // Git metadata is streamed; only the next ignore-check batch and
              // the selected preview rows stay resident, even for huge trees.
              const records = (cmd: string[], consume: (record: string) => Effect.Effect<void>) =>
                Effect.scoped(
                  Effect.gen(function* () {
                    const proc = yield* spawner.spawn(
                      ChildProcess.make("git", [...quote, ...args(cmd)], { cwd: state.directory, extendEnv: true }),
                    )
                    let pending = ""
                    yield* Effect.all(
                      [
                        Stream.runForEach(Stream.decodeText(proc.stdout), (chunk) =>
                          Effect.gen(function* () {
                            pending += chunk
                            let end: number
                            while ((end = pending.indexOf("\0")) >= 0) {
                              const record = pending.slice(0, end)
                              pending = pending.slice(end + 1)
                              yield* consume(record)
                            }
                            if (Buffer.byteLength(pending) > PreviewLimits.source)
                              yield* Effect.die(new Error("Oversized git metadata record"))
                          }),
                        ),
                        readLimited(proc.stderr, 64 * 1024),
                      ],
                      { concurrency: 2 },
                    )
                    const code = yield* proc.exitCode
                    if (code !== 0 || pending) yield* Effect.die(new Error("Incomplete snapshot diff metadata"))
                  }),
                ).pipe(Effect.orDie)
              yield* records(
                ["diff", "--no-ext-diff", "--no-renames", "--numstat", "-z", from, to, "--", "."],
                (record) =>
                  Effect.gen(function* () {
                    const first = record.indexOf("\t")
                    const second = record.indexOf("\t", first + 1)
                    if (first < 0 || second < 0) return
                    const adds = record.slice(0, first)
                    const dels = record.slice(first + 1, second)
                    rows.push({
                      file: record.slice(second + 1),
                      binary: adds === "-" && dels === "-",
                      additions: Number.parseInt(adds) || 0,
                      deletions: Number.parseInt(dels) || 0,
                    })
                    if (rows.length >= 512) yield* consume()
                  }),
              )
              yield* consume()
              const selected = new Map(builder.value.diffs.map((item) => [item.file, item]))
              const refs = new Map<string, { before?: string; after?: string }>()
              let head = ""
              yield* records(
                ["diff", "--no-ext-diff", "--no-renames", "--raw", "--no-abbrev", "-z", from, to, "--", "."],
                (record) =>
                  Effect.sync(() => {
                    if (!head) {
                      head = record
                      return
                    }
                    const fields = head.split(" ")
                    head = ""
                    const item = selected.get(record)
                    if (!item) return
                    const code = fields[4]
                    item.status = code === "A" ? "added" : code === "D" ? "deleted" : "modified"
                    refs.set(record, {
                      before: /^0+$/.test(fields[2]) ? undefined : fields[2],
                      after: /^0+$/.test(fields[3]) ? undefined : fields[3],
                    })
                  }),
              )
              const hashes = [
                ...new Set(
                  [...refs.values()].flatMap((ref) =>
                    [ref.before, ref.after].filter((value): value is string => !!value),
                  ),
                ),
              ]
              const sizes = new Map<string, number>()
              if (hashes.length) {
                const check = yield* git([...cfg, ...args(["cat-file", "--batch-check", "-z"])], {
                  cwd: state.directory,
                  stdin: feed(hashes),
                  maxBytes: PreviewLimits.batch,
                })
                if (check.code === 0)
                  for (const line of check.text.split("\n")) {
                    const match = line.match(/^([0-9a-f]+) blob (\d+)$/)
                    if (match) sizes.set(match[1], Number(match[2]))
                  }
              }
              const size = (hash?: string) => (hash ? (sizes.get(hash) ?? Infinity) : 0)
              const items = builder.value.diffs
              for (let i = 0; i < items.length; ) {
                const batch: typeof items = []
                let bytes = 0
                while (i < items.length && batch.length < 100) {
                  const item = items[i]
                  const ref = refs.get(item.file)
                  if (binary.has(item.file)) {
                    i++
                    continue
                  }
                  if (!ref || size(ref.before) > PreviewLimits.source || size(ref.after) > PreviewLimits.source) {
                    builder.patch(item)
                    i++
                    continue
                  }
                  const next = size(ref.before) + size(ref.after)
                  if (batch.length && bytes + next > PreviewLimits.batch) break
                  batch.push(item)
                  bytes += next
                  i++
                }
                if (!batch.length) continue
                const requested = batch.flatMap((item) => {
                  const ref = refs.get(item.file)!
                  return [ref.before, ref.after].filter((value): value is string => !!value)
                })
                const loaded = new Map<string, string>()
                let valid = true
                if (requested.length) {
                  const result = yield* git([...cfg, ...args(["cat-file", "--batch", "-z"])], {
                    cwd: state.directory,
                    stdin: feed(requested),
                    maxBytes: PreviewLimits.batch + 32 * 1024,
                  })
                  const out = Buffer.from(result.bytes ?? Buffer.from(result.text))
                  let offset = 0
                  if (result.code !== 0) valid = false
                  for (const hash of requested) {
                    const end = out.indexOf(10, offset)
                    const match =
                      end < 0
                        ? undefined
                        : out
                            .subarray(offset, end)
                            .toString()
                            .match(/^[0-9a-f]+ blob (\d+)$/)
                    if (!match) {
                      valid = false
                      break
                    }
                    const length = Number(match[1])
                    offset = end + 1
                    if (length > PreviewLimits.source || offset + length >= out.length || out[offset + length] !== 10) {
                      valid = false
                      break
                    }
                    loaded.set(hash, out.subarray(offset, offset + length).toString("utf8"))
                    offset += length + 1
                  }
                }
                for (const item of batch) {
                  const ref = refs.get(item.file)!
                  const read = (hash?: string) =>
                    !hash
                      ? Effect.succeed("")
                      : valid
                        ? Effect.succeed(loaded.get(hash))
                        : git([...cfg, ...args(["show", hash])], {
                            cwd: state.directory,
                            maxBytes: PreviewLimits.source,
                          }).pipe(Effect.map((result) => (result.code === 0 ? result.text : undefined)))
                  const before = yield* read(ref.before)
                  const after = yield* read(ref.after)
                  builder.patch(item, before, after)
                }
              }
              const preview = boundPreview(builder.value.diffs, builder.value.summary)
              options?.onSummary?.(preview.summary)
              return preview.diffs
            }),
          )
        })

        yield* cleanup().pipe(
          Effect.catchCause((cause) => {
            log.error("cleanup loop failed", { cause: Cause.pretty(cause) })
            return Effect.void
          }),
          Effect.repeat(Schedule.spaced(Duration.hours(1))),
          Effect.delay(Duration.minutes(1)),
          Effect.forkScoped,
        )

        return { cleanup, track, patch, restore, revert, diff, diffFull }
      }),
    )

    return Service.of({
      init: Effect.fn("Snapshot.init")(function* () {
        yield* InstanceState.get(state)
      }),
      cleanup: Effect.fn("Snapshot.cleanup")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.cleanup())
      }),
      track: Effect.fn("Snapshot.track")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.track())
      }),
      patch: Effect.fn("Snapshot.patch")(function* (hash: string) {
        return yield* InstanceState.useEffect(state, (s) => s.patch(hash))
      }),
      restore: Effect.fn("Snapshot.restore")(function* (snapshot: string) {
        return yield* InstanceState.useEffect(state, (s) => s.restore(snapshot))
      }),
      revert: Effect.fn("Snapshot.revert")(function* (patches: Patch[]) {
        return yield* InstanceState.useEffect(state, (s) => s.revert(patches))
      }),
      diff: Effect.fn("Snapshot.diff")(function* (hash: string, options?: { onTruncated?: () => void }) {
        return yield* InstanceState.useEffect(state, (s) => s.diff(hash, options))
      }),
      diffFull: Effect.fn("Snapshot.diffFull")(function* (
        from: string,
        to: string,
        options?: { onSummary?: (summary: PreviewSummary) => void },
      ) {
        return yield* InstanceState.useEffect(state, (s) => s.diffFull(from, to, options))
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(CrossSpawnSpawner.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Config.defaultLayer),
)

export * as Snapshot from "."
