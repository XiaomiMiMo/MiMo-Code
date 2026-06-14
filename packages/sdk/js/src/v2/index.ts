export * from "./client.js"
export * from "./server.js"

import { createDevoraClient } from "./client.js"
import { createDevoraServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export * as data from "./data.js"

export async function createDevora(options?: ServerOptions) {
  const server = await createDevoraServer({
    ...options,
  })

  const client = createDevoraClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
