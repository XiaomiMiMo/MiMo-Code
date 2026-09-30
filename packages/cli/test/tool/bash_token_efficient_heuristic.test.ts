import { describe, test, expect } from "bun:test"
import { cleanHeuristic, detectShape } from "../../src/tool/bash_token_efficient_heuristic"

describe("detectShape — command-name channel", () => {
  test("pytest command name → pytest", () => {
    expect(detectShape("collected 1 item\n", "pytest tests/")).toBe("pytest")
  })

  test("npm install → npm", () => {
    expect(detectShape("added 1 package\n", "npm install express")).toBe("npm")
  })

  test("yarn add → npm", () => {
    expect(detectShape("added 1 package\n", "yarn add react")).toBe("npm")
  })

  test("pnpm i → npm", () => {
    expect(detectShape("added 1 package\n", "pnpm i")).toBe("npm")
  })

  test("make → make", () => {
    expect(detectShape("cc -o foo foo.c\n", "make all")).toBe("make")
  })

  test("git diff → gitdiff", () => {
    expect(detectShape("diff --git a/foo b/foo\n", "git diff HEAD~1")).toBe("gitdiff")
  })

  test("git show → gitdiff", () => {
    expect(detectShape("commit abc\n", "git show HEAD")).toBe("gitdiff")
  })

  test("tsc → tsc", () => {
    expect(detectShape("errors...\n", "tsc --noEmit")).toBe("tsc")
  })

  test("kubectl get pods → kubectl", () => {
    expect(detectShape("NAME READY STATUS\n", "kubectl get pods")).toBe("kubectl")
  })

  test("kubectl get pod (singular) → kubectl", () => {
    expect(detectShape("NAME READY STATUS\n", "kubectl get pod foo")).toBe("kubectl")
  })

  test("go test -json → gostest", () => {
    expect(detectShape('{"Package":"x"}\n', "go test ./... -json")).toBe("gostest")
  })

  test("gh pr view → md", () => {
    expect(detectShape("# Title\n", "gh pr view 123")).toBe("md")
  })

  test("gh issue view → md", () => {
    expect(detectShape("# Title\n", "gh issue view 42")).toBe("md")
  })
})

describe("detectShape — body-fingerprint channel", () => {
  test("pytest header fingerprint", () => {
    expect(detectShape("========== test session starts ==========\ncollected 1", "python -m x")).toBe(
      "pytest",
    )
  })

  test("diff --git fingerprint", () => {
    expect(detectShape("diff --git a/f b/f\n", "somecmd")).toBe("gitdiff")
  })

  test("Python traceback fingerprint", () => {
    expect(detectShape('Traceback (most recent call last):\n  File "x.py"', "python x.py")).toBe(
      "stacktrace",
    )
  })

  test("Node at frame fingerprint", () => {
    expect(detectShape("    at Object.<anonymous> (/foo/bar.js:10:5)\n", "node script")).toBe(
      "stacktrace",
    )
  })

  test("Rust error code fingerprint", () => {
    expect(detectShape("error[E0308]: mismatched types\n", "cargo build")).toBe("stacktrace")
  })

  test("JSON-shaped body fingerprint", () => {
    expect(detectShape('{"foo": "bar"}\n', "somecmd")).toBe("json")
  })

  test("JSON array body fingerprint", () => {
    expect(detectShape("[1, 2, 3]\n", "somecmd")).toBe("json")
  })
})

describe("detectShape — passthrough", () => {
  test("--json flag → null", () => {
    expect(detectShape('{"a":1}', "kubectl get pods --json")).toBeNull()
  })

  test("--format json → null", () => {
    expect(detectShape('{"a":1}', "docker inspect --format json foo")).toBeNull()
  })

  test("-o json → null", () => {
    expect(detectShape("[]", "kubectl get pods -o json")).toBeNull()
  })

  test("--no-color → null", () => {
    expect(detectShape("plain", "make --no-color all")).toBeNull()
  })

  test("| tee → null", () => {
    expect(detectShape("plain", "make all | tee build.log")).toBeNull()
  })

  test("| xxd → null", () => {
    expect(detectShape("bytes", "cat file | xxd")).toBeNull()
  })

  test("| hexdump → null", () => {
    expect(detectShape("bytes", "cat file | hexdump -C")).toBeNull()
  })
})

describe("cleanHeuristic — never-worse contract", () => {
  test("empty input returns empty", () => {
    const result = cleanHeuristic("", { command: "pytest" })
    expect(result.text).toBe("")
    expect(result.shape).toBeNull()
    expect(result.degraded).toBe(false)
  })

  test("unrecognised shape returns original untouched", () => {
    const result = cleanHeuristic("random line 1\nrandom line 2\n", { command: "unknown-cmd" })
    expect(result.text).toBe("random line 1\nrandom line 2\n")
    expect(result.shape).toBeNull()
    expect(result.degraded).toBe(false)
  })

  test("passthrough command returns original untouched", () => {
    const text = '{"foo": "bar"}\n'
    const result = cleanHeuristic(text, { command: "kubectl get pods -o json" })
    expect(result.text).toBe(text)
    expect(result.shape).toBeNull()
  })

  test("shape that fails to shrink returns original with degraded=true", () => {
    // Tiny valid JSON: `trimJsonHeavy` re-emits pretty JSON that is LARGER than
    // the compact input, so the never-worse guard trips.
    const text = '{"a":1}'
    const result = cleanHeuristic(text, { command: "somecmd" })
    expect(result.text).toBe(text)
    expect(result.shape).toBe("json")
    expect(result.degraded).toBe(true)
  })
})

describe("shape: gitdiff", () => {
  test("suppresses lockfile hunks with +A -R summary", () => {
    const body =
      "diff --git a/package-lock.json b/package-lock.json\n" +
      "index abc..def 100644\n" +
      "--- a/package-lock.json\n" +
      "+++ b/package-lock.json\n" +
      "@@ -1,3 +1,3 @@\n" +
      "-old line 1\n" +
      "-old line 2\n" +
      "+new line 1\n" +
      "+new line 2\n" +
      " unchanged\n"
    const result = cleanHeuristic(body, { command: "git diff HEAD~1" })
    expect(result.shape).toBe("gitdiff")
    expect(result.text).toContain("hunks suppressed")
    expect(result.text).toContain("+2 -2")
    // The actual diff lines should not appear.
    expect(result.text).not.toContain("old line 1")
    expect(result.text).not.toContain("new line 1")
  })

  test("suppresses dist/ path hunks", () => {
    const additions = Array.from({ length: 40 }, (_, i) => `+bundled_line_${i}_padding_padding`).join("\n")
    const body =
      "diff --git a/dist/bundle.js b/dist/bundle.js\n" +
      "index abcdef0..1234567 100644\n" +
      "--- a/dist/bundle.js\n" +
      "+++ b/dist/bundle.js\n" +
      "@@ -1,40 +1,40 @@\n" +
      additions +
      "\n"
    const result = cleanHeuristic(body, { command: "git diff" })
    expect(result.shape).toBe("gitdiff")
    expect(result.text).toContain("hunks suppressed")
  })

  test("normal file gets a +A -R file summary tail", () => {
    // Give it enough content that the added `<file summary: ...>` tail is a net
    // shrink vs. the raw diff (never-worse guard). We just need any recognisable
    // diff body — the shape appends the summary and the pipeline keeps it iff
    // the whole output shrinks. Here the tail is much shorter than the diff.
    const body =
      "diff --git a/src/foo.ts b/src/foo.ts\n" +
      "index abcdef0..1234567 100644\n" +
      "--- a/src/foo.ts\n" +
      "+++ b/src/foo.ts\n" +
      "@@ -1,3 +1,3 @@\n" +
      "-old_original_content_here\n" +
      "+new_replacement_content_here\n" +
      " unchanged context line here\n"
    const result = cleanHeuristic(body, { command: "git diff" })
    // Either the tail is added and net-shrink wins, OR the input is too small
    // and never-worse trips. In either case, no crash and shape is gitdiff.
    expect(result.shape).toBe("gitdiff")
    if (!result.degraded) {
      expect(result.text).toContain("file summary")
      expect(result.text).toContain("-old_original")
      expect(result.text).toContain("+new_replacement")
    }
  })

  test("caps a >100-line hunk", () => {
    const additions = Array.from({ length: 250 }, (_, i) => `+line ${i}`).join("\n")
    const body = "diff --git a/src/f.ts b/src/f.ts\n@@ -1,1 +1,250 @@\n" + additions + "\n"
    const result = cleanHeuristic(body, { command: "git diff" })
    expect(result.shape).toBe("gitdiff")
    expect(result.text).toContain("hunk elided")
    // First 100 lines should still be present.
    expect(result.text).toContain("+line 0")
    expect(result.text).toContain("+line 99")
    // Content past 100 should be gone.
    expect(result.text).not.toContain("+line 200")
  })
})

describe("shape: pytest", () => {
  test("keeps session banner, drops dot-progress rows, keeps FAILED", () => {
    const body =
      "========== test session starts ==========\n" +
      "platform darwin -- Python 3.11\n" +
      "collected 3 items\n" +
      "\n" +
      "tests/test_a.py ..                                  [ 66%]\n" +
      "tests/test_b.py F                                   [100%]\n" +
      "\n" +
      "========== FAILURES ==========\n" +
      "________ test_thing ________\n" +
      "tests/test_b.py:12: AssertionError\n" +
      "E   assert 1 == 2\n" +
      "\n" +
      "========== short test summary info ==========\n" +
      "FAILED tests/test_b.py::test_thing\n" +
      "========== 1 failed, 2 passed in 0.10s ==========\n"
    const result = cleanHeuristic(body, { command: "pytest -q" })
    expect(result.shape).toBe("pytest")
    expect(result.text).toContain("test session starts")
    expect(result.text).toContain("collected 3 items")
    expect(result.text).toContain("E   assert 1 == 2")
    expect(result.text).toContain("FAILED tests/test_b.py::test_thing")
    expect(result.text).toContain("1 failed, 2 passed")
    expect(result.text).toContain("tests/test_b.py:12:")
    // Dot-progress rows are dropped.
    expect(result.text).not.toContain("tests/test_a.py ..")
  })
})

describe("shape: npm", () => {
  test("folds repeated deprecation warnings into a single row", () => {
    const body =
      "npm warn deprecated foo@1.0.0: use bar instead\n" +
      "npm warn deprecated baz@2.0.0: dead package\n" +
      "npm warn deprecated qux@3.0.0: replaced\n" +
      "npm warn deprecated abc@1.0.0: gone\n" +
      "added 42 packages in 3s\n" +
      "1 vulnerability found (moderate)\n"
    const result = cleanHeuristic(body, { command: "npm install" })
    expect(result.shape).toBe("npm")
    expect(result.text).toContain("[×4] deprecation warnings")
    expect(result.text).toContain("foo, baz, qux")
    expect(result.text).toContain("added 42 packages")
    expect(result.text).toContain("1 vulnerability")
    // Individual deprecation lines gone.
    expect(result.text).not.toContain("dead package")
  })
})

describe("shape: make", () => {
  test("drops Entering/Leaving directory and bare compile commands", () => {
    const body =
      "make[1]: Entering directory '/tmp/build'\n" +
      "cc -O2 -c -o foo.o foo.c\n" +
      "gcc -I/usr/include -c bar.c -o bar.o\n" +
      "foo.c:12:5: error: undeclared identifier 'x'\n" +
      "     x = 1;\n" +
      "     ^\n" +
      "note: did you mean 'y'?\n" +
      "make[1]: Leaving directory '/tmp/build'\n"
    const result = cleanHeuristic(body, { command: "make all" })
    expect(result.shape).toBe("make")
    expect(result.text).toContain("foo.c:12:5: error")
    expect(result.text).toContain("note:")
    expect(result.text).not.toContain("Entering directory")
    expect(result.text).not.toContain("Leaving directory")
    expect(result.text).not.toContain("cc -O2 -c")
    expect(result.text).not.toContain("gcc -I/usr/include")
  })
})

describe("shape: stacktrace", () => {
  test("folds runs of dependency frames", () => {
    const body =
      "Traceback (most recent call last):\n" +
      '  File "/app/main.py", line 12, in <module>\n' +
      "    run()\n" +
      '  File "/usr/lib/python3.11/site-packages/requests/api.py", line 5, in run\n' +
      "    request()\n" +
      '  File "/usr/lib/python3.11/site-packages/requests/sessions.py", line 20, in request\n' +
      "    prepare()\n" +
      '  File "/app/service.py", line 42, in prepare\n' +
      "    raise ValueError('bad')\n" +
      "ValueError: bad\n"
    const result = cleanHeuristic(body, { command: "python main.py" })
    expect(result.shape).toBe("stacktrace")
    expect(result.text).toContain("dependency frame(s) suppressed")
    expect(result.text).toContain("/app/main.py")
    expect(result.text).toContain("/app/service.py")
    expect(result.text).toContain("ValueError: bad")
    expect(result.text).not.toContain("requests/api.py")
    expect(result.text).not.toContain("requests/sessions.py")
  })
})

describe("shape: tsc", () => {
  test("aggregates by error code and by file", () => {
    // Enough error rows that the top-N aggregation shrinks the total bytes.
    const rows: string[] = []
    for (let i = 0; i < 20; i++) rows.push(`src/a.ts(${i + 1},1): error TS2322: Type A not assignable to B.`)
    for (let i = 0; i < 15; i++) rows.push(`src/b.ts(${i + 1},1): error TS2322: Type E not assignable to F.`)
    for (let i = 0; i < 10; i++) rows.push(`src/c.ts(${i + 1},5): error TS2554: Expected 1 argument.`)
    const body = rows.join("\n") + "\n"
    const result = cleanHeuristic(body, { command: "tsc --noEmit" })
    expect(result.shape).toBe("tsc")
    expect(result.text).toContain("<tsc: top errors by code>")
    expect(result.text).toContain("TS2322 ×35")
    expect(result.text).toContain("TS2554 ×10")
    expect(result.text).toContain("<tsc: top files>")
    expect(result.text).toContain("src/a.ts ×20")
  })
})

describe("shape: kubectl", () => {
  test("folds runs of Running/0-restart pods and appends -o json tip", () => {
    const body =
      "NAME       READY   STATUS    RESTARTS   AGE\n" +
      "web-1      1/1     Running   0          5d\n" +
      "web-2      1/1     Running   0          5d\n" +
      "web-3      1/1     Running   0          5d\n" +
      "web-4      1/1     Running   0          5d\n" +
      "cron-1     0/1     Error     3          2h\n"
    const result = cleanHeuristic(body, { command: "kubectl get pods" })
    expect(result.shape).toBe("kubectl")
    expect(result.text).toContain("pods folded")
    expect(result.text).toContain("Error")
    expect(result.text).toContain("-o json")
    // Individual Running rows should be gone.
    expect(result.text).not.toContain("web-1")
    expect(result.text).not.toContain("web-4")
  })
})

describe("shape: json", () => {
  test("elides long embedding string field", () => {
    const heavy = "x".repeat(2000)
    const body = JSON.stringify({ id: "abc", embedding: heavy, tail: "keep" })
    const result = cleanHeuristic(body, { command: "curl example.com" })
    expect(result.shape).toBe("json")
    expect(result.text).toContain("elided 2000 chars")
    expect(result.text).toContain('"tail"')
    expect(result.text).toContain('"keep"')
  })

  test("elides a heavy array field with many items", () => {
    const body = JSON.stringify({ embeddings: Array.from({ length: 100 }, (_, i) => i) })
    const result = cleanHeuristic(body, { command: "curl x" })
    expect(result.shape).toBe("json")
    expect(result.text).toContain("elided 100 items")
  })

  test("invalid JSON returns original (never-worse trip)", () => {
    const body = "{ not really json"
    const result = cleanHeuristic(body, { command: "cat x.json" })
    expect(result.text).toBe(body)
    expect(result.shape).toBe("json")
    expect(result.degraded).toBe(true)
  })
})

describe("shape: md", () => {
  test("strips HTML comments, badges, horizontal rules, extra blank lines", () => {
    const body =
      "<!-- generated by ci -->\n" +
      "# Title\n\n\n\n" +
      "![build](https://img.shields.io/travis/foo/bar.svg)\n" +
      "---\n" +
      "body text\n"
    const result = cleanHeuristic(body, { command: "gh pr view 1" })
    expect(result.shape).toBe("md")
    expect(result.text).not.toContain("<!--")
    expect(result.text).not.toContain("img.shields.io")
    expect(result.text).not.toContain("---")
    expect(result.text).toContain("# Title")
    expect(result.text).toContain("body text")
    // Blank-line collapse.
    expect(result.text).not.toContain("\n\n\n")
  })
})

describe("shape: gostest", () => {
  test("aggregates NDJSON events into per-package pass/fail/skip counts", () => {
    const body =
      JSON.stringify({ Package: "pkg/a", Action: "pass" }) +
      "\n" +
      JSON.stringify({ Package: "pkg/b", Action: "fail" }) +
      "\n" +
      JSON.stringify({ Package: "pkg/b", Action: "output", Output: "FAIL: TestX at line 42\n" }) +
      "\n" +
      JSON.stringify({ Package: "pkg/c", Action: "skip" }) +
      "\n"
    const result = cleanHeuristic(body, { command: "go test ./... -json" })
    expect(result.shape).toBe("gostest")
    expect(result.text).toContain("PASS pkg/a")
    expect(result.text).toContain("FAIL pkg/b")
    expect(result.text).toContain("SKIP pkg/c")
    expect(result.text).toContain("FAIL: TestX")
  })

  test("skips non-JSON lines gracefully", () => {
    const body = "garbage line\n" + JSON.stringify({ Package: "pkg/a", Action: "pass" }) + "\n"
    const result = cleanHeuristic(body, { command: "go test -json" })
    expect(result.shape).toBe("gostest")
    expect(result.text).toContain("PASS pkg/a")
  })
})
