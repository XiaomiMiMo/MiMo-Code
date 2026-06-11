export function attachAuthHeaders(input: { password?: string; env?: Record<string, string | undefined> }) {
  const password = input.password ?? input.env?.MIMOCODE_SERVER_PASSWORD
  if (!password) return undefined
  return {
    Authorization: `Basic ${Buffer.from(`${input.env?.MIMOCODE_SERVER_USERNAME ?? "mimocode"}:${password}`).toString("base64")}`,
  }
}
