import { Server } from "../../server/server"
import type { CommandModule } from "yargs"

export const GenerateCommand = {
  command: "generate",
  handler: async () => {
    const specs = await Server.openapi()
    for (const item of Object.values(specs.paths)) {
      for (const method of ["get", "post", "put", "delete", "patch"] as const) {
        const operation = item[method]
        if (!operation?.operationId) continue
        // @ts-expect-error
        operation["x-codeSamples"] = [
          {
            lang: "js",
            source: [
              `import { createOpencodeClient } from "@mimo-ai/sdk`,
              ``,
              `const client = createOpencodeClient()`,
              `await client.${operation.operationId}({`,
              `  ...`,
              `})`,
            ].join("\n"),
          },
        ]
      }
    }
    const components = (specs.components = specs.components || {})
    const schemas = (components.schemas = components.schemas || {})
    const extractDefs = (obj: any) => {
      if (!obj || typeof obj !== "object") return
      if (obj.$defs && typeof obj.$defs === "object") {
        for (const [key, val] of Object.entries(obj.$defs)) {
          if (!schemas[key]) {
            schemas[key] = val as any
          }
          extractDefs(val)
        }
        delete obj.$defs
      }
      for (const val of Object.values(obj)) {
        extractDefs(val)
      }
    }
    extractDefs(specs)

    const raw = JSON.stringify(specs, null, 2)

    // Format through prettier so output is byte-identical to committed file
    // regardless of whether ./script/format.ts runs afterward.
    const prettier = await import("prettier")
    const babel = await import("prettier/plugins/babel")
    const estree = await import("prettier/plugins/estree")
    const format = prettier.format ?? prettier.default?.format
    const json = await format(raw, {
      parser: "json",
      plugins: [babel.default ?? babel, estree.default ?? estree],
      printWidth: 120,
    })

    // Wait for stdout to finish writing before process.exit() is called
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(json, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  },
} satisfies CommandModule
