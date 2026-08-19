import type { Argv } from "yargs"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { AppRuntime } from "@/effect/app-runtime"
import { Config } from "@/config"
import { Instance } from "@/project/instance"
import { LLMServerTokens } from "../../llm-server/tokens"
import { LLMServerCapability } from "../../llm-server/capability"
import { Self } from "@/util"
import { UI } from "../ui"

/**
 * A temporary OpenAI-compatible endpoint for the models this instance already has.
 *
 * The point is to stop handing real provider keys to things that only need "a
 * model": a skill, a subprocess, or a script gets a `base_url` plus a throwaway
 * token, and the actual credential never leaves `Provider.Service`.
 *
 * This command family only MINTS credentials. The endpoint itself lives on the instance's
 * own HTTP server, because that is the process where provider auth actually happens: a
 * plugin's `chat.headers` hook supplies credentials for plugin-authenticated providers, and
 * a separate listener would bypass it. See `server/routes/instance/capability.ts`.
 *
 * Subcommands (`issue`, `list`, `revoke`) rather than a tool, because minting a key is
 * a rare, scriptable act. The two halves meet through the on-disk token store, so
 * `issue` can hand out a working credential from a completely separate process.
 */

const DEFAULT_TTL = "1d"

/**
 * Parse a duration, where "no limit" is a value rather than an absence.
 *
 * `none` has to be expressible: a token minted for an open-ended job should be able
 * to say so, and spelling it out keeps "unlimited" distinguishable from "the flag
 * was forgotten".
 */
export function duration(input: string | undefined, fallback: string): number | undefined {
  const value = (input ?? fallback).trim().toLowerCase()
  if (value === "none" || value === "never" || value === "0") return undefined
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(value)
  if (!match) throw new Error(`Invalid duration \`${input}\`; use forms like 30m, 12h, 7d, or none`)
  const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] ?? "ms"]!
  return Number(match[1]) * scale
}

function defaults() {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const cfg = yield* (yield* Config.Service).get()
      return { ttl: cfg.llmServer?.ttl, maxAge: cfg.llmServer?.maxAge }
    }),
  )
}

async function inInstance(fn: () => Promise<void>) {
  await Instance.provide({ directory: process.cwd(), fn })
}

function relative(at: number | undefined) {
  if (at === undefined) return "never"
  const ms = at - Date.now()
  if (ms <= 0) return "expired"
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `in ${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `in ${hours}h`
  return `in ${Math.round(hours / 24)}d`
}

/**
 * Reproduce the flags that shaped this token, so a renewal is equivalent rather
 * than merely valid. Dropping `--model` would quietly widen the replacement key.
 */
function renewArgs(args: {
  ttl?: string
  "max-age"?: string
  model: string[]
  label?: string
  capability?: string
}) {
  return [
    ...(args.ttl ? ["--ttl", args.ttl] : []),
    ...(args["max-age"] ? ["--max-age", args["max-age"]] : []),
    ...(args.capability ? ["--capability", args.capability] : []),
    ...args.model.flatMap((ref) => ["--model", ref]),
    ...(args.label ? ["--label", args.label] : []),
    "--json",
  ]
}

const issue = cmd({
  command: "issue",
  describe: "mint a token for the local LLM server and print how to reach it",
  builder: (yargs: Argv) =>
    yargs
      .option("ttl", {
        type: "string",
        describe: "sliding lifetime, measured from last use (e.g. 30m, 12h, 1d, none)",
      })
      .option("max-age", {
        type: "string",
        describe: "absolute ceiling from issue regardless of activity (e.g. 7d, none)",
      })
      .option("model", {
        type: "string",
        array: true,
        describe: "restrict this token to the given provider/model (repeatable)",
        default: [] as string[],
      })
      .option("capability", {
        type: "string",
        choices: ["chat", "speech", "transcription"] as const,
        describe:
          "resolve a model by what it can DO rather than by name, and scope the token to it. " +
          "Lets a skill declare `speech` instead of binding to one installation's model id",
      })
      .option("label", { type: "string", describe: "a note for `llm-server list`, e.g. the skill's name" })
      .option("json", { type: "boolean", describe: "print connection details as JSON", default: false }),
  handler: (args) =>
    inInstance(async () => {
      const cfg = await defaults()
      const expiry = {
        idleMs: duration(args.ttl, cfg.ttl ?? DEFAULT_TTL),
        maxAgeMs: duration(args["max-age"], cfg.maxAge ?? "none"),
      }
      // `--capability` and `--model` answer the same question two ways, so accepting both
      // would leave the caller guessing which one won.
      if (args.capability && args.model.length > 0) {
        throw new Error("pass either --capability or --model, not both")
      }

      // Narrowed once, here, so nothing downstream has to assert that a match exists.
      const chosen = await (async () => {
        if (!args.capability) return undefined
        const capability = args.capability as LLMServerCapability.Capability
        const matches = await LLMServerCapability.resolve(capability)
        const best = matches[0]
        if (!best) throw new Error(LLMServerCapability.explain(capability, await LLMServerCapability.all()))
        return { capability, best, alternatives: matches.slice(1).map((m) => m.ref) }
      })()

      // Scoped to the ONE model that was resolved, not to every model that could serve the
      // capability: a task should reach what it asked for and nothing else.
      const models = chosen ? [chosen.best.ref] : args.model

      const issued = await LLMServerTokens.issue({
        directory: process.cwd(),
        expiry,
        models,
        label: args.label,
      })

      // Resolved rather than guessed: a mimocode process serving this project advertises
      // its loopback address, so the two halves of "where" and "with what" can finally be
      // printed together. Absent when nothing is serving this directory right now.
      const address = await LLMServerTokens.address(process.cwd())

      if (args.json) {
        // Machine-first: a wrapper reads one line and exports the two env vars the
        // skill asked for. `base_url` is null rather than absent when no server is
        // running, so a consumer fails on a missing value instead of on a missing key.
        process.stdout.write(
          JSON.stringify({
            api_key: issued.token,
            id: issued.record.id,
            base_url: address ? `${address.url.replace(/\/$/, "")}/v1` : null,
            expires_at: LLMServerTokens.expiresAt(issued.record) ?? null,
            models: issued.record.models.length > 0 ? issued.record.models : "all",
            // The resolved model, so a skill can set its own env var without knowing which
            // one this installation happens to have. `fallback` warns that a multimodal
            // chat model is standing in for a dedicated one.
            ...(chosen
              ? {
                  capability: chosen.capability,
                  model: chosen.best.ref,
                  fallback: !chosen.best.dedicated,
                  // Capped: a real installation offered 130 chat models, and a list that
                  // long is noise rather than information.
                  alternatives: chosen.alternatives.slice(0, 5),
                  alternatives_total: chosen.alternatives.length,
                }
              : {}),
            // How to get another key when this one ages out, resolved for THIS
            // installation. A skill that only ever sees this JSON can therefore
            // recover from `expired_api_key` without knowing whether mimocode came
            // from npx, a global install, or a source checkout.
            renew_argv: Self.argv("llm-server", "issue", ...renewArgs(args)),
            renew_command: Self.commandLine("llm-server", "issue", ...renewArgs(args)),
          }) + "\n",
        )
        return
      }

      UI.println(UI.Style.TEXT_SUCCESS_BOLD + "token issued" + UI.Style.TEXT_NORMAL)
      UI.println(`  api_key   ${issued.token}`)
      UI.println(`  id        ${issued.record.id}`)
      UI.println(`  base_url  ${address ? `${address.url.replace(/\/$/, "")}/v1` : "(no instance is serving this directory)"}`)
      UI.println(`  expires   ${relative(LLMServerTokens.expiresAt(issued.record))}`)
      UI.println(`  models    ${issued.record.models.length > 0 ? issued.record.models.join(", ") : "all configured"}`)
      if (chosen) {
        UI.println(
          `  resolved  ${chosen.capability} -> ${chosen.best.ref}` +
            (chosen.best.dedicated ? "" : " (multimodal fallback, not a dedicated model)"),
        )
      }
      UI.println("")
      UI.println("The plaintext token is shown once and is not stored; only its hash is.")
      // The endpoint belongs to whichever mimocode process serves this project, and each
      // binds its own port — so this is read from what that process advertised, not
      // guessed. Nothing serving means nothing to point at: say so instead of printing a
      // URL that will refuse connections.
      if (!address) {
        UI.println("Start a session in this directory (or `mimo serve --port <n>`) and issue again.")
      }
    }),
})

const list = cmd({
  command: "list",
  describe: "list tokens issued for this directory",
  builder: (yargs: Argv) => yargs.option("json", { type: "boolean", default: false }),
  handler: (args) =>
    inInstance(async () => {
      const tokens = await LLMServerTokens.list(process.cwd())
      // All of them, not just one: several sessions can be open on the same project, and
      // "which port do I use" is exactly the question this command is asked.
      const servers = await LLMServerTokens.addresses(process.cwd())
      if (args.json) {
        process.stdout.write(JSON.stringify({ servers, server: servers[0] ?? null, tokens }) + "\n")
        return
      }
      if (servers.length === 0) UI.println("server    none serving this directory")
      for (const server of servers) UI.println(`server    ${server.url} (pid ${server.pid})`)
      if (tokens.length === 0) {
        UI.println("tokens    none")
        return
      }
      UI.println("")
      for (const token of tokens) {
        UI.println(
          `  ${token.id}  ${token.expired ? "EXPIRED" : relative(token.expires_at).padEnd(10)}  ${
            token.models.length > 0 ? token.models.join(",") : "all"
          }${token.label ? `  (${token.label})` : ""}`,
        )
      }
    }),
})

const revoke = cmd({
  command: "revoke [id]",
  describe: "revoke a token by id, or every token with --all",
  builder: (yargs: Argv) =>
    yargs
      .positional("id", { type: "string", describe: "token id from `llm-server list`" })
      .option("all", { type: "boolean", describe: "revoke every token for this directory", default: false }),
  handler: (args) =>
    inInstance(async () => {
      if (args.all) {
        UI.println(`revoked ${await LLMServerTokens.revokeAll(process.cwd())} token(s)`)
        return
      }
      if (!args.id) {
        UI.error("pass a token id, or --all")
        process.exitCode = 1
        return
      }
      const done = await LLMServerTokens.revoke(process.cwd(), args.id)
      if (!done) {
        UI.error(`no token with id \`${args.id}\``)
        process.exitCode = 1
        return
      }
      UI.println(`revoked ${args.id}`)
    }),
})

export const LlmServerCommand = cmd({
  command: "llm-server",
  describe: "mint and manage credentials that let a task reach this instance's models",
  builder: (yargs: Argv) => yargs.command(issue).command(list).command(revoke).demandCommand(1),
  handler: () => {},
})
