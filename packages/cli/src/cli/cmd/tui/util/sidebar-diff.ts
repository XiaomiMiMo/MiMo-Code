export type SidebarDiff = { file: string; additions: number; deletions: number }

/** The sidebar never needs patch bodies, including events from older servers. */
export function sidebarDiff(diffs: ReadonlyArray<SidebarDiff>): SidebarDiff[] {
  return diffs.slice(0, 500).map(({ file, additions, deletions }) => ({ file, additions, deletions }))
}

export function sidebarPreview(diffs: ReadonlyArray<SidebarDiff>, total = diffs.length) {
  const files = diffs.slice(0, 100)
  return { files, total: Math.max(total, diffs.length), omitted: Math.max(total, diffs.length) - files.length }
}
