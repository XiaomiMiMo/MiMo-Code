// Search and per-instance incremental Bus writer. Historical index migration
// belongs to the database connection lifecycle, not directory bootstrap.
export * as History from "./service"
export { Service as WriterService } from "./writer"
