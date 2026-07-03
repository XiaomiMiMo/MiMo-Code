import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import path from "path"
import { LSP } from "../lsp"
import DESCRIPTION from "./lsp.txt"
import { Instance } from "../project/instance"
import { pathToFileURL } from "url"
import { assertExternalDirectoryEffect } from "./external-directory"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"

const SEND_REQUEST_WHITELIST = new Set([
  "textDocument/codeAction",
  "textDocument/completion",
  "textDocument/signatureHelp",
  "textDocument/foldingRange",
  "textDocument/documentLink",
  "textDocument/semanticTokens/full",
  "textDocument/semanticTokens/range",
  "textDocument/semanticTokens/full/delta",
  "textDocument/declaration",
  "textDocument/typeDefinition",
])

const operations = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
  "sendRequest",
] as const

const parameters = z.object({
  operation: z.enum(operations).describe("The LSP operation to perform"),
  file_path: z.string().optional().describe("The absolute or relative path to the file (required for all operations except workspaceSymbol)"),
  line: z.number().int().min(1).optional().describe("The line number (1-based, as shown in editors)"),
  character: z.number().int().min(1).optional().describe("The character offset (1-based, as shown in editors)"),
  method: z.string().optional().describe("The LSP method name for sendRequest (e.g. \"textDocument/codeAction\")"),
  params: z.record(z.string(), z.unknown()).optional().describe("The parameters for the LSP method when using sendRequest"),
  query: z.string().optional().describe("The symbol name or partial name to search for (workspaceSymbol only)"),
})

export const LspTool = Tool.define(
  "lsp",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters,
      execute: (
        args: z.infer<typeof parameters>,
        ctx: Tool.Context,
      ) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "lsp", patterns: ["*"], always: ["*"], metadata: {} })

          // workspaceSymbol searches across all LSP clients and doesn't need a file
          if (args.operation === "workspaceSymbol") {
            const result = yield* lsp.workspaceSymbol(args.query || "")
            return {
              title: `workspaceSymbol ${args.query || ""}`,
              metadata: { result },
              output: result.length === 0 ? "No results found for workspaceSymbol" : JSON.stringify(result, null, 2),
            }
          }

          if (!args.file_path) throw new Error("file_path is required for this operation")

          const file = path.isAbsolute(args.file_path) ? args.file_path : path.join(Instance.directory, args.file_path)
          yield* assertExternalDirectoryEffect(ctx, file)

          const line = args.line ?? 1
          const character = args.character ?? 1
          const position = { file, line: line - 1, character: character - 1 }
          const relativePath = path.relative(Instance.worktree, file)
          const title =
            args.operation === "sendRequest"
              ? `${args.operation} ${relativePath} ${args.method ?? ""}`
              : `${args.operation} ${relativePath}:${line}:${character}`

          if (!(yield* fs.existsSafe(file))) throw new Error(`File not found: ${file}`)
          if (!(yield* lsp.hasClients(file))) throw new Error("No LSP server available for this file type.")

          yield* lsp.touchFile(file, true)

          const ops = {
            goToDefinition: () => lsp.definition(position),
            findReferences: () => lsp.references(position),
            hover: () => lsp.hover(position),
            documentSymbol: () => lsp.documentSymbol(pathToFileURL(file).href),
            sendRequest: () => {
              const method = args.method ?? ""
              if (!SEND_REQUEST_WHITELIST.has(method)) {
                throw new Error(`Method "${method}" is not in the sendRequest read-only whitelist`)
              }
              return lsp.sendRequest(file, method, args.params ?? {})
            },
            goToImplementation: () => lsp.implementation(position),
            prepareCallHierarchy: () => lsp.prepareCallHierarchy(position),
            incomingCalls: () => lsp.incomingCalls(position),
            outgoingCalls: () => lsp.outgoingCalls(position),
          }
          const result: unknown = yield* ops[args.operation]()

          const output =
            Array.isArray(result) && result.length === 0
              ? `No results found for ${args.operation}`
              : JSON.stringify(result, null, 2)

          return {
            title,
            metadata: { result },
            output,
          }
        }),
    }
  }),
)
