// Parses OTEL_EXPORTER_OTLP_HEADERS ("k1=v1,k2=v2") into a header record.
// Keys and values are trimmed; entries without '=' or with an empty key are
// skipped so malformed input cannot produce invalid HTTP header names. '='
// inside a value is preserved.
export function parseOtlpHeaders(value: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const entry of value.split(",")) {
    const index = entry.indexOf("=")
    if (index < 0) continue
    const key = entry.slice(0, index).trim()
    if (!key) continue
    headers[key] = entry.slice(index + 1).trim()
  }
  return headers
}
