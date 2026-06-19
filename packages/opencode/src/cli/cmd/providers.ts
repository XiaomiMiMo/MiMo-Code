import { Auth } from "../../auth"
import { AppRuntime } from "../../effect/app-runtime"
import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { ModelsDev } from "../../provider"
import { map, pipe, sortBy, values } from "remeda"
import path from "path"
import fs from "fs"
import { pathToFileURL } from "url"
import os from "os"
import { Config } from "../../config"
import { Global } from "../../global"
import { Plugin } from "../../plugin"
import { t } from "../i18n"
import { Instance } from "../../project/instance"
import type { Hooks } from "@mimo-ai/plugin"
import { Process } from "../../util"
import { PROVIDER_PRIORITY } from "../../util/provider-priority"
import { text } from "node:stream/consumers"
import { Effect } from "effect"
import * as readline from "readline"

type PluginAuth = NonNullable<Hooks["auth"]>

const put = (key: string, info: Auth.Info) =>
  AppRuntime.runPromise(
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set(key, info)
    }),
  )

async function handlePluginAuth(plugin: { auth: PluginAuth }, provider: string, methodName?: string): Promise<boolean> {
  let index = 0
  if (methodName) {
    const match = plugin.auth.methods.findIndex((x) => x.label.toLowerCase() === methodName.toLowerCase())
    if (match === -1) {
      prompts.log.error(
        `Unknown method "${methodName}" for ${provider}. Available: ${plugin.auth.methods.map((x) => x.label).join(", ")}`,
      )
      process.exit(1)
    }
    index = match
  } else if (plugin.auth.methods.length > 1) {
    const method = await prompts.select({
      message: "Login method",
      options: plugin.auth.methods.map((x, index) => ({
        label: x.label,
        value: index.toString(),
      })),
    })
    if (prompts.isCancel(method)) throw new UI.CancelledError()
    index = parseInt(method)
  }
  const method = plugin.auth.methods[index]

  await new Promise((r) => setTimeout(r, 10))
  const inputs: Record<string, string> = {}
  if (method.prompts) {
    for (const prompt of method.prompts) {
      if (prompt.when) {
        const value = inputs[prompt.when.key]
        if (value === undefined) continue
        const matches = prompt.when.op === "eq" ? value === prompt.when.value : value !== prompt.when.value
        if (!matches) continue
      }
      if (prompt.condition && !prompt.condition(inputs)) continue
      if (prompt.type === "select") {
        const value = await prompts.select({
          message: prompt.message,
          options: prompt.options,
        })
        if (prompts.isCancel(value)) throw new UI.CancelledError()
        inputs[prompt.key] = value
      } else {
        const value = await prompts.text({
          message: prompt.message,
          placeholder: prompt.placeholder,
          validate: prompt.validate ? (v) => prompt.validate!(v ?? "") : undefined,
        })
        if (prompts.isCancel(value)) throw new UI.CancelledError()
        inputs[prompt.key] = value
      }
    }
  }

  if (method.type === "oauth") {
    const authorize = await method.authorize(inputs)

    if (authorize.url) {
      prompts.log.info("Go to: " + authorize.url)
    }

    if (authorize.method === "auto") {
      if (authorize.instructions) {
        prompts.log.info(authorize.instructions)
      }
      const spinner = prompts.spinner()
      spinner.start("Waiting for authorization...")
      const result = await authorize.callback()
      if (result.type === "failed") {
        spinner.stop("Failed to authorize", 1)
      }
      if (result.type === "success") {
        const saveProvider = result.provider ?? provider
        if ("refresh" in result) {
          const { type: _, provider: __, refresh, access, expires, metadata: _m, ...extraFields } = result
          await put(saveProvider, {
            type: "oauth",
            refresh,
            access,
            expires,
            ...extraFields,
          })
        }
        if ("key" in result) {
          await put(saveProvider, {
            type: "api",
            key: result.key,
            ...(result.metadata ? { metadata: result.metadata } : {}),
          })
        }
        spinner.stop("Login successful")
      }
    }

    if (authorize.method === "code") {
      const code = await prompts.text({
        message: "Paste the authorization code here: ",
        validate: (x) => (x && x.length > 0 ? undefined : "Required"),
      })
      if (prompts.isCancel(code)) throw new UI.CancelledError()
      const result = await authorize.callback(code)
      if (result.type === "failed") {
        prompts.log.error("Failed to authorize")
      }
      if (result.type === "success") {
        const saveProvider = result.provider ?? provider
        if ("refresh" in result) {
          const { type: _, provider: __, refresh, access, expires, metadata: _m, ...extraFields } = result
          await put(saveProvider, {
            type: "oauth",
            refresh,
            access,
            expires,
            ...extraFields,
          })
        }
        if ("key" in result) {
          await put(saveProvider, {
            type: "api",
            key: result.key,
            ...(result.metadata ? { metadata: result.metadata } : {}),
          })
        }
        prompts.log.success("Login successful")
      }
    }

    prompts.outro("Done")
    return true
  }

  if (method.type === "api") {
    if (method.authorize) {
      const key = await prompts.password({
        message: "Enter your API key",
        validate: (x) => (x && x.length > 0 ? undefined : "Required"),
      })
      if (prompts.isCancel(key)) throw new UI.CancelledError()

      const result = await method.authorize(inputs)
      if (result.type === "failed") {
        prompts.log.error("Failed to authorize")
      }
      if (result.type === "success") {
        const saveProvider = result.provider ?? provider
        await put(saveProvider, {
          type: "api",
          key: result.key ?? key,
        })
        prompts.log.success("Login successful")
      }
      prompts.outro("Done")
      return true
    }
  }

  return false
}

export function resolvePluginProviders(input: {
  hooks: Hooks[]
  existingProviders: Record<string, unknown>
  disabled: Set<string>
  enabled?: Set<string>
  providerNames: Record<string, string | undefined>
}): Array<{ id: string; name: string }> {
  const seen = new Set<string>()
  const result: Array<{ id: string; name: string }> = []

  for (const hook of input.hooks) {
    if (!hook.auth) continue
    const id = hook.auth.provider
    if (seen.has(id)) continue
    seen.add(id)
    if (Object.hasOwn(input.existingProviders, id)) continue
    if (input.disabled.has(id)) continue
    if (input.enabled && !input.enabled.has(id)) continue
    result.push({
      id,
      name: input.providerNames[id] ?? id,
    })
  }

  return result
}

// Dynamically load the optional free-login entry (src/ext/free-login.ts), if
// present. Returns its handler when available, otherwise undefined. Computed
// path so builds without the extension still resolve cleanly.
async function loadFreeLogin(): Promise<(() => Promise<void>) | undefined> {
  const file = path.join(import.meta.dir, "..", "..", "ext", "free-login.ts")
  if (!fs.existsSync(file)) return undefined
  try {
    const mod = await import(/* @vite-ignore */ pathToFileURL(file).href)
    return typeof mod.mimoFreeLogin === "function" ? mod.mimoFreeLogin : undefined
  } catch {
    return undefined
  }
}

async function mimoLogin() {
  const hooks = await AppRuntime.runPromise(
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      return yield* plugin.list()
    }),
  )
  const mimoHook = hooks.findLast((h) => h.auth?.provider === "xiaomi")
  if (!mimoHook?.auth) {
    prompts.log.error("MiMo auth plugin not found")
    return
  }

  const method = mimoHook.auth.methods[0]
  if (method.type !== "oauth") return

  const authorize = await method.authorize()
  if (authorize.method !== "auto") return

  prompts.log.info(`Browser didn't open? Use the url below to sign in:\n${authorize.url}`)

  const browserPromise = authorize.callback().catch(() => ({ type: "failed" as const }))

  const MAX_RETRIES = 3
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const raceResult = await raceCallbackAndStdin(browserPromise)

    if (raceResult.source === "browser") {
      if (raceResult.data.type === "success" && "key" in raceResult.data) {
        await put("xiaomi", {
          type: "api",
          key: raceResult.data.key,
          ...(raceResult.data.metadata ? { metadata: raceResult.data.metadata } : {}),
        })
        prompts.log.success("Login successful")
        prompts.outro("Done")
        return
      }
      prompts.log.error("Login failed")
      prompts.outro("Done")
      return
    }

    const callbackResult = await authorize.callback(raceResult.input)
    if (callbackResult.type === "success" && "key" in callbackResult) {
      await put("xiaomi", {
        type: "api",
        key: callbackResult.key,
        ...(callbackResult.metadata ? { metadata: callbackResult.metadata } : {}),
      })
      prompts.log.success("Login successful")
      prompts.outro("Done")
      return
    }

    const remaining = MAX_RETRIES - attempt - 1
    if (remaining > 0) {
      prompts.log.error(t("cli.providers.mimo_login.decrypt_retry", { remaining }))
    } else {
      prompts.log.error(t("cli.providers.mimo_login.decrypt_exhausted"))
    }
  }
}

function raceCallbackAndStdin<T>(
  browserPromise: Promise<T>,
): Promise<{ source: "browser"; data: T } | { source: "paste"; input: string }> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

    let settled = false
    const cleanup = () => {
      if (settled) return
      settled = true
      rl.close()
    }

    browserPromise.then((data) => {
      if (settled) return
      cleanup()
      process.stdout.write("\n")
      resolve({ source: "browser", data })
    })

    rl.question("Paste code here if prompted > ", (answer) => {
      if (settled) return
      const trimmed = answer.trim()
      if (trimmed.length > 0) {
        cleanup()
        resolve({ source: "paste", input: trimmed })
      }
    })
  })
}

export const ProvidersCommand = cmd({
  command: "providers",
  aliases: ["auth"],
  describe: "manage AI providers and credentials",
  builder: (yargs) =>
    yargs
      .command(ProvidersListCommand)
      .command(ProvidersLoginCommand)
      .command(ProvidersLogoutCommand)
      .command(ProvidersWhoamiCommand)
      .demandCommand(),
  async handler() {},
})

export const ProvidersListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list providers and credentials",
  async handler(_args) {
    UI.empty()
    const authPath = path.join(Global.Path.data, "auth.json")
    const homedir = os.homedir()
    const displayPath = authPath.startsWith(homedir) ? authPath.replace(homedir, "~") : authPath
    prompts.intro(`Credentials ${UI.Style.TEXT_DIM}${displayPath}`)
    const results = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        return Object.entries(yield* auth.all())
      }),
    )
    const database = await ModelsDev.get()

    for (const [providerID, result] of results) {
      const name = database[providerID]?.name || providerID
      prompts.log.info(`${name} ${UI.Style.TEXT_DIM}${result.type}`)
    }

    prompts.outro(`${results.length} credentials`)

    const activeEnvVars: Array<{ provider: string; envVar: string }> = []

    for (const [providerID, provider] of Object.entries(database)) {
      for (const envVar of provider.env) {
        if (process.env[envVar]) {
          activeEnvVars.push({
            provider: provider.name || providerID,
            envVar,
          })
        }
      }
    }

    if (activeEnvVars.length > 0) {
      UI.empty()
      prompts.intro("Environment")

      for (const { provider, envVar } of activeEnvVars) {
        prompts.log.info(`${provider} ${UI.Style.TEXT_DIM}${envVar}`)
      }

      prompts.outro(`${activeEnvVars.length} environment variable` + (activeEnvVars.length === 1 ? "" : "s"))
    }
  },
})

export const ProvidersLoginCommand = cmd({
  command: "login [url]",
  describe: "log in to a provider",
  builder: (yargs) =>
    yargs
      .positional("url", {
        describe: "mimocode auth provider",
        type: "string",
      })
      .option("provider", {
        alias: ["p"],
        describe: "provider id or name to log in to (skips provider selection)",
        type: "string",
      })
      .option("method", {
        alias: ["m"],
        describe: "login method label (skips method selection)",
        type: "string",
      }),
  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        UI.empty()
        prompts.intro("Add credential")
        if (args.url) {
          const url = args.url.replace(/\/+$/, "")
          const wellknown = (await fetch(`${url}/.well-known/opencode`).then((x) => x.json())) as {
            auth: { command: string[]; env: string }
          }
          prompts.log.info(`Running \`${wellknown.auth.command.join(" ")}\``)
          const proc = Process.spawn(wellknown.auth.command, {
            stdout: "pipe",
          })
          if (!proc.stdout) {
            prompts.log.error("Failed")
            prompts.outro("Done")
            return
          }
          const [exit, token] = await Promise.all([proc.exited, text(proc.stdout)])
          if (exit !== 0) {
            prompts.log.error("Failed")
            prompts.outro("Done")
            return
          }
          await put(url, {
            type: "wellknown",
            key: wellknown.auth.env,
            token: token.trim(),
          })
          prompts.log.success("Logged into " + url)
          prompts.outro("Done")
          return
        }
        await ModelsDev.refresh(true).catch(() => {})

        const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.get()))

        const disabled = new Set(config.disabled_providers ?? [])
        const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined

        const providers = await ModelsDev.get().then((x) => {
          const filtered: Record<string, (typeof x)[string]> = {}
          for (const [key, value] of Object.entries(x)) {
            if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) {
              filtered[key] = value
            }
          }
          return filtered
        })
        const hooks = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const plugin = yield* Plugin.Service
            return yield* plugin.list()
          }),
        )

        const priority = PROVIDER_PRIORITY
        const pluginProviders = resolvePluginProviders({
          hooks,
          existingProviders: providers,
          disabled,
          enabled,
          providerNames: Object.fromEntries(Object.entries(config.provider ?? {}).map(([id, p]) => [id, p.name])),
        })
        const options = [
          ...pipe(
            providers,
            values(),
            sortBy(
              (x) => priority[x.id] ?? 99,
              (x) => x.name ?? x.id,
            ),
            map((x) => ({
              label: x.name,
              value: x.id,
              hint: {
                openai: "ChatGPT Plus/Pro or API key",
              }[x.id],
            })),
          ),
          ...pluginProviders.map((x) => ({
            label: x.name,
            value: x.id,
            hint: "plugin",
          })),
        ]

        const freeLogin = await loadFreeLogin()
        let provider: string
        if (args.provider === "xiaomi") {
          await mimoLogin()
          return
        } else if ((args.provider === "mimo" || args.provider === "mimo-free") && freeLogin) {
          await freeLogin()
          return
        } else if (args.provider) {
          const input = args.provider
          const byID = options.find((x) => x.value === input)
          const byName = options.find((x) => x.label.toLowerCase() === input.toLowerCase())
          const match = byID ?? byName
          if (!match) {
            prompts.log.error(`Unknown provider "${input}"`)
            process.exit(1)
          }
          provider = match.value
        } else {
          const choice = await prompts.select({
            message: t("cli.providers.select"),
            options: [
              { label: "MiMo", value: "xiaomi", hint: t("cli.providers.mimo.recommended_hint") },
              ...(freeLogin
                ? [{ label: "MiMo Auto (free)", value: "mimo-free", hint: t("cli.providers.mimo_free.hint") }]
                : []),
              { label: t("cli.providers.other"), value: "__other__" },
            ],
          })
          if (prompts.isCancel(choice)) throw new UI.CancelledError()

          if (choice === "xiaomi") {
            await mimoLogin()
            return
          }

          if (choice === "mimo-free" && freeLogin) {
            await freeLogin()
            return
          }

          const selected = await prompts.autocomplete({
            message: t("cli.providers.select"),
            maxItems: 8,
            options: [
              ...options,
              {
                value: "other",
                label: "Other",
              },
            ],
          })
          if (prompts.isCancel(selected)) throw new UI.CancelledError()
          provider = selected as string
        }

        const plugin = hooks.findLast((x) => x.auth?.provider === provider)
        if (plugin && plugin.auth) {
          const handled = await handlePluginAuth({ auth: plugin.auth }, provider, args.method)
          if (handled) return
        }

        if (provider === "other") {
          const custom = await prompts.text({
            message: "Enter provider id",
            validate: (x) => (x && x.match(/^[0-9a-z-]+$/) ? undefined : "a-z, 0-9 and hyphens only"),
          })
          if (prompts.isCancel(custom)) throw new UI.CancelledError()
          provider = custom.replace(/^@ai-sdk\//, "")

          const customPlugin = hooks.findLast((x) => x.auth?.provider === provider)
          if (customPlugin && customPlugin.auth) {
            const handled = await handlePluginAuth({ auth: customPlugin.auth }, provider, args.method)
            if (handled) return
          }

          prompts.log.warn(
            `This only stores a credential for ${provider} - you will need configure it in mimocode.json, check the docs for examples.`,
          )
        }

        if (provider === "amazon-bedrock") {
          prompts.log.info(
            "Amazon Bedrock authentication priority:\n" +
              "  1. Bearer token (AWS_BEARER_TOKEN_BEDROCK or /connect)\n" +
              "  2. AWS credential chain (profile, access keys, IAM roles, EKS IRSA)\n\n" +
              "Configure via mimocode.json options (profile, region, endpoint) or\n" +
              "AWS environment variables (AWS_PROFILE, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_WEB_IDENTITY_TOKEN_FILE).",
          )
        }

        if (provider === "opencode") {
          prompts.log.info("Create an api key at https://opencode.ai/auth")
        }

        if (provider === "vercel") {
          prompts.log.info("You can create an api key at https://vercel.link/ai-gateway-token")
        }

        if (["cloudflare", "cloudflare-ai-gateway"].includes(provider)) {
          prompts.log.info(
            "Cloudflare AI Gateway can be configured with CLOUDFLARE_GATEWAY_ID, CLOUDFLARE_ACCOUNT_ID, and CLOUDFLARE_API_TOKEN environment variables. Read more: https://opencode.ai/docs/providers/#cloudflare-ai-gateway",
          )
        }

        const key = await prompts.password({
          message: "Enter your API key",
          validate: (x) => (x && x.length > 0 ? undefined : "Required"),
        })
        if (prompts.isCancel(key)) throw new UI.CancelledError()
        await put(provider, {
          type: "api",
          key,
        })

        prompts.outro("Done")
      },
    })
  },
})

export const ProvidersLogoutCommand = cmd({
  command: "logout",
  describe: "log out from a configured provider",
  async handler(_args) {
    UI.empty()
    const credentials: Array<[string, Auth.Info]> = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        return Object.entries(yield* auth.all())
      }),
    )
    prompts.intro("Remove credential")
    if (credentials.length === 0) {
      prompts.log.error("No credentials found")
      return
    }
    const database = await ModelsDev.get()
    const selected = await prompts.select({
      message: "Select provider",
      options: credentials.map(([key, value]) => ({
        label: (database[key]?.name || key) + UI.Style.TEXT_DIM + " (" + value.type + ")",
        value: key,
      })),
    })
    if (prompts.isCancel(selected)) throw new UI.CancelledError()
    const providerID = selected as string
    await AppRuntime.runPromise(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.remove(providerID)
      }),
    )
    prompts.outro("Logout successful")
  },
})

export const ProvidersWhoamiCommand = cmd({
  command: "whoami",
  describe: "show current logged-in user info",
  async handler(_args) {
    UI.empty()
    prompts.intro("Current user")
    const info = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        return yield* auth.get("xiaomi")
      }),
    )
    if (!info) {
      prompts.log.error("Not logged in. Run `mimo auth login` to log in.")
      return
    }
    if (info.type === "api" && info.metadata) {
      prompts.log.info(`Provider: MiMo`)
      prompts.log.info(`User ID: ${info.metadata.uid ?? "unknown"}`)
    } else {
      prompts.log.info(`Provider: MiMo`)
      prompts.log.info(`Type: ${info.type}`)
    }
    prompts.outro("")
  },
})
