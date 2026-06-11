import { describe, expect, test } from "bun:test"
import * as path from "path"
import { assertMemoryWriteAllowed } from "../../src/tool/memory-path-guard"
import { ProjectID } from "../../src/project/schema"
import { SessionID } from "../../src/session/schema"
import {
  checkpointPath,
  memoryPath,
  notesPath,
} from "../../src/session/checkpoint-paths"
import { Global } from "../../src/global"

const MEMORY_ROOT = "/data/memory"
const PROJECT_ID = ProjectID.make("p_test")
const SESSION_ID = SessionID.make("sid")

describe("assertMemoryWriteAllowed", () => {
  test("non-memory path passes for any agent", () => {
    expect(() =>
      assertMemoryWriteAllowed({
        target: "/some/cwd/foo.txt",
        agentName: "build",
        memoryRoot: MEMORY_ROOT,
        projectID: PROJECT_ID,
        sessionID: SESSION_ID,
      }),
    ).not.toThrow()
  })

  test("free key in sessions/<sid>/foo.md passes for main agent", () => {
    const target = path.join(MEMORY_ROOT, "sessions", "sid", "foo.md")
    expect(() =>
      assertMemoryWriteAllowed({
        target,
        agentName: "build",
        memoryRoot: MEMORY_ROOT,
        projectID: PROJECT_ID,
        sessionID: SESSION_ID,
      }),
    ).not.toThrow()
  })

  test("_meta.json is a free key for main agent", () => {
    const target = path.join(MEMORY_ROOT, "sessions", "sid", "_meta.json")
    expect(() =>
      assertMemoryWriteAllowed({
        target,
        agentName: "build",
        memoryRoot: MEMORY_ROOT,
        projectID: PROJECT_ID,
        sessionID: SESSION_ID,
      }),
    ).not.toThrow()
  })

  test("path directly under memory/ rejected (no scope dir)", () => {
    const target = path.join(MEMORY_ROOT, "foo.md")
    expect(() =>
      assertMemoryWriteAllowed({
        target,
        agentName: "build",
        memoryRoot: MEMORY_ROOT,
        projectID: PROJECT_ID,
        sessionID: SESSION_ID,
      }),
    ).toThrow(/copy verbatim/)
  })

  test("invalid scope rejected", () => {
    const target = path.join(MEMORY_ROOT, "badscope", "sid", "foo.md")
    expect(() =>
      assertMemoryWriteAllowed({
        target,
        agentName: "build",
        memoryRoot: MEMORY_ROOT,
        projectID: PROJECT_ID,
        sessionID: SESSION_ID,
      }),
    ).toThrow(/copy verbatim/)
  })

  test.each([
    ["global", "free.md"],
    ["projects", "p_abc/free.md"],
    ["sessions", "sid/free.md"],
  ])("free key under %s scope passes", (scope, suffix) => {
    const target = path.join(MEMORY_ROOT, scope, suffix)
    expect(() =>
      assertMemoryWriteAllowed({
        target,
        agentName: "build",
        memoryRoot: MEMORY_ROOT,
        projectID: PROJECT_ID,
        sessionID: SESSION_ID,
      }),
    ).not.toThrow()
  })

  test("traversal via .. that lands in tasks is rejected", () => {
    const target = path.join(MEMORY_ROOT, "sessions", "sid", "free", "..", "tasks", "T1", "x.md")
    expect(() =>
      assertMemoryWriteAllowed({
        target,
        agentName: "build",
        memoryRoot: MEMORY_ROOT,
        projectID: PROJECT_ID,
        sessionID: SESSION_ID,
      }),
    ).toThrow(/reserved for the checkpoint-writer/)
  })

  describe("checkpoint-writer allowlist (v5)", () => {
    test("memory.md at <pid>/ allowed for checkpoint-writer", () => {
      const target = path.join(MEMORY_ROOT, "projects", "abc-uuid", "memory.md")
      expect(() =>
        assertMemoryWriteAllowed({
          target,
          agentName: "checkpoint-writer",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        }),
      ).not.toThrow()
    })

    test("memory-<topic>.md at <pid>/ allowed (spillover)", () => {
      const target = path.join(MEMORY_ROOT, "projects", "abc-uuid", "memory-rules.md")
      expect(() =>
        assertMemoryWriteAllowed({
          target,
          agentName: "checkpoint-writer",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        }),
      ).not.toThrow()
    })

    test("MEMORY.md at <pid>/ allowed (uppercase canonical)", () => {
      const target = path.join(MEMORY_ROOT, "projects", "abc-uuid", "MEMORY.md")
      expect(() =>
        assertMemoryWriteAllowed({
          target,
          agentName: "checkpoint-writer",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        }),
      ).not.toThrow()
    })

    test("MEMORY-rules.md at <pid>/ allowed (uppercase spillover)", () => {
      const target = path.join(MEMORY_ROOT, "projects", "abc-uuid", "MEMORY-rules.md")
      expect(() =>
        assertMemoryWriteAllowed({
          target,
          agentName: "checkpoint-writer",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        }),
      ).not.toThrow()
    })

    test("checkpoint.md at <sid>/ allowed (no subdir)", () => {
      const target = path.join(MEMORY_ROOT, "sessions", "sid", "checkpoint.md")
      expect(() =>
        assertMemoryWriteAllowed({
          target,
          agentName: "checkpoint-writer",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        }),
      ).not.toThrow()
    })

    test("checkpoint-<topic>.md at <sid>/ allowed (spillover)", () => {
      const target = path.join(MEMORY_ROOT, "sessions", "sid", "checkpoint-lexer.md")
      expect(() =>
        assertMemoryWriteAllowed({
          target,
          agentName: "checkpoint-writer",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        }),
      ).not.toThrow()
    })

    test("v4 path <sid>/checkpoint/snapshot.md NOW rejected (no subdir in v5)", () => {
      const target = path.join(MEMORY_ROOT, "sessions", "sid", "checkpoint", "snapshot.md")
      expect(() =>
        assertMemoryWriteAllowed({
          target,
          agentName: "checkpoint-writer",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        }),
      ).toThrow(/checkpoint-writer allowlist/)
    })

    test("pinned.md at <pid>/ NOW rejected (renamed to memory.md)", () => {
      const target = path.join(MEMORY_ROOT, "projects", "abc-uuid", "pinned.md")
      expect(() =>
        assertMemoryWriteAllowed({
          target,
          agentName: "checkpoint-writer",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        }),
      ).toThrow(/checkpoint-writer allowlist/)
    })

    test("any non-.md in <sid>/ rejected", () => {
      const target = path.join(MEMORY_ROOT, "sessions", "sid", "checkpoint.json")
      expect(() =>
        assertMemoryWriteAllowed({
          target,
          agentName: "checkpoint-writer",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        }),
      ).toThrow(/checkpoint-writer allowlist/)
    })

    test("progress.md at <sid>/tasks/<id>/ allowed (unchanged from v4)", () => {
      const target = path.join(MEMORY_ROOT, "sessions", "sid", "tasks", "T1", "progress.md")
      expect(() =>
        assertMemoryWriteAllowed({
          target,
          agentName: "checkpoint-writer",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        }),
      ).not.toThrow()
    })

    test("scratch.md at <sid>/ root rejected for checkpoint-writer (only checkpoint*.md allowed)", () => {
      const target = path.join(MEMORY_ROOT, "sessions", "sid", "scratch.md")
      expect(() =>
        assertMemoryWriteAllowed({
          target,
          agentName: "checkpoint-writer",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        }),
      ).toThrow(/checkpoint-writer allowlist/)
    })

    test("non-memory-prefix .md at <pid>/ rejected for checkpoint-writer", () => {
      const target = path.join(MEMORY_ROOT, "projects", "abc-uuid", "notes.md")
      expect(() =>
        assertMemoryWriteAllowed({
          target,
          agentName: "checkpoint-writer",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        }),
      ).toThrow(/checkpoint-writer allowlist/)
    })

    test("task narrative notes.md for nested task ID allowed", () => {
      const target = path.join(MEMORY_ROOT, "sessions", "sid", "tasks", "T1.2", "notes.md")
      expect(() =>
        assertMemoryWriteAllowed({
          target,
          agentName: "checkpoint-writer",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        }),
      ).not.toThrow()
    })

    test("progress-archive.md in <sid>/tasks/<id>/ allowed (spillover)", () => {
      const target = path.join(MEMORY_ROOT, "sessions", "sid", "tasks", "T1", "progress-archive.md")
      expect(() =>
        assertMemoryWriteAllowed({
          target,
          agentName: "checkpoint-writer",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        }),
      ).not.toThrow()
    })

    test("non-task-id segment under <sid>/tasks/ rejected", () => {
      const target = path.join(MEMORY_ROOT, "sessions", "sid", "tasks", "weird-name", "progress.md")
      expect(() =>
        assertMemoryWriteAllowed({
          target,
          agentName: "checkpoint-writer",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        }),
      ).toThrow(/checkpoint-writer allowlist/)
    })

    test("any .md filename under <sid>/tasks/<id>/ allowed (blanket)", () => {
      const target = path.join(MEMORY_ROOT, "sessions", "sid", "tasks", "T1", "scratch.md")
      expect(() =>
        assertMemoryWriteAllowed({
          target,
          agentName: "checkpoint-writer",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        }),
      ).not.toThrow()
    })
  })

  describe("main agent paths (v5)", () => {
    test("main agent CAN write <pid>/memory.md (system prompt teaches it)", () => {
      const target = path.join(MEMORY_ROOT, "projects", "abc-uuid", "memory.md")
      expect(() =>
        assertMemoryWriteAllowed({
          target,
          agentName: "build",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        }),
      ).not.toThrow()
    })

    test("main agent CAN write <sid>/checkpoint.md (for §3 directives)", () => {
      const target = path.join(MEMORY_ROOT, "sessions", "sid", "checkpoint.md")
      expect(() =>
        assertMemoryWriteAllowed({
          target,
          agentName: "build",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        }),
      ).not.toThrow()
    })

    test("main agent rejected on <sid>/tasks/<id>/progress.md (writer-managed)", () => {
      const target = path.join(MEMORY_ROOT, "sessions", "sid", "tasks", "T1", "progress.md")
      expect(() =>
        assertMemoryWriteAllowed({
          target,
          agentName: "build",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        }),
      ).toThrow(/reserved for the checkpoint-writer/)
    })

    test("main agent CAN write free-key <sid>/scratch.md", () => {
      const target = path.join(MEMORY_ROOT, "sessions", "sid", "scratch.md")
      expect(() =>
        assertMemoryWriteAllowed({
          target,
          agentName: "build",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        }),
      ).not.toThrow()
    })
  })

  describe("error message: path format (main agent)", () => {
    const target = path.join(MEMORY_ROOT, "memory.md")
    const expectedMemoryFile = path.join(MEMORY_ROOT, "projects", "p_test", "MEMORY.md")
    const expectedNotesFile = path.join(MEMORY_ROOT, "sessions", "sid", "notes.md")

    function captureError(): Error {
      try {
        assertMemoryWriteAllowed({
          target,
          agentName: "build",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        })
      } catch (e) {
        return e as Error
      }
      throw new Error("expected assertMemoryWriteAllowed to throw")
    }

    test("contains resolved project memory path", () => {
      expect(captureError().message).toContain(expectedMemoryFile)
    })

    test("contains resolved notes path", () => {
      expect(captureError().message).toContain(expectedNotesFile)
    })

    test("contains the attempted target", () => {
      expect(captureError().message).toContain(target)
    })

    test("contains scope format hint", () => {
      expect(captureError().message).toContain("<scope>/<scope_id>/<key>.md")
    })

    test("enumerates valid scopes", () => {
      const msg = captureError().message
      expect(msg).toContain("global")
      expect(msg).toContain("projects")
      expect(msg).toContain("sessions")
    })

    test("notes free-form keys are allowed", () => {
      expect(captureError().message).toContain("Other free-form")
    })
  })

  describe("error message: invalid scope (main agent)", () => {
    const target = path.join(MEMORY_ROOT, "badscope", "sid", "foo.md")
    const expectedMemoryFile = path.join(MEMORY_ROOT, "projects", "p_test", "MEMORY.md")
    const expectedNotesFile = path.join(MEMORY_ROOT, "sessions", "sid", "notes.md")

    function captureError(): Error {
      try {
        assertMemoryWriteAllowed({
          target,
          agentName: "build",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        })
      } catch (e) {
        return e as Error
      }
      throw new Error("expected assertMemoryWriteAllowed to throw")
    }

    test("contains both resolved paths and attempted target", () => {
      const msg = captureError().message
      expect(msg).toContain(expectedMemoryFile)
      expect(msg).toContain(expectedNotesFile)
      expect(msg).toContain(target)
    })

    test("contains scope format hint and free-form note", () => {
      const msg = captureError().message
      expect(msg).toContain("<scope>/<scope_id>/<key>.md")
      expect(msg).toContain("Other free-form")
    })
  })

  describe("error message: reserved path (main agent)", () => {
    const target = path.join(MEMORY_ROOT, "sessions", "sid", "tasks", "T1", "progress.md")
    const expectedMemoryFile = path.join(MEMORY_ROOT, "projects", "p_test", "MEMORY.md")
    const expectedNotesFile = path.join(MEMORY_ROOT, "sessions", "sid", "notes.md")

    function captureError(): Error {
      try {
        assertMemoryWriteAllowed({
          target,
          agentName: "build",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        })
      } catch (e) {
        return e as Error
      }
      throw new Error("expected assertMemoryWriteAllowed to throw")
    }

    test("contains both resolved paths and attempted target", () => {
      const msg = captureError().message
      expect(msg).toContain(expectedMemoryFile)
      expect(msg).toContain(expectedNotesFile)
      expect(msg).toContain(target)
    })
  })

  describe("error message: writer allowlist", () => {
    const target = path.join(MEMORY_ROOT, "projects", "p_test", "pinned.md")
    const expectedMemoryFile = path.join(MEMORY_ROOT, "projects", "p_test", "MEMORY.md")
    const expectedCheckpointFile = path.join(MEMORY_ROOT, "sessions", "sid", "checkpoint.md")
    const expectedTaskMemDir = path.join(MEMORY_ROOT, "sessions", "sid", "tasks")

    function captureError(): Error {
      try {
        assertMemoryWriteAllowed({
          target,
          agentName: "checkpoint-writer",
          memoryRoot: MEMORY_ROOT,
          projectID: PROJECT_ID,
          sessionID: SESSION_ID,
        })
      } catch (e) {
        return e as Error
      }
      throw new Error("expected assertMemoryWriteAllowed to throw")
    }

    test("contains memoryFile + checkpointFile + taskMemDir + attempted target", () => {
      const msg = captureError().message
      expect(msg).toContain(expectedMemoryFile)
      expect(msg).toContain(expectedCheckpointFile)
      expect(msg).toContain(expectedTaskMemDir)
      expect(msg).toContain(target)
    })
  })

  test("subagent bound to T4 may write tasks/T4/progress.md", () => {
    const target = path.join(MEMORY_ROOT, "sessions", "sid", "tasks", "T4", "progress.md")
    expect(() =>
      assertMemoryWriteAllowed({
        target,
        agentName: "explore",
        memoryRoot: MEMORY_ROOT,
        projectID: PROJECT_ID,
        sessionID: SESSION_ID,
        taskId: "T4",
      }),
    ).not.toThrow()
  })

  test("subagent bound to T4 may write tasks/T4/spec.md (any .md filename under own TID)", () => {
    const target = path.join(MEMORY_ROOT, "sessions", "sid", "tasks", "T4", "spec.md")
    expect(() =>
      assertMemoryWriteAllowed({
        target,
        agentName: "general",
        memoryRoot: MEMORY_ROOT,
        projectID: PROJECT_ID,
        sessionID: SESSION_ID,
        taskId: "T4",
      }),
    ).not.toThrow()
  })

  test("subagent bound to T4 may NOT write tasks/T5/progress.md (cross-task escape)", () => {
    const target = path.join(MEMORY_ROOT, "sessions", "sid", "tasks", "T5", "progress.md")
    expect(() =>
      assertMemoryWriteAllowed({
        target,
        agentName: "explore",
        memoryRoot: MEMORY_ROOT,
        projectID: PROJECT_ID,
        sessionID: SESSION_ID,
        taskId: "T4",
      }),
    ).toThrow(/reserved for the checkpoint-writer/)
  })

  test("subagent bound to T4 may NOT write tasks/T4/raw (no .md extension)", () => {
    const target = path.join(MEMORY_ROOT, "sessions", "sid", "tasks", "T4", "raw")
    expect(() =>
      assertMemoryWriteAllowed({
        target,
        agentName: "explore",
        memoryRoot: MEMORY_ROOT,
        projectID: PROJECT_ID,
        sessionID: SESSION_ID,
        taskId: "T4",
      }),
    ).toThrow(/reserved for the checkpoint-writer/)
  })

  describe("path resolver byte-equality with checkpoint-paths.ts", () => {
    test("guard's projects/<pid>/memory.md tail equals memoryPath() tail", () => {
      const resolverOutput = memoryPath(PROJECT_ID)
      const memoryRootFromResolver = path.join(Global.Path.data, "memory")
      const tail = path.relative(memoryRootFromResolver, resolverOutput)
      expect(tail).toBe(path.join("projects", "p_test", "MEMORY.md"))
    })

    test("guard's sessions/<sid>/notes.md tail equals notesPath() tail", () => {
      const resolverOutput = notesPath(SESSION_ID)
      const memoryRootFromResolver = path.join(Global.Path.data, "memory")
      const tail = path.relative(memoryRootFromResolver, resolverOutput)
      expect(tail).toBe(path.join("sessions", "sid", "notes.md"))
    })

    test("guard's sessions/<sid>/checkpoint.md tail equals checkpointPath() tail", () => {
      const resolverOutput = checkpointPath(SESSION_ID)
      const memoryRootFromResolver = path.join(Global.Path.data, "memory")
      const tail = path.relative(memoryRootFromResolver, resolverOutput)
      expect(tail).toBe(path.join("sessions", "sid", "checkpoint.md"))
    })
  })
})
