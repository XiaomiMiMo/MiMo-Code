/**
 * 自动化调度器模块
 */

export * from "./schema"
export * from "./scheduler"
export * from "./discovery"

import { Service as SchedulerService } from "./scheduler"
import { Service as DiscoveryService } from "./discovery"

export const Automation = {
  Scheduler: SchedulerService,
  Discovery: DiscoveryService,
}

export * as Automation from "."
