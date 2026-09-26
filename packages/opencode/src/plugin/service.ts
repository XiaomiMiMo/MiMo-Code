import { Context } from "effect"
import type { Interface } from "./index"

/**
 * Tag for the Plugin service.
 *
 * Kept in its own module so permission handling (and anything else) can take
 * the service as an optional dependency without importing the full Plugin
 * module. The Plugin module imports Session, which imports Permission, so a
 * runtime import of Plugin from Permission would create a module cycle that
 * fails while `Permission.Ruleset.zod` is still being initialized.
 */
export class Service extends Context.Service<Service, Interface>()("@opencode/Plugin") {}
