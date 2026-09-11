import * as path from "path"
import { readFileSync, realpathSync } from "node:fs"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Global } from "../global"

/**
 * Cross-branch git guard for ISOLATED CHILD sessions.
 *
 * An isolated child (`session create --isolate`) runs in an app-managed git
 * worktree under `<data>/worktree/<projectID>/<name>`. Every worktree of a
 * repository shares ONE ref store (`--git-common-dir`), so a git command run
 * from inside the child's worktree can write refs that other checkouts depend
 * on.
 *
 * WHAT ACTUALLY REACHES ACROSS — measured, not assumed (git 2.50.1, a repo with
 * `main` checked out in the parent and a linked worktree on `feature`):
 *
 *   git update-ref refs/heads/main HEAD   → SUCCEEDS, moves main, no warning
 *   git symbolic-ref                      → same class: writes a shared ref
 *   git tag -f v1 HEAD                     → SUCCEEDS: `Updated tag 'v1'`
 *   git branch -f <branch-not-checked-out> → SUCCEEDS
 *   git push                               → writes the REMOTE; irreversible
 *   git worktree <sub>                     → mutates the shared registry
 *
 * WHAT GIT ALREADY REFUSES, so this module is only a second line there:
 *
 *   git checkout main   → fatal: 'main' is already used by worktree at …
 *   git branch -f main  → fatal: cannot force update the branch 'main' used by …
 *
 * AND ONE THING THAT IS NOT A HAZARD AT ALL:
 *
 *   git rebase main     → rebases the CURRENT branch onto main. It does not
 *                         move main. An earlier version of this comment listed
 *                         it (and the two git already refuses) as the
 *                         justification; that was wrong. `rebase` stays gated
 *                         because `git rebase <upstream> <branch>` takes a
 *                         branch argument and rewrites THAT ref — the bare
 *                         `git rebase main` form is not what the gate is for.
 *
 * The orchestrator prompt already tells children not to do this; this module
 * makes it a mechanism instead of a suggestion. It only fires for isolated
 * children — the orchestrator and ordinary sessions legitimately integrate
 * branches and are never gated here.
 *
 * SCOPE / HONEST LIMITS
 * - This is a string/argv-level check over the already-parsed command AST. A
 *   determined command can evade it (shell aliases, `sh -c "$(printf …)"`,
 *   `eval`, a wrapper script, a git alias configured in the repo). It is not a
 *   sandbox and does not try to be one. The target is the ACCIDENTAL
 *   HEAD-moving mistake that actually occurs in practice.
 * - `git reset` is deliberately NOT gated: it can only move the CURRENT
 *   worktree's own branch, so it cannot corrupt another checkout's HEAD. Its
 *   destructive `--hard` form is already behind the forced-ask `bash_delete`
 *   prompt in bash.ts.
 * - `git pull` is deliberately NOT gated for the same reason: it only
 *   fast-forwards/merges INTO the child's own branch and never writes another
 *   branch's ref.
 */

/** git global options that consume the FOLLOWING token as their value. */
const GLOBAL_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
  "--super-prefix",
])

/** Flags that make `rebase`/`merge` operate on an ALREADY IN-PROGRESS operation
 *  in this worktree only. Those are recovery actions, always allowed. */
const IN_PROGRESS = new Set([
  "--abort",
  "--continue",
  "--skip",
  "--quit",
  "--edit-todo",
  "--show-current-patch",
])

/** `git branch` flags that delete, force-move or rename a ref. */
const BRANCH_MUTATE = new Set(["-d", "-D", "--delete", "-f", "--force", "-m", "-M", "--move"])

/** `git worktree` subcommands that write the shared worktree registry. */
const WORKTREE_MUTATE = new Set(["add", "remove", "move", "prune", "repair", "lock", "unlock"])

export type Violation = {
  /** The single command that was rejected, as written. */
  command: string
  /** Short human reason, e.g. "git rebase rewrites shared refs". */
  reason: string
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  if ((first === '"' || first === "'") && first === text[text.length - 1]) return text.slice(1, -1)
  return text
}

/**
 * Splits a git argv into `{ sub, args }`, skipping git's global options so
 * `git --no-pager -C /elsewhere rebase main` is still seen as `rebase`.
 * Returns undefined when the command is not git or has no subcommand.
 */
export function gitInvocation(tokens: string[]): { sub: string; args: string[] } | undefined {
  const argv = tokens.map(unquote).filter((tok) => tok.length > 0)
  if (argv.length < 2) return
  const head = path.basename(argv[0]).toLowerCase()
  if (head !== "git" && head !== "git.exe") return
  let i = 1
  while (i < argv.length) {
    const tok = argv[i]
    if (!tok.startsWith("-")) break
    if (GLOBAL_WITH_VALUE.has(tok)) {
      i += 2
      continue
    }
    i += 1
  }
  if (i >= argv.length) return
  return { sub: argv[i], args: argv.slice(i + 1) }
}

/** Positional (non-flag) arguments. A bare `-` is positional: `git checkout -`
 *  switches to the previous branch. */
function positionals(args: string[]) {
  return args.filter((arg) => arg === "-" || !arg.startsWith("-"))
}

function valueOf(args: string[], flags: Set<string>) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    for (const flag of flags) {
      if (arg === flag) return args[i + 1]
      if (arg.startsWith(flag + "=")) return arg.slice(flag.length + 1)
    }
  }
}

/** Normalizes a push refspec to the branch name it WRITES on the remote. */
function pushTarget(refspec: string) {
  const spec = refspec.startsWith("+") ? refspec.slice(1) : refspec
  const colon = spec.lastIndexOf(":")
  const dst = colon === -1 ? spec : spec.slice(colon + 1)
  return dst.replace(/^refs\/heads\//, "")
}

/**
 * Decides whether a single git invocation crosses the isolated child's branch
 * boundary. Pure: `isPath` is injected so the caller owns filesystem access.
 * `branch` is the child's own branch (undefined when it could not be read —
 * ownership-sensitive rules then fail closed, which is safe because those forms
 * are destructive and a child never needs them).
 */
export function violates(input: {
  tokens: string[]
  branch?: string
  isPath?: (arg: string) => boolean
}): string | undefined {
  const git = gitInvocation(input.tokens)
  if (!git) return
  const { sub, args } = git
  const branch = input.branch
  const isPath = input.isPath ?? (() => false)
  const owns = (name: string) => Boolean(branch) && (name === branch || name === "HEAD")

  switch (sub) {
    case "rebase": {
      if (args.some((arg) => IN_PROGRESS.has(arg))) return
      return "`git rebase` rewrites history against another branch and writes the shared ref store"
    }
    case "merge": {
      if (args.some((arg) => IN_PROGRESS.has(arg))) return
      return "`git merge` integrates another branch — integration is the orchestrator's job"
    }
    case "checkout":
    case "switch": {
      // With `--`, or with 2+ positionals, git restores FILES from a tree-ish
      // and never moves HEAD. Always allowed.
      if (args.includes("--")) return
      const pos = positionals(args)
      if (pos.length !== 1) {
        if (args.includes("--detach")) return "`--detach` moves this worktree's HEAD off its own branch"
        return
      }
      // Creating a brand-new branch is the child's own ref: allowed.
      const created = valueOf(args, new Set(["-b", "-c", "--orphan"]))
      if (created !== undefined) return
      // `-B`/`-C` force-create, which RESETS an existing branch — only safe on its own.
      const forced = valueOf(args, new Set(["-B", "-C"]))
      if (forced !== undefined) {
        if (owns(forced)) return
        return `\`git ${sub}\` force-creating '${forced}' resets a branch this session does not own`
      }
      const target = pos[0]
      if (isPath(target)) return
      if (owns(target)) return
      return `switching this worktree to '${target}' moves a ref/HEAD in the shared ref store`
    }
    case "branch": {
      if (!args.some((arg) => BRANCH_MUTATE.has(arg))) return
      const pos = positionals(args)
      if (pos.length > 0 && pos.every((name) => owns(name))) return
      return "deleting, force-moving or renaming a branch mutates the shared ref store"
    }
    case "push": {
      const pos = positionals(args)
      const specs = pos.slice(1)
      const forced =
        args.includes("--force") || args.includes("-f") || specs.some((spec) => spec.startsWith("+"))
      const deleting = args.includes("--delete") || specs.some((spec) => spec.startsWith(":"))
      if (!forced && !deleting) return
      // No refspec ⇒ the current (own) branch.
      if (specs.length === 0) return
      const foreign = specs.map(pushTarget).filter((name) => !owns(name))
      if (foreign.length === 0) return
      return `force-pushing or deleting '${foreign[0]}' rewrites a branch this session does not own`
    }
    case "worktree": {
      const pos = positionals(args)
      if (pos.length === 0 || !WORKTREE_MUTATE.has(pos[0])) return
      return `\`git worktree ${pos[0]}\` mutates the shared worktree registry`
    }
    case "update-ref": {
      const pos = positionals(args)
      const ref = pos[0] ?? ""
      if (owns(ref.replace(/^refs\/heads\//, ""))) return
      return "`git update-ref` writes the shared ref store directly"
    }
    case "symbolic-ref": {
      // One positional is a READ (`git symbolic-ref HEAD`); two is a write.
      const pos = positionals(args)
      if (pos.length < 2 && !args.includes("--delete") && !args.includes("-d")) return
      return "`git symbolic-ref` repoints HEAD in the shared ref store"
    }
    case "tag": {
      // Tags live in the shared ref store and — unlike a branch — carry NO
      // "already checked out by another worktree" protection, so a force-update
      // from here silently moves a tag the parent checkout and every other
      // worktree resolve. Measured: `git tag -f v1 HEAD` from a linked worktree
      // prints `Updated tag 'v1'` and the parent sees the new value.
      // Creating a NEW tag is additive and allowed; only moving or deleting an
      // existing one reaches across.
      if (args.includes("-f") || args.includes("--force")) return "`git tag -f` moves a shared tag"
      if (args.includes("-d") || args.includes("--delete")) return "`git tag -d` deletes a shared tag"
      return
    }
    default:
      return
  }
}

/** True when `directory` is one of the app-managed worktrees that back an
 *  isolated child session (`<data>/worktree/<projectID>/<name>`). The
 *  orchestrator and ordinary sessions run in the user's project directory and
 *  are therefore never gated. Mirrors the trusted-root test already used by
 *  `src/tool/external-directory.ts`, but additionally compares realpaths:
 *  `Instance.provide` stores a realpath-resolved directory, so on a symlinked
 *  prefix (macOS `/var` → `/private/var`) a raw string-prefix test misses. */
export function isIsolatedWorktree(directory: string | undefined, root?: string) {
  if (!directory) return false
  const base = root ?? path.join(Global.Path.data, "worktree")
  if (AppFileSystem.contains(base, directory)) return true
  return AppFileSystem.contains(real(base), real(directory))
}

function real(target: string) {
  try {
    return realpathSync(target)
  } catch {
    return path.resolve(target)
  }
}

/** Best-effort read of the branch a worktree is on, without spawning git.
 *  `<worktree>/.git` is a file containing `gitdir: <repo>/.git/worktrees/<name>`,
 *  whose `HEAD` holds `ref: refs/heads/<branch>`. Returns undefined on any
 *  surprise (detached HEAD, unreadable, plain clone layout is handled too). */
export function ownBranch(directory: string): string | undefined {
  try {
    const dotGit = path.join(directory, ".git")
    let gitDir = dotGit
    try {
      const pointer = readFileSync(dotGit, "utf-8")
      const match = pointer.match(/^gitdir:\s*(.+)$/m)
      if (match) gitDir = path.resolve(directory, match[1].trim())
    } catch {
      // `.git` is a directory (ordinary clone) — read HEAD from it directly.
    }
    const head = readFileSync(path.join(gitDir, "HEAD"), "utf-8").trim()
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/)
    return ref ? ref[1] : undefined
  } catch {
    return undefined
  }
}

function message(input: { violation: Violation; directory: string; branch?: string }) {
  const branch = input.branch ?? "(could not be determined)"
  return (
    `Blocked in an isolated child session: ${input.violation.command}\n` +
    `Reason: ${input.violation.reason}.\n\n` +
    `Every worktree of this repository shares ONE .git/ ref store, so a cross-branch git\n` +
    `operation run from inside your worktree writes refs the MAIN checkout is using and can\n` +
    `move its HEAD — corrupting the working tree the user and other agents are in right now.\n\n` +
    `  your worktree: ${input.directory}\n` +
    `  your branch:   ${branch}\n\n` +
    `Do this instead:\n` +
    `  - work only in your worktree, on your own branch\n` +
    `  - \`git add\` + \`git commit\` + \`git push\` YOUR branch, and nothing else\n` +
    `  - ask the orchestrator to rebase/merge/land it — cross-branch integration is its job\n`
  )
}

/**
 * The gate. Throws (loudly, with remediation) when any command in a bash
 * invocation crosses the isolated child's branch boundary. No-ops when the
 * session is not an isolated child.
 */
export function assertIsolatedGitAllowed(input: {
  /** argv of every command node in the parsed invocation (pipelines, `&&`
   *  chains and subshells each contribute one entry). */
  commands: string[][]
  /** Rendered source of each command, index-aligned with `commands`; used only
   *  for the error text. Falls back to the joined argv. */
  sources?: string[]
  directory: string
  isolated: boolean
  branch?: string
  isPath?: (arg: string) => boolean
}): void {
  if (!input.isolated) return
  for (let i = 0; i < input.commands.length; i++) {
    const tokens = input.commands[i]
    const reason = violates({ tokens, branch: input.branch, isPath: input.isPath })
    if (!reason) continue
    throw new Error(
      message({
        violation: { command: input.sources?.[i] ?? tokens.join(" "), reason },
        directory: input.directory,
        branch: input.branch,
      }),
    )
  }
}
