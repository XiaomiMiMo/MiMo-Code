export function attachAuthHeaders(input: {
  password?: string
  env?: Partial<Pick<NodeJS.ProcessEnv, "MIMOCODE_SERVER_PASSWORD" | "MIMOCODE_SERVER_USERNAME">>
}) {
  const env = input.env ?? process.env
  const password = input.password ?? env.MIMOCODE_SERVER_PASSWORD
  if (!password) return undefined
  const username = env.MIMOCODE_SERVER_USERNAME ?? "mimocode"
  const auth = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
  return { Authorization: auth }
}
