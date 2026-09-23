import { describe, test, expect } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import z from "zod"
import path from "path"
import { fileURLToPath } from "url"
import { tmpdir } from "../fixture/fixture"
import { Agent } from "../../src/agent/agent"
import { Tool } from "../../src/tool"
import { Truncate } from "../../src/tool"

const runtime = ManagedRuntime.make(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer))

const params = z.object({ input: z.string() })

// Desktop engine-runtime [TP-R5-04]: a separately bundled plugin owns a different Zod registry.
test("tool JSON Schema preserves metadata from a separately bundled Zod instance", async () => {
  await using tmp = await tmpdir()
  const entry = path.join(tmp.path, "plugin.ts")
  await Bun.write(entry, `import z from ${JSON.stringify(fileURLToPath(import.meta.resolve("zod")))};
export default z.object({
  count: z.number().int().min(1).max(10).default(3).meta({ id: "Count", description: "Result count", examples: [3] }),
  nested: z.object({ label: z.string().describe("Nested label") }).describe("Options")
}).describe("Plugin arguments");`)
  const build = await Bun.build({ entrypoints: [entry], outdir: path.join(tmp.path, "bundle"), target: "bun" })
  expect(build.success).toBe(true)
  const foreign = (await import(build.outputs[0].path)).default as z.ZodObject<{
    count: z.ZodType
    nested: z.ZodType
  }>
  expect(z.globalRegistry.get(foreign.shape.count)).toBeUndefined()
  expect(z.toJSONSchema(foreign, { io: "input" }).description).toBeUndefined()
  const schema = Tool.jsonSchema(foreign, "input")
  expect(schema).toMatchObject({
    description: "Plugin arguments",
    required: ["nested"],
    properties: { nested: { description: "Options", properties: { label: { description: "Nested label" } } } },
    $defs: { Count: { description: "Result count", minimum: 1, maximum: 10, default: 3, examples: [3] } },
  })
  expect(z.globalRegistry.get(foreign.shape.count)).toBeUndefined()
})

function makeTool(id: string, executeFn?: () => void) {
  return {
    description: "test tool",
    parameters: params,
    execute() {
      executeFn?.()
      return Effect.succeed({ title: "test", output: "ok", metadata: {} })
    },
  }
}

describe("Tool.define", () => {
  test("object-defined tool does not mutate the original init object", async () => {
    const original = makeTool("test")
    const originalExecute = original.execute

    const info = await runtime.runPromise(Tool.define("test-tool", Effect.succeed(original)))

    await Effect.runPromise(info.init())
    await Effect.runPromise(info.init())
    await Effect.runPromise(info.init())

    expect(original.execute).toBe(originalExecute)
  })

  test("effect-defined tool returns fresh objects and is unaffected", async () => {
    const info = await runtime.runPromise(
      Tool.define(
        "test-fn-tool",
        Effect.succeed(() => Effect.succeed(makeTool("test"))),
      ),
    )

    const first = await Effect.runPromise(info.init())
    const second = await Effect.runPromise(info.init())

    expect(first).not.toBe(second)
  })

  test("object-defined tool returns distinct objects per init() call", async () => {
    const info = await runtime.runPromise(Tool.define("test-copy", Effect.succeed(makeTool("test"))))

    const first = await Effect.runPromise(info.init())
    const second = await Effect.runPromise(info.init())

    expect(first).not.toBe(second)
  })
})
