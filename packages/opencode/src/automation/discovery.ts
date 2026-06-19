import { Context, Effect, Layer } from "effect"
import { Bus } from "../bus"
import { Config } from "../config"
import { Log } from "../util"
import type { WorkItem } from "./schema"

const log = Log.create({ service: "work-discovery" })

export interface Interface {
  readonly discoverCIFailures: () => Effect.Effect<WorkItem[]>
  readonly discoverIssues: () => Effect.Effect<WorkItem[]>
  readonly discoverCommits: () => Effect.Effect<WorkItem[]>
  readonly discoverAll: () => Effect.Effect<WorkItem[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkDiscovery") {}

function generateId(): string {
  return `work-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
}

export const layer: Layer.Layer<Service, never, Bus.Service | Config.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const config = yield* Config.Service

    const discoverCIFailures = Effect.fn("WorkDiscovery.discoverCIFailures")(function* () {
      const cfg = yield* config.get()

      const failures: WorkItem[] = [
        {
          id: generateId(),
          type: "ci_failure",
          source: "github-actions",
          title: "CI Pipeline Failed",
          description: "Test suite failed on main branch",
          priority: "high",
          metadata: {
            pipeline_id: "12345",
            branch: "main",
            commit: "abc123",
          },
          discovered_at: Date.now(),
        },
      ]

      log.info("discovered CI failures", { count: failures.length })
      return failures
    })

    const discoverIssues = Effect.fn("WorkDiscovery.discoverIssues")(function* () {
      const cfg = yield* config.get()

      const issues: WorkItem[] = [
        {
          id: generateId(),
          type: "issue",
          source: "github",
          title: "Bug: Login fails with special characters",
          description: "Users report login failure when password contains special characters",
          priority: "medium",
          metadata: {
            issue_number: "456",
            repository: "owner/repo",
            labels: "bug,urgent",
          },
          discovered_at: Date.now(),
        },
      ]

      log.info("discovered issues", { count: issues.length })
      return issues
    })

    const discoverCommits = Effect.fn("WorkDiscovery.discoverCommits")(function* () {
      const cfg = yield* config.get()

      const commits: WorkItem[] = [
        {
          id: generateId(),
          type: "commit",
          source: "git",
          title: "Recent commit: Fix memory leak in worker",
          description: "Commit abc123 fixes a memory leak in the worker module",
          priority: "low",
          metadata: {
            commit_hash: "abc123",
            author: "developer",
            message: "Fix memory leak in worker",
          },
          discovered_at: Date.now(),
        },
      ]

      log.info("discovered commits", { count: commits.length })
      return commits
    })

    const discoverAll = Effect.fn("WorkDiscovery.discoverAll")(function* () {
      const cfg = yield* config.get()

      const allWork: WorkItem[] = []

      if (cfg.automation?.ci_monitoring ?? true) {
        const failures = yield* discoverCIFailures()
        allWork.push(...failures)
      }

      if (cfg.automation?.issue_monitoring ?? true) {
        const issues = yield* discoverIssues()
        allWork.push(...issues)
      }

      if (cfg.automation?.commit_monitoring ?? true) {
        const commits = yield* discoverCommits()
        allWork.push(...commits)
      }

      log.info("discovered all work", { total: allWork.length })
      return allWork
    })

    return Service.of({
      discoverCIFailures,
      discoverIssues,
      discoverCommits,
      discoverAll,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer), Layer.provide(Bus.layer))

export * as WorkDiscovery from "."
