import type { Argv } from "yargs"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { AppRuntime } from "@/effect/app-runtime"
import { Effect } from "effect"
import { Config } from "../../config"
import { Provider } from "../../provider"
import { Instance } from "../../project/instance"

export const ConfigCommand = cmd({
  command: "config",
  describe: "configure MiMoCode settings",
  builder: (yargs: Argv) => {
    return yargs.command(ConfigVisionModelCommand).demandCommand()
  },
  handler: () => {},
})

export const ConfigVisionModelCommand = cmd({
  command: "vision-model",
  describe: "set the vision model for processing images/PDFs when the main model doesn't support vision",
  builder: (yargs: Argv) => {
    return yargs.option("clear", {
      describe: "remove the vision model configuration",
      type: "boolean",
    })
  },
  handler: async (args) => {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        await AppRuntime.runPromise(
          Effect.gen(function* () {
            const config = yield* Config.Service
            const providerSvc = yield* Provider.Service
            const cfg = yield* config.get()

            if (args.clear) {
              const updated = { ...cfg }
              delete updated.vision_model
              yield* config.updateGlobal(updated)
              yield* Effect.sync(() => prompts.log.success("Vision model cleared"))
              return
            }

            const providers = yield* providerSvc.list()

            const visionModels: Array<{ label: string; value: string }> = []
            for (const [providerID, provider] of Object.entries(providers)) {
              for (const [modelID, model] of Object.entries(provider.models)) {
                if (model.capabilities.input.image) {
                  visionModels.push({
                    label: `${model.name} (${providerID}/${modelID})`,
                    value: `${providerID}/${modelID}`,
                  })
                }
              }
            }

            if (visionModels.length === 0) {
              yield* Effect.sync(() => prompts.log.error("No vision-capable models found in mimo/xiaomi providers"))
              return
            }

            if (cfg.vision_model) {
              yield* Effect.sync(() => prompts.log.info(`Current vision model: ${cfg.vision_model}`))
            }

            const selected = yield* Effect.promise(() =>
              prompts.select({
                message: "Select vision model for multimodal processing",
                options: [...visionModels, { label: "Disable (none)", value: "__none__" }],
                initialValue: cfg.vision_model ?? undefined,
              }),
            )
            if (prompts.isCancel(selected)) throw new UI.CancelledError()

            if (selected === "__none__") {
              const updated = { ...cfg }
              delete updated.vision_model
              yield* config.updateGlobal(updated)
              yield* Effect.sync(() => prompts.log.success("Vision model disabled"))
            } else {
              yield* config.updateGlobal({ vision_model: selected })
              yield* Effect.sync(() => prompts.log.success(`Vision model set to: ${selected}`))
            }
          }),
        )
      },
    })
  },
})
