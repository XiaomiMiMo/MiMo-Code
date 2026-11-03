import { afterAll, afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { applyPatch, parsePatch, reversePatch } from "diff"
import { Effect, Layer, ManagedRuntime } from "effect"
import { EditTool } from "../../src/tool/edit"
import { WriteTool } from "../../src/tool/write"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { NotebookEditTool } from "../../src/tool/notebook-edit"
import { Instance } from "../../src/project/instance"
import { LSP } from "../../src/lsp"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Tool, Truncate } from "../../src/tool"
import { SessionID, MessageID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

// Published diffs are data: downstreams reverse them to undo and rebuild turn
// diffs. These tests pin that every diff a file tool publishes applies to the
// file's previous content and yields exactly what is on disk afterwards.

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    LSP.defaultLayer,
    AppFileSystem.defaultLayer,
    Format.defaultLayer,
    Bus.layer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
  ),
)

afterEach(async () => {
  await Instance.disposeAll()
})

afterAll(async () => {
  await runtime.dispose()
})

type AskInput = Parameters<Tool.Context["ask"]>[0]

function makeCtx() {
  const asked: AskInput[] = []
  const ctx: Tool.Context = {
    sessionID: SessionID.make("ses_test-applyable-diff"),
    messageID: MessageID.make(""),
    callID: "",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (input) =>
      Effect.sync(() => {
        asked.push(input)
      }),
  }
  return { asked, ctx }
}

const edit = async (args: Tool.InferParameters<typeof EditTool>, ctx: Tool.Context) => {
  const tool = await runtime.runPromise(Effect.flatMap(EditTool, (info) => info.init()))
  return Effect.runPromise(tool.execute(args, ctx))
}

const write = async (args: Tool.InferParameters<typeof WriteTool>, ctx: Tool.Context) => {
  const tool = await runtime.runPromise(Effect.flatMap(WriteTool, (info) => info.init()))
  return Effect.runPromise(tool.execute(args, ctx))
}

const applyPatchTool = async (args: Tool.InferParameters<typeof ApplyPatchTool>, ctx: Tool.Context) => {
  const tool = await runtime.runPromise(Effect.flatMap(ApplyPatchTool, (info) => info.init()))
  return Effect.runPromise(tool.execute(args, ctx))
}

const notebookEdit = async (args: Tool.InferParameters<typeof NotebookEditTool>, ctx: Tool.Context) => {
  const tool = await runtime.runPromise(Effect.flatMap(NotebookEditTool, (info) => info.init()))
  return Effect.runPromise(tool.execute(args, ctx))
}

// Every hunk line, context included, sits inside an indented block, so a
// diff that strips common indentation no longer matches the file.
function indentedSource(changed?: { index: number; value: string }) {
  const body = Array.from({ length: 20 }, (_, index) => {
    const value = changed?.index === index ? changed.value : String(index)
    return `      const v${index} = ${value}`
  })
  return ["export function f(x: boolean) {", "  if (x) {", "    {", ...body, "    }", "  }", "}", ""].join("\n")
}

const uppercaseFormatter = {
  formatter: {
    uppercase: {
      command: [
        process.execPath,
        "-e",
        "const fs = require('fs'); const file = process.argv.at(-1); fs.writeFileSync(file, fs.readFileSync(file, 'utf8').toUpperCase())",
        "$FILE",
      ],
      extensions: [".fmt"],
    },
  },
}

function expectApplies(before: string, diff: unknown, after: string) {
  if (typeof diff !== "string") throw new Error(`expected a diff string, got ${typeof diff}`)
  expect(applyPatch(before, diff)).toBe(after)
}

function reverseAll(content: string, diffs: string[]) {
  return diffs.toReversed().reduce<string | false>((current, diff) => {
    return parsePatch(diff)
      .toReversed()
      .reduce<string | false>(
        (next, patch) => (next === false ? false : applyPatch(next, reversePatch(patch))),
        current,
      )
  }, content)
}

describe("file tools publish applyable diffs", () => {
  test("edit inside an indented block", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "deep.ts")
    const before = indentedSource()
    await fs.writeFile(file, before, "utf-8")
    const { ctx, asked } = makeCtx()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await edit({ file_path: file, old_string: "const v10 = 10", new_string: "const v10 = 100" }, ctx)
        const after = await fs.readFile(file, "utf-8")
        expect(after).toBe(indentedSource({ index: 10, value: "100" }))
        expectApplies(before, result.metadata.diff, after)
        expectApplies(before, result.metadata.filediff.patch, after)
        expectApplies(before, asked[0]?.metadata.diff, after)
      },
    })
  })

  test("two edits to one indented file reverse back to the original", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "deep.ts")
    const original = indentedSource()
    await fs.writeFile(file, original, "utf-8")
    const { ctx } = makeCtx()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const first = await edit({ file_path: file, old_string: "const v5 = 5", new_string: "const v5 = 50" }, ctx)
        const second = await edit({ file_path: file, old_string: "const v14 = 14", new_string: "const v14 = 140" }, ctx)
        const current = await fs.readFile(file, "utf-8")
        expect(reverseAll(current, [first.metadata.diff, second.metadata.diff])).toBe(original)
      },
    })
  })

  test("write overwriting an indented file", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "deep.ts")
    const before = indentedSource()
    const requested = indentedSource({ index: 10, value: "100" })
    await fs.writeFile(file, before, "utf-8")
    const { ctx, asked } = makeCtx()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await write({ file_path: file, content: requested }, ctx)
        const after = await fs.readFile(file, "utf-8")
        expect(after).toBe(requested)
        expectApplies(before, result.metadata.diff, after)
        expectApplies(before, asked[0]?.metadata.diff, requested)
      },
    })
  })

  test("write diff reflects the formatted file", async () => {
    await using tmp = await tmpdir({ config: uppercaseFormatter })
    const file = path.join(tmp.path, "note.fmt")
    const before = "first line\n"
    await fs.writeFile(file, before, "utf-8")
    const { ctx, asked } = makeCtx()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const requested = "first line\nsecond line\n"
        const result = await write({ file_path: file, content: requested }, ctx)
        const after = await fs.readFile(file, "utf-8")
        expect(after).toBe("FIRST LINE\nSECOND LINE\n")
        expectApplies(before, result.metadata.diff, after)
        // The prompt shows what the model asked for; formatting has not run yet.
        expectApplies(before, asked[0]?.metadata.diff, requested)
      },
    })
  })

  test("edit diff reflects the formatted file", async () => {
    await using tmp = await tmpdir({ config: uppercaseFormatter })
    const file = path.join(tmp.path, "note.fmt")
    const before = "FIRST LINE\n"
    await fs.writeFile(file, before, "utf-8")
    const { ctx } = makeCtx()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await edit({ file_path: file, old_string: "FIRST LINE", new_string: "first line" }, ctx)
        const after = await fs.readFile(file, "utf-8")
        expect(after).toBe("FIRST LINE\n")
        expectApplies(before, result.metadata.diff, after)
      },
    })
  })

  test("edit with empty old_string overwriting an existing file", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "deep.ts")
    const before = indentedSource()
    const requested = indentedSource({ index: 3, value: "30" })
    await fs.writeFile(file, before, "utf-8")
    const { ctx, asked } = makeCtx()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await edit({ file_path: file, old_string: "", new_string: requested }, ctx)
        const after = await fs.readFile(file, "utf-8")
        expect(after).toBe(requested)
        expect(result.metadata.diff).not.toContain("@@ -0,0 ")
        expectApplies(before, result.metadata.diff, after)
        expectApplies(before, result.metadata.filediff.patch, after)
        expectApplies(before, asked[0]?.metadata.diff, requested)
      },
    })
  })

  test("edit with empty old_string reflects the formatted file", async () => {
    await using tmp = await tmpdir({ config: uppercaseFormatter })
    const file = path.join(tmp.path, "note.fmt")
    const { ctx } = makeCtx()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await edit({ file_path: file, old_string: "", new_string: "created\n" }, ctx)
        const after = await fs.readFile(file, "utf-8")
        expect(after).toBe("CREATED\n")
        expectApplies("", result.metadata.diff, after)
      },
    })
  })

  test("edit with empty old_string keeps line-ending changes in the diff", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "crlf.txt")
    const before = "alpha\r\nbeta\r\n"
    await fs.writeFile(file, before, "utf-8")
    const { ctx } = makeCtx()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await edit({ file_path: file, old_string: "", new_string: "alpha\nbeta\n" }, ctx)
        const after = await fs.readFile(file, "utf-8")
        expect(after).toBe("alpha\nbeta\n")
        expectApplies(before, result.metadata.diff, after)
        expectApplies(before, result.metadata.filediff.patch, after)
      },
    })
  })

  test("apply_patch add, update and delete", async () => {
    await using tmp = await tmpdir({ git: true })
    const updated = path.join(tmp.path, "deep.ts")
    const removed = path.join(tmp.path, "old.ts")
    const before = indentedSource()
    const removedBefore = indentedSource({ index: 1, value: "11" })
    await fs.writeFile(updated, before, "utf-8")
    await fs.writeFile(removed, removedBefore, "utf-8")
    const { ctx } = makeCtx()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const patchText = [
          "*** Begin Patch",
          "*** Add File: added.ts",
          "+    indented()",
          "*** Delete File: old.ts",
          "*** Update File: deep.ts",
          "@@",
          "-      const v10 = 10",
          "+      const v10 = 100",
          "*** End Patch",
        ].join("\n")
        const result = await applyPatchTool({ patch_text: patchText }, ctx)
        const patches = new Map(result.metadata.files.map((file) => [file.relativePath, file.patch]))
        expectApplies("", patches.get("added.ts"), await fs.readFile(path.join(tmp.path, "added.ts"), "utf-8"))
        expectApplies(removedBefore, patches.get("old.ts"), "")
        expectApplies(before, patches.get("deep.ts"), await fs.readFile(updated, "utf-8"))
      },
    })
  })

  test("apply_patch update inside an indented block", async () => {
    await using tmp = await tmpdir({ git: true })
    const file = path.join(tmp.path, "deep.ts")
    const before = indentedSource()
    await fs.writeFile(file, before, "utf-8")
    const { ctx, asked } = makeCtx()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const patchText = [
          "*** Begin Patch",
          "*** Update File: deep.ts",
          "@@",
          "-      const v10 = 10",
          "+      const v10 = 100",
          "*** End Patch",
        ].join("\n")
        const result = await applyPatchTool({ patch_text: patchText }, ctx)
        const after = await fs.readFile(file, "utf-8")
        expect(after).toBe(indentedSource({ index: 10, value: "100" }))
        expectApplies(before, result.metadata.diff, after)
        expectApplies(before, result.metadata.files[0]?.patch, after)
        expectApplies(before, asked[0]?.metadata.diff, after)
      },
    })
  })

  test("notebook-edit replacing a cell", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "demo.ipynb")
    const notebook = (source: string[]) =>
      JSON.stringify(
        {
          cells: [{ cell_type: "code", id: "cell-a", source, metadata: {}, outputs: [], execution_count: null }],
          metadata: {},
          nbformat: 4,
          nbformat_minor: 5,
        },
        null,
        1,
      ) + "\n"
    const before = notebook(Array.from({ length: 12 }, (_, index) => `x${index} = ${index}\n`))
    await fs.writeFile(file, before, "utf-8")
    const { ctx } = makeCtx()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const source = Array.from({ length: 12 }, (_, index) => `x${index} = ${index === 6 ? 60 : index}`).join("\n")
        const result = await notebookEdit(
          { notebook_path: file, cell_id: "cell-a", new_source: source, edit_mode: "replace" },
          ctx,
        )
        const after = await fs.readFile(file, "utf-8")
        expect(after).not.toBe(before)
        expectApplies(before, result.metadata.diff, after)
      },
    })
  })
})
