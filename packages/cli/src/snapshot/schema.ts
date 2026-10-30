import z from "zod"

export const FileDiff = z
  .object({
    file: z.string(),
    patch: z.string(),
    additions: z.number(),
    deletions: z.number(),
    status: z.enum(["added", "deleted", "modified"]).optional(),
    patchOmitted: z.boolean().optional(),
  })
  .meta({
    ref: "SnapshotFileDiff",
  })
export type FileDiff = z.infer<typeof FileDiff>

export const PreviewStats = z.object({
  files: z.number(),
  additions: z.number(),
  deletions: z.number(),
  omittedFiles: z.number(),
  omittedPatches: z.number(),
})

export type PreviewSummary = z.infer<typeof PreviewStats>
