/**
 * Standalone build entry for Desktop data migration (dist/node/migration-node.js).
 * Only exports the pure SQL merge module; importing it initialises nothing else of the engine.
 */
export * as Migration from "./migration/merge"
