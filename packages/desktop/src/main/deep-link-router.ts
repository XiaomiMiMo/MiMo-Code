// Shortcuts / URL scheme 路由解析
// mimo://session/<id>      → 打开指定 session
// mimo://project?path=...  → 打开指定 project
// mimo://prompt?text=...   → 打开 prompt 输入框并预填

export type MacDeepLink =
  | { kind: "session"; id: string }
  | { kind: "project"; path: string }
  | { kind: "prompt"; text: string }
  | { kind: "unknown"; raw: string }

export function parseMacDeepLink(url: string): MacDeepLink {
  if (!url.startsWith("mimo://") && !url.startsWith("opencode://")) {
    return { kind: "unknown", raw: url }
  }
  try {
    const u = new URL(url)
    const host = u.host
    if (host === "session") {
      const id = u.pathname.replace(/^\//, "")
      if (!id) return { kind: "unknown", raw: url }
      return { kind: "session", id }
    }
    if (host === "project") {
      const path = u.searchParams.get("path")
      if (!path) return { kind: "unknown", raw: url }
      return { kind: "project", path }
    }
    if (host === "prompt") {
      const text = u.searchParams.get("text") ?? ""
      return { kind: "prompt", text }
    }
    return { kind: "unknown", raw: url }
  } catch {
    return { kind: "unknown", raw: url }
  }
}
