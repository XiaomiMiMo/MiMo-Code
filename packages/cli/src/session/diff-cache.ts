import { Effect } from "effect"
import { Storage } from "@/storage"
import type { FileDiff } from "@/snapshot"
import { boundPreview, PreviewLimits, type DiffPreview } from "@/snapshot/preview"
import type { SessionID } from "./schema"

export const readDiffCache = (storage: Storage.Interface, sessionID: SessionID) =>
  storage.read<FileDiff[] | DiffPreview>(["session_diff", sessionID], { maxBytes: PreviewLimits.payload }).pipe(
    Effect.flatMap((value) =>
      Effect.try({
        try: () => {
          const legacy = Array.isArray(value)
          return { ...(legacy ? boundPreview(value) : boundPreview(value.diffs, value.summary)), legacy }
        },
        catch: (cause) => new Error("Invalid diff cache", { cause }),
      }),
    ),
    Effect.catch(() => Effect.succeed(undefined)),
  )

export const writeDiffCache = (storage: Storage.Interface, sessionID: SessionID, value: DiffPreview) =>
  storage
    .write(["session_diff", sessionID], boundPreview(value.diffs, value.summary), { compact: true })
    .pipe(Effect.ignore)
