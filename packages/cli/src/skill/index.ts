import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import z from "zod"
import fs from "fs/promises"
import { Deferred, Duration, Effect, Exit, Layer, Context, Option } from "effect"
import { NamedError } from "@mimo-ai/shared/util/error"
import type { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect"
import { Flag } from "@/flag/flag"
import { Global } from "@/global"
import { Permission } from "@/permission"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Config } from "../config"
import { ConfigMarkdown } from "../config"
import { Glob } from "@mimo-ai/shared/util/glob"
import { Log } from "../util"
import { Discovery } from "./discovery"
import { extractBuiltinBundle, OFFICIAL_SKILL_NAMES } from "./builtin/extract"

const log = Log.create({ service: "skill" })
// Scan order is load order: later roots win same-name collisions against earlier
// non-bundled skills. Open-standard .agents sits last among brand roots;
// .mimocode config dirs load after these.
const EXTERNAL_DIRS = [".claude", ".codex", ".opencode", ".agents"]
const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
const MIMOCODE_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
const SKILL_PATTERN = "**/SKILL.md"
const BUILTIN_SKILL_PATTERN = "skills/*/SKILL.md"

// Brand roots opt in via MIMOCODE_ENABLE_*_SKILLS; .agents stays on unless
// MIMOCODE_DISABLE_AGENTS_SKILLS is set.
const externalSkillDirs = () =>
  EXTERNAL_DIRS.filter((dir) => {
    if (dir === ".agents") return !Flag.MIMOCODE_DISABLE_AGENTS_SKILLS
    if (dir === ".claude") return Flag.MIMOCODE_ENABLE_CLAUDE_CODE_SKILLS
    if (dir === ".codex") return Flag.MIMOCODE_ENABLE_CODEX_SKILLS
    if (dir === ".opencode") return Flag.MIMOCODE_ENABLE_OPENCODE_SKILLS
    return true
  })

export const Info = z.object({
  name: z.string(),
  description: z.string(),
  aliases: z.array(z.string()).optional(),
  location: z.string(),
  content: z.string(),
  // Model reachability, distinct from authorization. When true the model never
  // sees the skill (no system-prompt catalog entry, no skill tool description
  // entry, no skill_search hit) and the skill tool refuses to load it; a user
  // slash invocation still works. Authorization stays with permission.skill,
  // where `deny` means unusable by anyone.
  disable_model_invocation: z.boolean().optional(),
  bundled: z.boolean().optional(),
})
export type Info = z.infer<typeof Info>

// Kebab-case in frontmatter to match Claude Code and the agentskills.io open
// standard, so a skill folder stays portable in both directions.
const Frontmatter = Info.pick({ name: true, description: true, aliases: true }).extend({
  "disable-model-invocation": z.boolean().optional(),
})

export const InvalidError = NamedError.create(
  "SkillInvalidError",
  z.object({
    path: z.string(),
    message: z.string().optional(),
    issues: z.custom<z.core.$ZodIssue[]>().optional(),
  }),
)

export const NameMismatchError = NamedError.create(
  "SkillNameMismatchError",
  z.object({
    path: z.string(),
    expected: z.string(),
    actual: z.string(),
  }),
)

type ParseEntry = {
  mtimeMs: number
  size: number
  md?: { data: Record<string, unknown>; content: string }
}

type Snapshot = {
  skills: Record<string, Info>
  dirs: string[]
  // Identity of the inputs (ordered SKILL.md paths with stat signatures). An
  // equal key means the rebuilt snapshot would be identical, so it is kept.
  key: string
}

type DirectoryState = {
  current: Snapshot
  flight?: Deferred.Deferred<void>
}

type Discovered = {
  matches: string[]
  bundledRoots: string[]
}

type ScanState = {
  matches: Set<string>
}

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly all: () => Effect.Effect<Info[]>
  readonly dirs: () => Effect.Effect<string[]>
  readonly available: (agent?: Agent.Info) => Effect.Effect<Info[]>
  readonly modelInvocable: (agent?: Agent.Info) => Effect.Effect<Info[]>
  /** Rescan the current directory's roots; unchanged SKILL.md files are not reparsed. */
  readonly refresh: () => Effect.Effect<void>
  /** Like refresh, but also re-extracts builtin skills and re-pulls `skills.urls`. */
  readonly reload: () => Effect.Effect<void>
}

const scan = Effect.fnUntraced(function* (
  state: ScanState,
  root: string,
  pattern: string,
  opts?: { dot?: boolean; scope?: string },
) {
  const matches = yield* Effect.tryPromise({
    try: () =>
      Glob.scan(pattern, {
        cwd: root,
        absolute: true,
        include: "file",
        symlink: true,
        dot: opts?.dot,
      }),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) => {
      if (!opts?.scope) return Effect.die(error)
      log.error(`failed to scan ${opts.scope} skills`, { dir: root, error })
      return Effect.succeed([] as string[])
    }),
  )

  for (const match of matches.toSorted()) state.matches.add(match)
})

export class Service extends Context.Service<Service, Interface>()("@opencode/Skill") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* Discovery.Service
    const config = yield* Config.Service
    const bus = yield* Bus.Service
    const fsys = yield* AppFileSystem.Service

    // Process-wide one-offs: builtin extraction and remote pulls never run on a
    // turn's critical path after the first time. `reload` resets them.
    const [cachedBuiltinRoot, invalidateBuiltinRoot] = yield* Effect.cachedInvalidateWithTTL(
      extractBuiltinBundle(fsys).pipe(Effect.catch(() => Effect.succeed(undefined))),
      Duration.infinity,
    )
    // A cancelled first extraction must not become the process-wide answer.
    const builtinRoot = cachedBuiltinRoot.pipe(Effect.onInterrupt(() => invalidateBuiltinRoot))
    const pulled = new Map<string, string[]>()
    const parsed = new Map<string, ParseEntry>()

    const discover = Effect.fnUntraced(function* (directory: string, worktree: string) {
      const state: ScanState = { matches: new Set() }
      const bundledRoots: string[] = []

      if (!Flag.MIMOCODE_DISABLE_BUILTIN_SKILLS) {
        const root = yield* builtinRoot
        if (root && (yield* fsys.isDir(root))) {
          bundledRoots.push(root)
          yield* scan(state, root, BUILTIN_SKILL_PATTERN, { scope: "builtin" })
          if (Flag.MIMOCODE_DISABLE_OFFICIAL_SKILLS) {
            const skillsRoot = path.join(root, "skills")
            for (const name of OFFICIAL_SKILL_NAMES) {
              const prefix = path.join(skillsRoot, name) + path.sep
              for (const match of state.matches) {
                if (match.startsWith(prefix)) state.matches.delete(match)
              }
            }
          }
        }
      }

      // Dotted path segments under skills/ are host-private (e.g. Codex .system)
      // and must not match.
      for (const dir of externalSkillDirs()) {
        const root = path.join(Global.Path.home, dir)
        if (!(yield* fsys.isDir(root))) continue
        yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { scope: "global" })
      }

      const upDirs = yield* fsys
        .up({ targets: externalSkillDirs(), start: directory, stop: worktree })
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      for (const root of upDirs) {
        yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { scope: "project" })
      }

      for (const dir of yield* config.directories()) {
        yield* scan(state, dir, MIMOCODE_SKILL_PATTERN)
      }

      const cfg = yield* config.get()
      for (const item of cfg.skills?.paths ?? []) {
        const expanded = item.startsWith("~/") ? path.join(os.homedir(), item.slice(2)) : item
        const dir = path.isAbsolute(expanded) ? expanded : path.join(directory, expanded)
        if (!(yield* fsys.isDir(dir))) {
          log.warn("skill path not found", { path: dir })
          continue
        }
        yield* scan(state, dir, SKILL_PATTERN)
      }

      for (const url of cfg.skills?.urls ?? []) {
        let dirs = pulled.get(url)
        if (!dirs) {
          dirs = yield* discovery.pull(url)
          pulled.set(url, dirs)
        }
        for (const dir of dirs) {
          yield* scan(state, dir, SKILL_PATTERN)
        }
      }

      return { matches: Array.from(state.matches), bundledRoots } satisfies Discovered
    })

    // Parse through a (path, mtime, size) cache. A failed parse is cached too,
    // so a broken SKILL.md reports its error once per file version, not once
    // per refresh.
    const parse = Effect.fnUntraced(function* (match: string) {
      const stat = yield* Effect.tryPromise(() => fs.stat(match)).pipe(Effect.option)
      if (Option.isNone(stat)) {
        parsed.delete(match)
        return undefined
      }
      const { mtimeMs, size } = stat.value
      const hit = parsed.get(match)
      if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit
      const md = yield* Effect.tryPromise({
        try: () => ConfigMarkdown.parse(match),
        catch: (err) => err,
      }).pipe(
        Effect.map((value) => ({ data: value.data as Record<string, unknown>, content: value.content })),
        Effect.catch(
          Effect.fnUntraced(function* (err) {
            const message = ConfigMarkdown.FrontmatterError.isInstance(err)
              ? err.data.message
              : `Failed to parse skill ${match}`
            const { Session } = yield* Effect.promise(() => import("@/session"))
            yield* bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
            log.error("failed to load skill", { skill: match, err })
            return undefined
          }),
        ),
      )
      const entry: ParseEntry = { mtimeMs, size, md }
      parsed.set(match, entry)
      return entry
    })

    const build = Effect.fnUntraced(function* (discovered: Discovered, previous?: Snapshot) {
      const entries = yield* Effect.forEach(discovered.matches, (match) => parse(match), { concurrency: 8 })
      const key = JSON.stringify([
        discovered.bundledRoots,
        discovered.matches.map((match, index) => {
          const entry = entries[index]
          return entry ? [match, entry.mtimeMs, entry.size] : [match]
        }),
      ])
      if (previous && previous.key === key) return previous

      const skills: Record<string, Info> = {}
      const dirs = new Set<string>()
      discovered.matches.forEach((match, index) => {
        const entry = entries[index]
        if (!entry) return
        dirs.add(path.dirname(match))
        if (!entry.md) return
        const frontmatter = Frontmatter.safeParse(entry.md.data)
        if (!frontmatter.success) return

        const isBundled = discovered.bundledRoots.some((root) => match.startsWith(root))
        const existing = skills[frontmatter.data.name]
        if (existing) {
          // User overrides always win: bundled must not overwrite non-bundled
          if (isBundled && !existing.bundled) return
          if (!isBundled && existing.bundled) {
            log.info("user skill overrides bundled", { name: frontmatter.data.name, location: match })
          } else {
            log.warn("duplicate skill name", {
              name: frontmatter.data.name,
              existing: existing.location,
              duplicate: match,
            })
          }
        }

        skills[frontmatter.data.name] = {
          name: frontmatter.data.name,
          description: frontmatter.data.description,
          aliases: frontmatter.data.aliases,
          location: match,
          content: entry.md.content,
          disable_model_invocation: frontmatter.data["disable-model-invocation"],
          bundled: isBundled || undefined,
        }
      })

      log.info("init", { count: Object.keys(skills).length })
      return { skills, dirs: Array.from(dirs), key } satisfies Snapshot
    })

    const state = yield* InstanceState.make(
      Effect.fn("Skill.state")(function* (ctx) {
        const current = yield* build(yield* discover(ctx.directory, ctx.worktree))
        return { current } satisfies DirectoryState as DirectoryState
      }),
    )

    // Single-flight per directory: a refresh that starts while another is
    // running joins it instead of scanning twice.
    const refresh = Effect.fn("Skill.refresh")(function* () {
      const s = yield* InstanceState.get(state)
      if (s.flight) {
        yield* Deferred.await(s.flight).pipe(Effect.exit)
        return
      }
      const flight = yield* Deferred.make<void>()
      s.flight = flight
      const ctx = yield* InstanceState.context
      yield* Effect.gen(function* () {
        s.current = yield* build(yield* discover(ctx.directory, ctx.worktree), s.current)
      }).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (s.flight === flight) s.flight = undefined
          }).pipe(Effect.andThen(Deferred.done(flight, Exit.asVoid(exit)))),
        ),
      )
    })

    const snapshot = Effect.fnUntraced(function* () {
      return (yield* InstanceState.get(state)).current
    })

    const get = Effect.fn("Skill.get")(function* (name: string) {
      return (yield* snapshot()).skills[name]
    })

    const all = Effect.fn("Skill.all")(function* () {
      return Object.values((yield* snapshot()).skills)
    })

    const dirs = Effect.fn("Skill.dirs")(function* () {
      return (yield* snapshot()).dirs
    })

    // Authorization only: `deny` means unusable by anyone, so this is also the
    // set a user slash invocation resolves against.
    const available = Effect.fn("Skill.available")(function* (agent?: Agent.Info) {
      const list = Object.values((yield* snapshot()).skills).toSorted((a, b) => a.name.localeCompare(b.name))
      if (!agent) return list
      return list.filter((skill) => Permission.evaluate("skill", skill.name, agent.permission).action !== "deny")
    })

    // Everything the model is allowed to see or act on. Anything the model can
    // reach must come from here, never from `available` or `all`.
    const modelInvocable = Effect.fn("Skill.modelInvocable")(function* (agent?: Agent.Info) {
      return (yield* available(agent)).filter((skill) => !skill.disable_model_invocation)
    })

    const reload = Effect.fn("Skill.reload")(function* () {
      yield* invalidateBuiltinRoot
      pulled.clear()
      parsed.clear()
      yield* refresh()
    })

    return Service.of({ get, all, dirs, available, modelInvocable, refresh, reload })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Discovery.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Bus.layer),
  Layer.provide(AppFileSystem.defaultLayer),
)

export function fmt(list: Pick<Info, "name" | "description" | "location">[], opts: { verbose: boolean }) {
  if (list.length === 0) return "No skills are currently available."
  if (opts.verbose) {
    return [
      "<available_skills>",
      ...list
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .flatMap((skill) => [
          "  <skill>",
          `    <name>${skill.name}</name>`,
          `    <description>${skill.description}</description>`,
          `    <location>${pathToFileURL(skill.location).href}</location>`,
          "  </skill>",
        ]),
      "</available_skills>",
    ].join("\n")
  }

  return [
    "## Available Skills",
    ...list
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((skill) => `- **${skill.name}**: ${skill.description}`),
  ].join("\n")
}

export * as Skill from "."
