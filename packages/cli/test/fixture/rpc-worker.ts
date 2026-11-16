// Worker fixture for test/util/rpc.test.ts. Like the TUI worker, it awaits before
// installing its RPC listener; Bun 1.4 drops messages that arrive in that window.
import { Rpc } from "../../src/util"

await Bun.sleep(50)

export const rpc = {
  echo(input: string) {
    return input
  },
  async fail(input: string): Promise<never> {
    throw new Error(input)
  },
  exit() {
    process.exit(0)
  },
  crash(input: string) {
    setTimeout(() => {
      throw new Error(input)
    }, 10)
    return new Promise<never>(() => {})
  },
  hang() {
    return new Promise<never>(() => {})
  },
}

Rpc.emit("booted", "early")
Rpc.listen(rpc)
