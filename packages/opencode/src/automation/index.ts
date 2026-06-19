/**
 * 自动化调度器模块
 */

export * from "./schema"
export type { Interface as SchedulerInterface } from "./scheduler"
export type { Interface as DiscoveryInterface } from "./discovery"

import { Service as SchedulerService, layer as schedulerLayer, defaultLayer as schedulerDefaultLayer } from "./scheduler"
import { Service as DiscoveryService, layer as discoveryLayer, defaultLayer as discoveryDefaultLayer } from "./discovery"

export { SchedulerService, schedulerLayer, schedulerDefaultLayer }
export { DiscoveryService, discoveryLayer, discoveryDefaultLayer }

export const Automation = {
  Scheduler: SchedulerService,
  Discovery: DiscoveryService,
}
