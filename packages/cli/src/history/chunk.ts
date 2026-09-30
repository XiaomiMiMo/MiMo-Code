/** Normalize legacy search-index chunk ids while background cleanup is pending. */
export function basePartId(partId: string): string {
  const hash = partId.lastIndexOf("#")
  if (hash <= 0) return partId
  return /^#\d+$/.test(partId.slice(hash)) ? partId.slice(0, hash) : partId
}
