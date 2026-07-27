import { afterEach, beforeEach } from "bun:test"
import { Flag } from "../../src/flag/flag"

export function enforcePermissions() {
  const fullPermission = Flag.MIMOCODE_RL_FULL_PERMISSION
  beforeEach(() => {
    Flag.MIMOCODE_RL_FULL_PERMISSION = false
  })
  afterEach(() => {
    Flag.MIMOCODE_RL_FULL_PERMISSION = fullPermission
  })
}
