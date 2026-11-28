// One running connector per installation state.
//
// Two MiMo Code windows share the device key and the state file. Both online at
// once would replace each other's control socket and lanes on every attach and
// overwrite each other's state, so the second one stays off instead.

import { open, readFile, rm, stat } from "node:fs/promises"

/** An empty lock file younger than this belongs to a process that is still writing it. */
const WRITE_GRACE_MS = 10_000

export class InstanceLock {
  private held = false
  /** Owner process plus a per-lock token, so two connectors in one process are told apart too. */
  private readonly owner = `${process.pid}:${crypto.randomUUID()}`

  constructor(
    private readonly file: string,
    private readonly alive: (pid: number) => boolean = processAlive,
  ) {}

  /** Take the lock; false when another live process holds it. */
  async acquire(): Promise<boolean> {
    if (this.held) return true
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(this.file, "wx", 0o600)
        await handle.writeFile(this.owner)
        await handle.close()
        this.held = true
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }
      const owner = (await readFile(this.file, "utf8").catch(() => "")).trim()
      if (!owner) {
        const age = Date.now() - ((await stat(this.file).catch(() => undefined))?.mtimeMs ?? 0)
        if (age < WRITE_GRACE_MS) return false
      }
      const pid = Number(owner.split(":")[0])
      if (owner !== this.owner && Number.isInteger(pid) && pid > 0 && this.alive(pid)) return false
      // Left behind by a process that is gone: take it over.
      await rm(this.file, { force: true })
    }
    return false
  }

  async release(): Promise<void> {
    if (!this.held) return
    this.held = false
    const owner = (await readFile(this.file, "utf8").catch(() => "")).trim()
    if (owner === this.owner) await rm(this.file, { force: true })
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}
