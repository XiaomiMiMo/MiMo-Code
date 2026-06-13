import { describe, expect, test } from "bun:test"
import { Database } from "../../../src/storage"
import { SessionTable } from "../../../src/session/session.sql"
import { ClaudeImportTable } from "../../../src/session/claude-import.sql"
import { ProjectTable } from "../../../src/project/project.sql"
import { aggregateSessionStats } from "../../../src/cli/cmd/stats"
import type { SessionID, ProjectID } from "../../../src/session/schema"

function setupTestData() {
  const now = Date.now()
  const projectId = "project_test" as ProjectID

  Database.use((db) => {
    db.insert(ProjectTable)
      .values({
        id: projectId,
        worktree: "/tmp/test",
        vcs: "git",
        sandboxes: [],
        time_created: now,
        time_updated: now,
      })
      .run()
  })

  return { now, projectId }
}

function cleanup() {
  Database.use((db) => {
    db.delete(ClaudeImportTable).run()
    db.delete(SessionTable).run()
    db.delete(ProjectTable).run()
  })
}

describe("aggregateSessionStats", () => {
  test("should filter out imported Claude Code sessions", async () => {
    const { now, projectId } = setupTestData()
    const nativeSessionId = "session_native_123" as SessionID
    const importedSessionId = "session_imported_456" as SessionID

    Database.use((db) => {
      // Insert a native session (not imported)
      db.insert(SessionTable)
        .values({
          id: nativeSessionId,
          project_id: projectId,
          slug: "native-session",
          directory: "/tmp/test",
          title: "Native Session",
          version: "1.0.0",
          time_created: now,
          time_updated: now,
        })
        .run()

      // Insert an imported session
      db.insert(SessionTable)
        .values({
          id: importedSessionId,
          project_id: projectId,
          slug: "imported-session",
          directory: "/tmp/test",
          title: "Imported Session",
          version: "claude-code",
          time_created: now - 100000,
          time_updated: now - 100000,
        })
        .run()

      // Mark the second session as imported
      db.insert(ClaudeImportTable)
        .values({
          source_uuid: "test-uuid-123",
          session_id: importedSessionId,
          source_path: "/tmp/test.jsonl",
          source_mtime: now,
          time_imported: now,
          message_ids: [],
        })
        .run()
    })

    const stats = await aggregateSessionStats()

    // Should only count the native session
    expect(stats.totalSessions).toBe(1)

    cleanup()
  })

  test("should count all sessions when none are imported", async () => {
    const { now, projectId } = setupTestData()
    const session1 = "session_1" as SessionID
    const session2 = "session_2" as SessionID

    Database.use((db) => {
      db.insert(SessionTable)
        .values({
          id: session1,
          project_id: projectId,
          slug: "session-1",
          directory: "/tmp/test",
          title: "Session 1",
          version: "1.0.0",
          time_created: now,
          time_updated: now,
        })
        .run()

      db.insert(SessionTable)
        .values({
          id: session2,
          project_id: projectId,
          slug: "session-2",
          directory: "/tmp/test",
          title: "Session 2",
          version: "1.0.0",
          time_created: now - 100000,
          time_updated: now - 100000,
        })
        .run()
    })

    const stats = await aggregateSessionStats()

    // Should count both sessions
    expect(stats.totalSessions).toBe(2)

    cleanup()
  })

  test("should handle case where all sessions are imported", async () => {
    const { now, projectId } = setupTestData()
    const importedSession1 = "session_imported_1" as SessionID
    const importedSession2 = "session_imported_2" as SessionID

    Database.use((db) => {
      db.insert(SessionTable)
        .values({
          id: importedSession1,
          project_id: projectId,
          slug: "imported-1",
          directory: "/tmp/test",
          title: "Imported 1",
          version: "claude-code",
          time_created: now,
          time_updated: now,
        })
        .run()

      db.insert(SessionTable)
        .values({
          id: importedSession2,
          project_id: projectId,
          slug: "imported-2",
          directory: "/tmp/test",
          title: "Imported 2",
          version: "claude-code",
          time_created: now - 100000,
          time_updated: now - 100000,
        })
        .run()

      db.insert(ClaudeImportTable)
        .values({
          source_uuid: "uuid-1",
          session_id: importedSession1,
          source_path: "/tmp/test1.jsonl",
          source_mtime: now,
          time_imported: now,
          message_ids: [],
        })
        .run()

      db.insert(ClaudeImportTable)
        .values({
          source_uuid: "uuid-2",
          session_id: importedSession2,
          source_path: "/tmp/test2.jsonl",
          source_mtime: now,
          time_imported: now,
          message_ids: [],
        })
        .run()
    })

    const stats = await aggregateSessionStats()

    // Should count zero sessions (all imported)
    expect(stats.totalSessions).toBe(0)

    cleanup()
  })

  test("should return zero stats when no sessions exist", async () => {
    const stats = await aggregateSessionStats()

    expect(stats.totalSessions).toBe(0)
    expect(stats.totalMessages).toBe(0)
    expect(stats.totalCost).toBe(0)
  })
})
