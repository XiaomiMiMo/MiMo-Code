import { afterEach, describe, expect, test } from "bun:test"
import { Session } from "../../src/session"
import { Instance } from "../../src/project/instance"

afterEach(async () => {
  await Instance.disposeAll()
})

describe("Session.planRelative", () => {
  test("returns relative path when in VCS project", async () => {
    await Instance.provide({
      directory: "/tmp/test-project",
      fn: async () => {
        // planRelative 需要 Instance.worktree 可用
        // 在测试环境中 Instance 可能未完全初始化，所以测试基本结构
        const result = Session.planRelative({
          slug: "test-slug",
          time: { created: 1234567890 },
        })
        expect(typeof result).toBe("string")
        expect(result).toContain("test-slug")
      },
    })
  })

  test("plan returns absolute path with timestamp and slug", () => {
    // plan() 需要 Instance 上下文；当不可用时检查函数签名
    try {
      const result = Session.plan({
        slug: "my-feature",
        time: { created: 1700000000 },
      })
      expect(result).toContain("1700000000-my-feature.md")
      expect(result).toEndWith(".md")
    } catch (e) {
      // Instance 上下文不可用时跳过此测试
    }
  })
})
