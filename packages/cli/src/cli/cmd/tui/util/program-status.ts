/**
 * OSC 7501 Program Status Protocol reports — the working/idle indicator
 * iTerm2 (and other supporting terminals) draw in the tab bar.
 *
 * MiMo pins `@opentui/core@0.1.101`, which predates `renderer.setProgramStatus`,
 * so these reports are written to stdout directly. That is the same approach
 * `clipboard.ts` uses for OSC 52. Terminals that do not implement the protocol
 * ignore the sequence, so no capability probe is required.
 *
 * Wire format, mirroring opentui `packages/native/src/session.zig`:
 *
 *   ESC ] 7501 ; state=<state> [:id=<id>] [:kind=<kind>] [:progress=<0-100>]
 *                [:app=<app>] [:title=<base64>] [:msg=<base64>] ESC \
 *
 * `title` and `msg` carry base64; the other values are plain ASCII. An omitted
 * `id` addresses the root record. `clear` removes a record and its children.
 */

export type ProgramState = "idle" | "working" | "done" | "blocked" | "error" | "clear"
export type ProgramKind = "permission" | "question" | "auth"

export interface ProgramStatus {
  state: ProgramState
  /** 1-32 bytes of [A-Za-z0-9_.+-] per segment; omit to address the root record. */
  id?: string
  kind?: ProgramKind
  /** 0-100. */
  progress?: number
  app?: string
  title?: string
  message?: string
}

// Protocol bounds from opentui `session.zig`. An oversized field rejects the
// whole report, so clip before encoding rather than dropping the update silently.
const ID_BYTES_MAX = 128
const APP_BYTES_MAX = 32
const TITLE_BYTES_MAX = 192
const MESSAGE_BYTES_MAX = 2048

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function clip(input: string | undefined, bytes: number): string {
  const text = (input ?? "")
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!text) return ""
  const encoded = encoder.encode(text)
  if (encoded.byteLength <= bytes) return text
  // Leave room for the 3-byte ellipsis and drop any code point the byte cut split.
  return decoder.decode(encoded.subarray(0, bytes - 3)).replace(/\uFFFD+$/, "") + "\u2026"
}

export function encodeProgramStatus(status: ProgramStatus): string {
  let out = `\x1b]7501;state=${status.state}`
  const id = clip(status.id, ID_BYTES_MAX)
  if (id) out += `:id=${id}`
  if (status.kind) out += `:kind=${status.kind}`
  if (status.progress !== undefined) {
    out += `:progress=${Math.max(0, Math.min(100, Math.round(status.progress)))}`
  }
  const app = clip(status.app, APP_BYTES_MAX)
  if (app) out += `:app=${app}`
  const title = clip(status.title, TITLE_BYTES_MAX)
  if (title) out += `:title=${Buffer.from(title, "utf8").toString("base64")}`
  const message = clip(status.message, MESSAGE_BYTES_MAX)
  if (message) out += `:msg=${Buffer.from(message, "utf8").toString("base64")}`
  return out + "\x1b\\"
}

/** Writes one report to the terminal. No-op when stdout is not a TTY. */
export function reportProgramStatus(status: ProgramStatus): void {
  if (!process.stdout.isTTY) return
  process.stdout.write(encodeProgramStatus(status))
}

/** Removes the addressed record and every record beneath it. */
export function clearProgramStatus(id?: string): void {
  if (!process.stdout.isTTY) return
  process.stdout.write(encodeProgramStatus({ state: "clear", id }))
}
