import * as Rpc from "../../src/util/rpc"

// As the TUI worker does: a top-level await that yields to the event loop before listen().
await new Promise((resolve) => setTimeout(resolve, 100))

Rpc.listen({ echo: (input: string) => input })
