import { cmd } from "./cmd"
import { Effect } from "effect"
import { Instance } from "../../project/instance"
import { AppRuntime } from "../../effect/app-runtime"
import { Config } from "../../config"
import { SchedulerService, schedulerLayer } from "../../automation"
import { Bus } from "../../bus"
import { Skill } from "../../skill"
import type { AutomationTask } from "../../automation/schema"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"

export const AutomationCommand = cmd({
  command: "automation",
  describe: "管理自动化调度器",
  builder: (yargs) =>
    yargs
      .command(AutomationStatusCommand)
      .command(AutomationListCommand)
      .command(AutomationStartCommand)
      .command(AutomationStopCommand)
      .command(AutomationTriggerCommand)
      .command(AutomationRegisterCommand)
      .command(AutomationUnregisterCommand)
      .demandCommand(),
  async handler() {},
})

export const AutomationStatusCommand = cmd({
  command: "status",
  describe: "显示自动化调度器状态",
  async handler() {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        UI.empty()
        prompts.intro("自动化调度器状态")

        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const scheduler = yield* SchedulerService
            return yield* scheduler.status()
          }).pipe(Effect.provide(schedulerLayer)),
        )

        prompts.log.info(`运行状态: ${result.running ? "✅ 运行中" : "⏹️ 已停止"}`)
        prompts.log.info(`活跃任务数: ${result.active_tasks}`)
        prompts.log.info(`待处理工作项: ${result.pending_work}`)
        prompts.log.info(`已注册任务: ${result.registered_tasks.length}`)

        if (result.registered_tasks.length > 0) {
          for (const task of result.registered_tasks) {
            prompts.log.info(`  - ${task.name} (${task.id}) [${task.skill}] 间隔: ${task.schedule} ${task.enabled ? "✅" : "⏸️"}`)
          }
        }

        prompts.outro("完成")
      },
    })
  },
})

export const AutomationListCommand = cmd({
  command: "list",
  describe: "列出已注册的自动化任务",
  async handler() {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        UI.empty()
        prompts.intro("自动化任务列表")

        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const scheduler = yield* SchedulerService
            return yield* scheduler.status()
          }).pipe(Effect.provide(schedulerLayer)),
        )

        if (result.registered_tasks.length === 0) {
          prompts.log.info("暂无已注册的自动化任务")
        } else {
          for (const task of result.registered_tasks) {
            prompts.log.info(`[${task.id}] ${task.name}`)
            prompts.log.info(`  技能: ${task.skill}`)
            prompts.log.info(`  调度: ${task.schedule}`)
            prompts.log.info(`  优先级: ${task.priority}`)
            prompts.log.info(`  重试: ${task.retries ?? 0} 次`)
            prompts.log.info(`  状态: ${task.enabled ? "✅ 启用" : "⏸️ 禁用"}`)
            if (task.description) prompts.log.info(`  描述: ${task.description}`)
            prompts.log.info("---")
          }
        }

        prompts.outro("完成")
      },
    })
  },
})

export const AutomationStartCommand = cmd({
  command: "start",
  describe: "启动自动化调度器",
  async handler() {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        UI.empty()
        prompts.intro("启动自动化调度器")

        await AppRuntime.runPromise(
          Effect.gen(function* () {
            const scheduler = yield* SchedulerService
            yield* scheduler.start()
          }).pipe(Effect.provide(schedulerLayer)),
        )

        prompts.log.success("自动化调度器已启动")
        prompts.outro("完成")
      },
    })
  },
})

export const AutomationStopCommand = cmd({
  command: "stop",
  describe: "停止自动化调度器",
  async handler() {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        UI.empty()
        prompts.intro("停止自动化调度器")

        await AppRuntime.runPromise(
          Effect.gen(function* () {
            const scheduler = yield* SchedulerService
            yield* scheduler.stop()
          }).pipe(Effect.provide(schedulerLayer)),
        )

        prompts.log.success("自动化调度器已停止")
        prompts.outro("完成")
      },
    })
  },
})

export const AutomationTriggerCommand = cmd({
  command: "trigger <task-id>",
  describe: "手动触发一个自动化任务",
  builder: (yargs) =>
    yargs.positional("task-id", {
      describe: "任务 ID",
      type: "string",
      demandOption: true,
    }),
  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        UI.empty()
        prompts.intro("触发自动化任务")

        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const scheduler = yield* SchedulerService
            return yield* scheduler.trigger(args["task-id"])
          }).pipe(Effect.provide(schedulerLayer)),
        )

        prompts.log.info(`任务: ${result.task_id}`)
        prompts.log.info(`状态: ${result.status === "success" ? "✅ 成功" : "❌ 失败"}`)
        prompts.log.info(`耗时: ${result.duration_ms}ms`)
        if (result.output) prompts.log.info(`输出: ${result.output}`)
        if (result.error) prompts.log.info(`错误: ${result.error}`)

        prompts.outro("完成")
      },
    })
  },
})

export const AutomationRegisterCommand = cmd({
  command: "register <task-id> <name> <skill> <schedule>",
  describe: "注册一个新的自动化任务",
  builder: (yargs) =>
    yargs
      .positional("task-id", {
        describe: "任务唯一标识",
        type: "string",
        demandOption: true,
      })
      .positional("name", {
        describe: "任务名称",
        type: "string",
        demandOption: true,
      })
      .positional("skill", {
        describe: "要调用的技能名称",
        type: "string",
        demandOption: true,
      })
      .positional("schedule", {
        describe: "调度表达式 (如 '5m', '1h', '30s')",
        type: "string",
        demandOption: true,
      })
      .option("description", {
        describe: "任务描述",
        type: "string",
      }),
  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        UI.empty()
        prompts.intro("注册自动化任务")

        const task: AutomationTask = {
          id: args["task-id"],
          name: args.name,
          skill: args.skill,
          schedule: args.schedule,
          enabled: true,
          priority: "medium",
          retries: 0,
          description: args.description,
        }

        await AppRuntime.runPromise(
          Effect.gen(function* () {
            const scheduler = yield* SchedulerService
            yield* scheduler.register(task)
          }).pipe(Effect.provide(schedulerLayer)),
        )

        prompts.log.success(`任务 "${args.name}" 已注册`)
        prompts.outro("完成")
      },
    })
  },
})

export const AutomationUnregisterCommand = cmd({
  command: "unregister <task-id>",
  describe: "注销一个自动化任务",
  builder: (yargs) =>
    yargs.positional("task-id", {
      describe: "任务 ID",
      type: "string",
      demandOption: true,
    }),
  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        UI.empty()
        prompts.intro("注销自动化任务")

        await AppRuntime.runPromise(
          Effect.gen(function* () {
            const scheduler = yield* SchedulerService
            yield* scheduler.unregister(args["task-id"])
          }).pipe(Effect.provide(schedulerLayer)),
        )

        prompts.log.success(`任务 "${args["task-id"]}" 已注销`)
        prompts.outro("完成")
      },
    })
  },
})
