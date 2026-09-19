import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js"
import type { AnySchema, SchemaOutput } from "@modelcontextprotocol/sdk/server/zod-compat.js"

/** A replaced connection lives until its requests and turn bindings release it. */
export class ManagedClient extends Client {
  private users = 0
  private closing = false
  private closed?: Promise<void>
  private cleanup?: () => Promise<void>

  retain() {
    if (this.closing) throw new Error("MCP connection has been released")
    this.users++
    let released = false
    return () => {
      if (released) return
      released = true
      this.users--
      this.closeIfIdle()
    }
  }

  retire(cleanup: () => Promise<void>) {
    this.cleanup ??= cleanup
    this.closeIfIdle()
  }

  private closeIfIdle() {
    if (this.users || this.closing || !this.cleanup) return
    this.closing = true
    // The owner supplies cleanup that handles failures and removes its registry entry.
    void this.cleanup()
  }

  override async request<T extends AnySchema>(
    request: Parameters<Client["request"]>[0],
    schema: T,
    options?: RequestOptions,
  ): Promise<SchemaOutput<T>> {
    const release = this.retain()
    try {
      return await super.request(request, schema, options)
    } finally {
      release()
    }
  }

  override close() {
    this.closing = true
    return (this.closed ??= super.close())
  }
}
