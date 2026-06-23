import z from "zod"
import * as path from "path"
import { Effect } from "effect"
import { createTwoFilesPatch } from "diff"
import * as Tool from "./tool"
import DESCRIPTION from "./notebook-edit.txt"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Bus } from "../bus"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { Instance } from "../project/instance"
import { SessionCwd } from "./session-cwd"
import { assertWriteAllowed, askEditUnlessMemory } from "./external-directory"
import { assertFileRead } from "./read-state"
import { trimDiff } from "./edit"

const Parameters = z.object({
  notebookPath: z.string().describe("The absolute path to the .ipynb file to modify"),
  cellId: z
    .string()
    .optional()
    .describe(
      "Cell id from the Read tool's <cell id=\"...\"> output. Required for replace/delete; for insert, the new cell is added after this cell (or at the beginning if omitted).",
    ),
  newSource: z.string().optional().describe("The cell's new content. Required for replace and insert; ignored for delete."),
  cellType: z
    .enum(["code", "markdown"])
    .optional()
    .describe("Cell type. Required for insert; for replace, defaults to the existing cell's type."),
  editMode: z
    .enum(["replace", "insert", "delete"])
    .optional()
    .describe("Operation to perform. Defaults to replace."),
})

type NotebookCell = {
  cell_type: "code" | "markdown" | "raw"
  id?: string
  source: string | string[]
  metadata?: Record<string, unknown>
  outputs?: unknown[]
  execution_count?: number | null
}

type Notebook = {
  cells: NotebookCell[]
  metadata?: Record<string, unknown>
  nbformat?: number
  nbformat_minor?: number
}

function stringToCellSource(content: string): string[] {
  if (content === "") return []
  const lines = content.split("\n")
  return lines.map((line, i) => (i < lines.length - 1 ? line + "\n" : line)).filter((line) => line !== "")
}

function generateCellId(existing: Set<string>): string {
  for (let i = 0; i < 1000; i++) {
    const id = crypto.randomUUID().slice(0, 8)
    if (!existing.has(id)) return id
  }
  return crypto.randomUUID()
}

function buildCell(cellType: "code" | "markdown", source: string, id: string): NotebookCell {
  const sourceLines = stringToCellSource(source)
  if (cellType === "code") {
    return {
      cell_type: "code",
      id,
      source: sourceLines,
      metadata: {},
      outputs: [],
      execution_count: null,
    }
  }
  return {
    cell_type: "markdown",
    id,
    source: sourceLines,
    metadata: {},
  }
}

export const NotebookEditTool = Tool.define(
  "notebook_edit",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const bus = yield* Bus.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const editMode = params.editMode ?? "replace"

          if (!params.notebookPath) throw new Error("notebookPath is required")
          if (path.extname(params.notebookPath) !== ".ipynb") {
            throw new Error("notebookPath must point to a .ipynb file")
          }

          const notebookPath = path.isAbsolute(params.notebookPath)
            ? params.notebookPath
            : path.join(SessionCwd.get(ctx.sessionID), params.notebookPath)

          if (editMode !== "insert" && !params.cellId) {
            throw new Error(`cellId is required when editMode is "${editMode}"`)
          }
          if ((editMode === "replace" || editMode === "insert") && params.newSource === undefined) {
            throw new Error(`newSource is required when editMode is "${editMode}"`)
          }
          if (editMode === "insert" && !params.cellType) {
            throw new Error('cellType is required when editMode is "insert"')
          }

          yield* assertWriteAllowed(ctx, notebookPath)
          assertFileRead(ctx, notebookPath, "notebook_edit")

          const exists = yield* fs.existsSafe(notebookPath)
          if (!exists) throw new Error(`Notebook not found: ${notebookPath}`)

          const contentOld = yield* fs.readFileString(notebookPath)
          const notebook = ((): Notebook => {
            try {
              return JSON.parse(contentOld) as Notebook
            } catch (err) {
              throw new Error(`Failed to parse notebook JSON: ${(err as Error).message}`)
            }
          })()

          if (!Array.isArray(notebook.cells)) {
            throw new Error("Notebook is missing a `cells` array — file does not look like a valid Jupyter notebook")
          }

          // Older notebooks (nbformat_minor < 5) have no cell ids. Backfill UUIDs
          // for any cell missing one so cellId lookup is stable, and bump
          // nbformat_minor to 5 to match what Jupyter does on save.
          const existingIds = new Set<string>()
          for (const cell of notebook.cells) if (cell.id) existingIds.add(cell.id)
          let backfilled = false
          for (const cell of notebook.cells) {
            if (cell.id) continue
            const id = generateCellId(existingIds)
            cell.id = id
            existingIds.add(id)
            backfilled = true
          }
          if (backfilled && (notebook.nbformat_minor ?? 0) < 5) {
            notebook.nbformat_minor = 5
          }

          // Accept either the real cell id or a positional reference like "#0".
          const findIndex = (ref: string) => {
            if (ref.startsWith("#")) {
              const idx = Number.parseInt(ref.slice(1), 10)
              if (Number.isInteger(idx) && idx >= 0 && idx < notebook.cells.length) return idx
              return -1
            }
            return notebook.cells.findIndex((c) => c.id === ref)
          }
          const cellNotFound = (ref: string) => {
            const ids = notebook.cells.map((c, i) => c.id ?? `#${i}`).join(", ")
            return new Error(`Cell not found: ${ref}. Available cells: ${ids || "(none)"}`)
          }

          let title = ""

          if (editMode === "replace") {
            const idx = findIndex(params.cellId!)
            if (idx === -1) throw cellNotFound(params.cellId!)
            const target = notebook.cells[idx]
            const nextType = params.cellType ?? (target.cell_type === "raw" ? "code" : target.cell_type)
            const replaced = buildCell(nextType, params.newSource ?? "", target.id ?? params.cellId!)
            if (target.cell_type === "code" && nextType === "code") {
              replaced.outputs = target.outputs ?? []
              replaced.execution_count = target.execution_count ?? null
              replaced.metadata = target.metadata ?? {}
            } else {
              replaced.metadata = target.metadata ?? {}
            }
            notebook.cells[idx] = replaced
            title = `replace cell ${target.id ?? `#${idx}`}`
          } else if (editMode === "delete") {
            const idx = findIndex(params.cellId!)
            if (idx === -1) throw cellNotFound(params.cellId!)
            notebook.cells.splice(idx, 1)
            title = `delete cell ${params.cellId}`
          } else {
            // insert
            const newId = generateCellId(existingIds)
            const cell = buildCell(params.cellType!, params.newSource ?? "", newId)
            if (!params.cellId) {
              notebook.cells.unshift(cell)
              title = `insert cell at start`
            } else {
              const idx = findIndex(params.cellId)
              if (idx === -1) throw cellNotFound(params.cellId)
              notebook.cells.splice(idx + 1, 0, cell)
              title = `insert cell after ${params.cellId}`
            }
          }

          const contentNew = JSON.stringify(notebook, null, 1) + (contentOld.endsWith("\n") ? "\n" : "")

          const diff = trimDiff(createTwoFilesPatch(notebookPath, notebookPath, contentOld, contentNew))
          yield* askEditUnlessMemory(ctx, notebookPath, {
            patterns: [path.relative(Instance.worktree, notebookPath)],
            diff,
          })

          yield* fs.writeWithDirs(notebookPath, contentNew)
          yield* bus.publish(File.Event.Edited, { file: notebookPath })
          yield* bus.publish(FileWatcher.Event.Updated, { file: notebookPath, event: "change" })

          return {
            title: `${path.relative(Instance.worktree, notebookPath)} — ${title}`,
            metadata: { diff, editMode, cellId: params.cellId },
            output: `Notebook updated: ${editMode} on ${path.relative(Instance.worktree, notebookPath)}.`,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
