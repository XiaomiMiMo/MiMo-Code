import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import fs from "fs/promises"
import { NotebookEditTool } from "../../src/tool/notebook-edit"
import { LSP } from "../../src/lsp"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Bus } from "../../src/bus"
import { Format } from "../../src/format"
import { Truncate } from "../../src/tool"
import { Agent } from "../../src/agent/agent"
import { SessionID, MessageID } from "../../src/session/schema"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const baseCtx = {
  sessionID: SessionID.make("ses_test-notebook-edit-session"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const it = testEffect(
  Layer.mergeAll(
    LSP.defaultLayer,
    AppFileSystem.defaultLayer,
    Bus.layer,
    Format.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
  ),
)

describe("tool.notebook_edit", () => {
  it.live("replaces a cell without a prior read tool call in the conversation", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const notebookPath = path.join(dir, "demo.ipynb")
        yield* Effect.promise(() =>
          fs.writeFile(
            notebookPath,
            JSON.stringify(
              {
                cells: [
                  {
                    cell_type: "code",
                    id: "cell-a",
                    source: ["print(1)\n"],
                    metadata: {},
                    outputs: [],
                    execution_count: null,
                  },
                ],
                metadata: {},
                nbformat: 4,
                nbformat_minor: 5,
              },
              null,
              1,
            ),
            "utf-8",
          ),
        )

        const info = yield* NotebookEditTool
        const notebookEdit = yield* info.init()
        const result = yield* notebookEdit.execute(
          {
            notebook_path: notebookPath,
            cell_id: "cell-a",
            new_source: "print(2)\n",
            edit_mode: "replace",
          },
          baseCtx,
        )

        expect(result.output).toContain("Notebook updated")
        const notebook = JSON.parse(yield* Effect.promise(() => fs.readFile(notebookPath, "utf-8")))
        expect(notebook.cells[0].source).toEqual(["print(2)\n"])
        expect(notebook.cells[0].id).toBe("cell-a")
      }),
    ),
  )
})
