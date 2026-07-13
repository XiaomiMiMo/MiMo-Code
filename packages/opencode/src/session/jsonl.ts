import { createReadStream } from "fs"

// Multi-GB external transcripts (~/.claude/projects, ~/.codex/sessions) cannot be
// read with readFile + split("\n"): a single oversized file exceeds the JS string
// length limit and aborts the process natively, which no try/catch can recover
// (issue #1671). Importers stream lines instead and skip files over a size budget.

/**
 * Stream a file's lines without materializing the whole file in memory.
 * Lines are yielded verbatim (no trimming); a trailing newline does not
 * produce a final empty line, matching String.split("\n") on "a\nb" vs "a\nb\n"
 * only in that the phantom last "" is dropped — callers already filter blank lines.
 */
export async function* lines(file: string): AsyncGenerator<string> {
  // The utf8 encoding makes the stream decode statefully, so multi-byte
  // characters are never split across chunk boundaries.
  const stream = createReadStream(file, { encoding: "utf8" })
  try {
    let buffer = ""
    for await (const chunk of stream) {
      buffer += chunk
      let newline = buffer.indexOf("\n")
      while (newline !== -1) {
        yield buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf("\n")
      }
    }
    if (buffer) yield buffer
  } finally {
    stream.destroy()
  }
}

export const DEFAULT_MAX_IMPORT_FILE_BYTES = 512 * 1024 * 1024

/**
 * Per-file size budget for external session imports, in bytes.
 * Override with MIMOCODE_IMPORT_MAX_FILE_BYTES; 0 disables the guard.
 * The parsed messages of one transcript are still held in memory for a single
 * DB transaction, so the guard is what keeps a pathological file from
 * exhausting memory even with streaming reads.
 */
export function maxImportFileBytes(value: string | undefined = process.env["MIMOCODE_IMPORT_MAX_FILE_BYTES"]): number {
  if (value === undefined || value.trim() === "") return DEFAULT_MAX_IMPORT_FILE_BYTES
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MAX_IMPORT_FILE_BYTES
  return Math.floor(parsed)
}

export * as Jsonl from "./jsonl"
