import { Flag } from "@/flag/flag"

export function serverAuthHeader(credentials?: { password?: string; username?: string }): string | undefined {
  const password = credentials?.password ?? Flag.MIMOCODE_SERVER_PASSWORD
  if (!password) return undefined
  const username = credentials?.username ?? Flag.MIMOCODE_SERVER_USERNAME ?? "mimocode"
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

export function serverAuthHeaders(credentials?: { password?: string; username?: string }):
  | { Authorization: string }
  | undefined {
  const header = serverAuthHeader(credentials)
  if (!header) return undefined
  return { Authorization: header }
}
