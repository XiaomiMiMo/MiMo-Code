import z from "zod"
import { Effect, Layer, Context } from "effect"
import { Bus } from "@/bus"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID } from "./schema"
import { boundPreview, type PreviewSummary, type DiffPreview } from "@/snapshot/preview"
import { readDiffCache, writeDiffCache } from "./diff-cache"

function unquoteGitPath(input: string) {
  if (!input.startsWith('"')) return input
  if (!input.endsWith('"')) return input
  const body = input.slice(1, -1)
  const bytes: number[] = []

  for (let i = 0; i < body.length; i++) {
    const char = body[i]!
    if (char !== "\\") {
      bytes.push(char.charCodeAt(0))
      continue
    }

    const next = body[i + 1]
    if (!next) {
      bytes.push("\\".charCodeAt(0))
      continue
    }

    if (next >= "0" && next <= "7") {
      const chunk = body.slice(i + 1, i + 4)
      const match = chunk.match(/^[0-7]{1,3}/)
      if (!match) {
        bytes.push(next.charCodeAt(0))
        i++
        continue
      }
      bytes.push(parseInt(match[0], 8))
      i += match[0].length
      continue
    }

    const escaped =
      next === "n"
        ? "\n"
        : next === "r"
          ? "\r"
          : next === "t"
            ? "\t"
            : next === "b"
              ? "\b"
              : next === "f"
                ? "\f"
                : next === "v"
                  ? "\v"
                  : next === "\\" || next === '"'
                    ? next
                    : undefined

    bytes.push((escaped ?? next).charCodeAt(0))
    i++
  }

  return Buffer.from(bytes).toString()
}

export interface Interface {
  readonly summarize: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<void>
  readonly diff: (input: { sessionID: SessionID; messageID?: MessageID }) => Effect.Effect<Snapshot.FileDiff[]>
  readonly computeDiff: (input: {
    messages: MessageV2.WithParts[]
    onSummary?: (summary: PreviewSummary) => void
  }) => Effect.Effect<Snapshot.FileDiff[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSummary") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snapshot = yield* Snapshot.Service
    const storage = yield* Storage.Service
    const bus = yield* Bus.Service

    const computeDiff = Effect.fn("SessionSummary.computeDiff")(function* (input: {
      messages: MessageV2.WithParts[]
      onSummary?: (summary: PreviewSummary) => void
    }) {
      let from: string | undefined
      let to: string | undefined
      for (const item of input.messages) {
        if (!from) {
          for (const part of item.parts) {
            if (part.type === "step-start" && part.snapshot) {
              from = part.snapshot
              break
            }
          }
        }
        for (const part of item.parts) {
          if (part.type === "step-finish" && part.snapshot) to = part.snapshot
        }
      }
      if (from && to) return yield* snapshot.diffFull(from, to, { onSummary: input.onSummary })
      return []
    })

    const summarize = Effect.fn("SessionSummary.summarize")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      const all = yield* sessions.messages({ sessionID: input.sessionID, agentID: "main" })
      if (!all.length) return

      let total: PreviewSummary | undefined
      const diffs = yield* computeDiff({
        messages: all,
        onSummary: (summary) => {
          total = summary
        },
      })
      const preview = boundPreview(diffs, total)
      yield* sessions.setSummary({
        sessionID: input.sessionID,
        summary: {
          additions: preview.summary.additions,
          deletions: preview.summary.deletions,
          files: preview.summary.files,
        },
      })
      yield* writeDiffCache(storage, input.sessionID, preview)
      yield* bus.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: preview.diffs })

      const messages = all.filter(
        (m) => m.info.id === input.messageID || (m.info.role === "assistant" && m.info.parentID === input.messageID),
      )
      const target = messages.find((m) => m.info.id === input.messageID)
      if (!target || target.info.role !== "user") return
      let msgTotal: PreviewSummary | undefined
      const msgDiffs = yield* computeDiff({
        messages,
        onSummary: (summary) => {
          msgTotal = summary
        },
      })
      const msgPreview = boundPreview(msgDiffs, msgTotal)
      target.info.summary = { ...target.info.summary, diffs: msgPreview.diffs, preview: msgPreview.summary }
      yield* sessions.updateMessage(target.info)
    })

    const diff = Effect.fn("SessionSummary.diff")(function* (input: { sessionID: SessionID; messageID?: MessageID }) {
      if (input.messageID) {
        const all = yield* sessions.messages({ sessionID: input.sessionID, agentID: "*" })
        const target = all.find((item) => item.info.id === input.messageID)
        if (!target || target.info.role !== "user") return []
        if (target.info.summary?.diffs && !target.info.summary.diffTruncated) {
          const legacy = !target.info.summary.preview
          const rows = legacy
            ? target.info.summary.diffs.map((item) => ({ ...item, file: unquoteGitPath(item.file) }))
            : target.info.summary.diffs
          const preview = boundPreview(rows, target.info.summary.preview)
          if (legacy) {
            target.info.summary = { ...target.info.summary, diffs: preview.diffs, preview: preview.summary }
            yield* sessions.updateMessage(target.info)
          }
          return preview.diffs
        }
        let total: PreviewSummary | undefined
        const diffs = yield* computeDiff({
          messages: all.filter(
            (item) =>
              item.info.id === input.messageID ||
              (item.info.role === "assistant" && item.info.parentID === input.messageID),
          ),
          onSummary: (summary) => {
            total = summary
          },
        })
        const preview = boundPreview(diffs, total)
        target.info.summary = {
          ...target.info.summary,
          diffs: preview.diffs,
          preview: preview.summary,
          diffTruncated: false,
        }
        yield* sessions.updateMessage(target.info)
        return preview.diffs
      }
      let preview: (DiffPreview & { legacy?: boolean }) | undefined = yield* readDiffCache(storage, input.sessionID)
      const rebuild = !preview
      if (!preview) {
        // Caches are derived data. Rebuild from recorded snapshots, never from
        // today's working tree: cleaning a repository must not erase history.
        let total: PreviewSummary | undefined
        const all = yield* sessions.messages({ sessionID: input.sessionID, agentID: "main" })
        const diffs = yield* computeDiff({
          messages: all,
          onSummary: (summary) => {
            total = summary
          },
        })
        preview = boundPreview(diffs, total)
      }
      if (preview.legacy) preview.diffs = preview.diffs.map((item) => ({ ...item, file: unquoteGitPath(item.file) }))
      if (rebuild || preview.legacy) {
        yield* sessions.setSummary({
          sessionID: input.sessionID,
          summary: {
            files: preview.summary.files,
            additions: preview.summary.additions,
            deletions: preview.summary.deletions,
          },
        })
        yield* writeDiffCache(storage, input.sessionID, preview)
      }
      return preview.diffs
    })

    return Service.of({ summarize, diff, computeDiff })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(Storage.defaultLayer),
    Layer.provide(Bus.layer),
  ),
)

export const DiffInput = z.object({
  sessionID: SessionID.zod,
  messageID: MessageID.zod.optional(),
})

export * as SessionSummary from "./summary"
