import { isRecord } from "@/util/record"
import type { MessageV2 } from "@/session/message-v2"

/**
 * A tool execution error that carries metadata to the persisted error state.
 * The structural fallback keeps the metadata available across runtime or realm
 * boundaries where `instanceof` is not reliable.
 */
export class ToolResultError extends Error {
  readonly toolResultMetadata: Record<string, unknown>
  readonly toolResultAttachments: MessageV2.FilePart[]

  constructor(
    message: string,
    metadata: Record<string, unknown>,
    attachments: MessageV2.FilePart[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "ToolResultError"
    this.toolResultMetadata = metadata
    this.toolResultAttachments = attachments
  }
}

export function getToolResultMetadata(error: unknown): Record<string, unknown> | undefined {
  if (error instanceof ToolResultError) return error.toolResultMetadata
  if (!isRecord(error) || !isRecord(error.toolResultMetadata)) return undefined
  return error.toolResultMetadata
}

export function getToolResultAttachments(error: unknown): readonly unknown[] | undefined {
  if (error instanceof ToolResultError) return error.toolResultAttachments
  if (!isRecord(error) || !Array.isArray(error.toolResultAttachments)) return undefined
  return error.toolResultAttachments
}
