import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Duration } from "effect"
import { Instance } from "../../src/project/instance"
import { Service as SchedulerService, defaultLayer as schedulerDefaultLayer } from "../../src/automation/scheduler"
import type { Interface as SchedulerInterface } from "../../src/automation/scheduler"
import { Database } from "../../src/storage"
import { tmpdir } from "../fixture/fixture"
import fs from "fs/promises"
import path from "path"

/** 在 temp 目录下创建临时技能文件，使调度器能找到 skill */
async function createTestSkill(dir: string, name: string): Promise<void> {
  const skillDir = path.join(dir, ".claude", "skills", name)
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `---
name: ${name}
description: 测试用技能
---
这是一个测试技能。`)
}

/** 调度器测试默认使用的技能名 */
const TEST_SKILL = "test-skill"

/**
 * 在实例上下文内创建临时调度器并运行操作。
 * 每次调用创建独立的调度器实例，保证测试隔离。
 */
async function runScoped<A>(dir: string, fn: (s: SchedulerInterface) => Effect.Effect<A>): Promise<A> {
  // 确保测试技能存在
  await createTestSkill(dir, TEST_SKILL)
  return Instance.provide({
    directory: dir,
    async fn() {
      return Effect.runPromise(
        SchedulerService.use(fn).pipe(Effect.provide(schedulerDefaultLayer)),
      )
    },
  })
}

function makeTask(overrides: Partial<{
  id: string; name: string; description: string;
  schedule: string; skill: string; enabled: boolean;
  priority: "low" | "medium" | "high";
  timeout: number; retries: number;
}> = {}) {
  return {
    id: overrides.id ?? "test-task-1",
    name: overrides.name ?? "测试任务",
    description: overrides.description,
    schedule: overrides.schedule ?? "5m",
    skill: overrides.skill ?? TEST_SKILL,
    enabled: overrides.enabled ?? true,
    priority: overrides.priority ?? "medium" as const,
    timeout: overrides.timeout,
    retries: overrides.retries ?? 0,
  }
}

afterEach(async () => {
  // 清理自动化表，避免跨测试污染
  try {
    const db = Database.Client().$client
    db.exec("DELETE FROM automation_task")
    db.exec("DELETE FROM automation_result")
  } catch { /* 表可能不存在 */ }
  await Instance.disposeAll()
})

// ====== 调度器生命周期 ======

describe("调度器生命周期", () => {
  test("初始状态为未运行", async () => {
    await using tmp = await tmpdir()
    const status = await runScoped(tmp.path, (s) => s.status())
    expect(status.running).toBe(false)
    expect(status.registered_tasks).toEqual([])
    expect(status.active_tasks).toBe(0)
    expect(status.pending_work).toBe(0)
  })

  test("start 和 stop 切换运行状态", async () => {
    await using tmp = await tmpdir()
    const status = await runScoped(tmp.path, (s) =>
      Effect.gen(function* () {
        yield* s.start()
        const running = yield* s.status()
        yield* s.stop()
        const stopped = yield* s.status()
        return { running: running.running, stopped: stopped.running }
      }),
    )
    expect(status.running).toBe(true)
    expect(status.stopped).toBe(false)
  })

  test("重复 start 不会报错", async () => {
    await using tmp = await tmpdir()
    await runScoped(tmp.path, (s) =>
      Effect.gen(function* () {
        yield* s.start()
        yield* s.start()
        yield* s.stop()
      }),
    )
  })
})

// ====== 任务管理 ======

describe("任务管理", () => {
  test("register 添加任务到已注册列表", async () => {
    await using tmp = await tmpdir()
    const status = await runScoped(tmp.path, (s) =>
      Effect.gen(function* () {
        yield* s.register(makeTask())
        return yield* s.status()
      }),
    )
    expect(status.registered_tasks).toHaveLength(1)
    expect(status.registered_tasks[0].id).toBe("test-task-1")
    expect(status.registered_tasks[0].name).toBe("测试任务")
    expect(status.registered_tasks[0].skill).toBe(TEST_SKILL)
  })

  test("register 多个任务", async () => {
    await using tmp = await tmpdir()
    const status = await runScoped(tmp.path, (s) =>
      Effect.gen(function* () {
        yield* s.register(makeTask({ id: "task-1", name: "Task 1" }))
        yield* s.register(makeTask({ id: "task-2", name: "Task 2" }))
        yield* s.register(makeTask({ id: "task-3", name: "Task 3" }))
        return yield* s.status()
      }),
    )
    expect(status.registered_tasks).toHaveLength(3)
  })

  test("unregister 移除任务", async () => {
    await using tmp = await tmpdir()
    const status = await runScoped(tmp.path, (s) =>
      Effect.gen(function* () {
        yield* s.register(makeTask({ id: "task-1" }))
        yield* s.register(makeTask({ id: "task-2" }))
        yield* s.unregister("task-1")
        return yield* s.status()
      }),
    )
    expect(status.registered_tasks).toHaveLength(1)
    expect(status.registered_tasks[0].id).toBe("task-2")
  })

  test("注册同名任务会更新", async () => {
    await using tmp = await tmpdir()
    const status = await runScoped(tmp.path, (s) =>
      Effect.gen(function* () {
        yield* s.register(makeTask({ id: "task-1", skill: "plan" }))
        yield* s.register(makeTask({ id: "task-1", skill: "build" }))
        return yield* s.status()
      }),
    )
    expect(status.registered_tasks).toHaveLength(1)
    expect(status.registered_tasks[0].skill).toBe("build")
  })
})

// ====== 任务执行 ======

describe("任务执行", () => {
  test("trigger 已注册任务返回成功结果", async () => {
    await using tmp = await tmpdir()
    const result = await runScoped(tmp.path, (s) =>
      Effect.gen(function* () {
        yield* s.register(makeTask())
        return yield* s.trigger("test-task-1")
      }),
    )
    expect(result.task_id).toBe("test-task-1")
    expect(result.status).toBe("success")
    expect(result.duration_ms).toBeGreaterThanOrEqual(0)
    expect(result.executed_at).toBeGreaterThan(0)
    expect(result.output).toContain("测试任务")
  })

  test("trigger 未注册任务抛出错误", async () => {
    await using tmp = await tmpdir()
    try {
      await runScoped(tmp.path, (s) =>
        s.trigger("non-existent"),
      )
      expect.unreachable("应该抛出错误")
    } catch (e) {
      expect((e as Error).message).toContain("non-existent")
    }
  })

  test("trigger 不存在的技能返回失败状态", async () => {
    await using tmp = await tmpdir()
    const result = await runScoped(tmp.path, (s) =>
      Effect.gen(function* () {
        yield* s.register(makeTask({ id: "bad-skill", skill: "non-existent-skill-xyz" }))
        return yield* s.trigger("bad-skill")
      }),
    )
    expect(result.status).toBe("failure")
    expect(result.error).toContain("non-existent-skill-xyz")
  })
})

// ====== 工作项 ======

describe("工作项管理", () => {
  test("enqueueWork 增加待处理工作项", async () => {
    await using tmp = await tmpdir()
    const pending = await runScoped(tmp.path, (s) =>
      Effect.gen(function* () {
        yield* s.enqueueWork({
          id: "work-1", type: "custom", source: "test",
          title: "测试工作项", priority: "medium",
          discovered_at: Date.now(),
        })
        return yield* s.pendingWork()
      }),
    )
    expect(pending).toHaveLength(1)
    expect(pending[0].id).toBe("work-1")
    expect(pending[0].title).toBe("测试工作项")
  })

  test("多个工作项入队", async () => {
    await using tmp = await tmpdir()
    const pending = await runScoped(tmp.path, (s) =>
      Effect.gen(function* () {
        for (let i = 0; i < 5; i++) {
          yield* s.enqueueWork({
            id: `work-${i}`, type: "custom", source: "test",
            title: `工作项 ${i}`, priority: "medium",
            discovered_at: Date.now(),
          })
        }
        return yield* s.pendingWork()
      }),
    )
    expect(pending).toHaveLength(5)
  })
})

// ====== 执行结果 ======

describe("执行结果", () => {
  test("执行结果可以通过 results 查询", async () => {
    await using tmp = await tmpdir()
    const results = await runScoped(tmp.path, (s) =>
      Effect.gen(function* () {
        yield* s.register(makeTask({ id: "result-task" }))
        yield* s.trigger("result-task")
        yield* Effect.sleep(Duration.millis(50))
        return yield* s.results()
      }),
    )
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].task_id).toBe("result-task")
    expect(results[0].status).toBe("success")
  })

  test("按 task_id 过滤结果", async () => {
    await using tmp = await tmpdir()
    const results = await runScoped(tmp.path, (s) =>
      Effect.gen(function* () {
        yield* s.register(makeTask({ id: "task-a" }))
        yield* s.register(makeTask({ id: "task-b" }))
        yield* s.trigger("task-a")
        yield* s.trigger("task-b")
        yield* Effect.sleep(Duration.millis(50))
        return yield* s.results("task-a")
      }),
    )
    expect(results.every((r) => r.task_id === "task-a")).toBe(true)
  })
})

// ====== 持久化 ======

describe("持久化", () => {
  test("任务注册后保留在数据库中", async () => {
    await using tmp = await tmpdir()

    // 第一次运行：注册任务
    await runScoped(tmp.path, (s) =>
      Effect.gen(function* () {
        yield* s.register(makeTask({ id: "persist-task", name: "持久化测试" }))
      }),
    )

    // 第二次运行：创建新调度器，验证从数据库加载
    const status = await runScoped(tmp.path, (s) => s.status())
    expect(status.registered_tasks.map((t) => t.name)).toContain("持久化测试")
  })
})
