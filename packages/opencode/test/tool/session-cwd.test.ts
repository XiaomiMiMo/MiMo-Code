import { afterEach, expect, test } from "bun:test"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { SessionID } from "../../src/session/schema"
import { SessionCwd } from "../../src/tool/session-cwd"
import { tmpdir } from "../fixture/fixture"

afterEach(() => Instance.disposeAll())

test("disposing one instance preserves other session cwd overrides", async () => {
  await using one = await tmpdir()
  await using two = await tmpdir()
  const first = SessionID.make("ses_cwd_first")
  const second = SessionID.make("ses_cwd_second")
  const firstCwd = path.join(one.path, "first")
  const secondCwd = path.join(two.path, "second")

  await Instance.provide({
    directory: one.path,
    fn: () => SessionCwd.set(first, firstCwd),
  })
  await Instance.provide({
    directory: two.path,
    fn: () => SessionCwd.set(second, secondCwd),
  })

  await Instance.disposeDirectory(one.path)

  const reset = await Instance.provide({
    directory: one.path,
    fn: () => SessionCwd.get(first),
  })
  const preserved = await Instance.provide({
    directory: two.path,
    fn: () => SessionCwd.get(second),
  })
  expect(reset).toBe(one.path)
  expect(preserved).toBe(secondCwd)
})
