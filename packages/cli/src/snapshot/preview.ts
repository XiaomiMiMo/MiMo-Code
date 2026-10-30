import { formatPatch, structuredPatch } from "diff"
import type { FileDiff, PreviewSummary } from "./schema"
export type { PreviewSummary } from "./schema"

export const PreviewLimits = {
  files: 500,
  source: 256 * 1024,
  patch: 64 * 1024,
  patches: 1024 * 1024,
  payload: 2 * 1024 * 1024,
  batch: 1024 * 1024,
} as const

export interface DiffPreview {
  diffs: FileDiff[]
  summary: PreviewSummary
}

export function emptyPreview(): DiffPreview {
  return { diffs: [], summary: { files: 0, additions: 0, deletions: 0, omittedFiles: 0, omittedPatches: 0 } }
}

/** Count every file, retaining only a bounded, deterministic preview. */
export class PreviewBuilder {
  readonly value = emptyPreview()
  private bytes = 2
  private patches = 0

  add(item: FileDiff) {
    const summary = this.value.summary
    summary.files++
    summary.additions += item.additions
    summary.deletions += item.deletions
    if (this.value.diffs.length >= PreviewLimits.files) {
      summary.omittedFiles++
      return undefined
    }
    const size = Buffer.byteLength(JSON.stringify(item)) + 1
    if (this.bytes + size > PreviewLimits.payload - 1024) {
      summary.omittedFiles++
      return undefined
    }
    this.bytes += size
    this.value.diffs.push(item)
    return item
  }

  patch(item: FileDiff, before?: string, after?: string) {
    const omit = () => {
      item.patchOmitted = true
      this.value.summary.omittedPatches++
      this.bytes += 20
    }
    if (before === undefined || after === undefined || this.patches >= PreviewLimits.patches) return omit()
    const value = structuredPatch(item.file, item.file, before, after, "", "", {
      context: 3,
      timeout: 100,
      maxEditLength: 10_000,
    })
    if (!value) return omit()
    const patch = formatPatch(value)
    const bytes = Buffer.byteLength(patch)
    const encoded = Buffer.byteLength(JSON.stringify(patch)) - 2
    if (
      bytes > PreviewLimits.patch ||
      this.patches + bytes > PreviewLimits.patches ||
      this.bytes + encoded > PreviewLimits.payload - 1024
    )
      return omit()
    item.patch = patch
    this.patches += bytes
    this.bytes += encoded
  }
}

/** Legacy arrays may fit on disk but still exceed the current row/patch limits. */
export function boundPreview(diffs: FileDiff[], summary?: PreviewSummary): DiffPreview {
  const value = emptyPreview()
  let bytes = 512 // reserve envelope and aggregate metadata
  let patches = 0
  for (const diff of diffs) {
    value.summary.files++
    value.summary.additions += diff.additions
    value.summary.deletions += diff.deletions
    if (value.diffs.length >= PreviewLimits.files) {
      value.summary.omittedFiles++
      continue
    }
    const item = { ...diff }
    const patchBytes = Buffer.byteLength(item.patch)
    if (item.patchOmitted || patchBytes > PreviewLimits.patch || patches + patchBytes > PreviewLimits.patches) {
      item.patch = ""
      item.patchOmitted = true
    }
    let size = Buffer.byteLength(JSON.stringify(item)) + 1
    if (bytes + size > PreviewLimits.payload && item.patch) {
      item.patch = ""
      item.patchOmitted = true
      size = Buffer.byteLength(JSON.stringify(item)) + 1
    }
    if (bytes + size > PreviewLimits.payload) {
      value.summary.omittedFiles++
      continue
    }
    bytes += size
    patches += Buffer.byteLength(item.patch)
    if (item.patchOmitted) value.summary.omittedPatches++
    value.diffs.push(item)
  }
  if (summary)
    value.summary = {
      ...summary,
      omittedFiles: Math.max(summary.omittedFiles, summary.files - value.diffs.length),
      omittedPatches: Math.max(summary.omittedPatches, value.summary.omittedPatches),
    }
  return value
}
