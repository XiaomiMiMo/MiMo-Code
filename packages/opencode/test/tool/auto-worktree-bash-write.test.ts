import { describe, expect, test } from "bun:test"
import { commandWritesFiles } from "../../src/tool/bash"

describe("bash commandWritesFiles", () => {
  test.each([
    ["echo test > output.txt", true],
    ["echo test >> log.txt", true],
    ["printf x > f", true],
    ["cmd 2> err.txt", true],
    ["cmd &> all.txt", true],
    ["echo hi | tee file", true],
    ["tee -a out.txt", true],
    ["cp a b", true],
    ["mv a b", true],
    ["touch f", true],
    ["mkdir d", true],
    ["install -m 644 a b", true],
    ["sed -i s/a/b/ file.txt", true],
    ["sed --in-place s/a/b/ file.txt", true],
    ["echo a > b && echo c >> d", true],
    ["cat <<EOF > file.txt\nhi\nEOF", true],
    ["ls -la", false],
    ["git status", false],
    ["cat file.txt", false],
    ["sed s/a/b/ file.txt", false],
    ["echo test", false],
    ["cmd 2>&1", false],
    ["python - <<PY\nprint(1)\nPY", false],
  ])("detects %s", async (command, expected) => {
    expect(await commandWritesFiles(command)).toBe(expected)
  })
})
