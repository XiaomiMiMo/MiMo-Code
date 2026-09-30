import { describe, test, expect } from "bun:test"
import { extractTitlesFromLearning } from "../../src/session/checkpoint-validator"

describe("extractTitlesFromLearning", () => {
  test("returns titles from a body that opens with `### Discovered` (legacy shape)", () => {
    const body = `### Discovered

- title one
  Why: ...
  How to apply: ...

- title two
  Why: ...

### Dead ends
`
    expect(extractTitlesFromLearning(body)).toEqual(["title one", "title two"])
  })

  test("returns titles when the file opens with a Topic line (new shape)", () => {
    const body = `Topic: parser left-recursion needs precedence climbing

### Discovered

- title one
  Why: ...

- title two

### Dead ends
`
    expect(extractTitlesFromLearning(body)).toEqual(["title one", "title two"])
  })

  test("tolerates extra blank lines between Topic and Discovered", () => {
    const body = `Topic: foo


### Discovered

- only title
`
    expect(extractTitlesFromLearning(body)).toEqual(["only title"])
  })

  test("returns [] when there is no Discovered section", () => {
    const body = `Topic: foo

### Dead ends
- failed approach
`
    expect(extractTitlesFromLearning(body)).toEqual([])
  })

  test("returns [] for empty body", () => {
    expect(extractTitlesFromLearning("")).toEqual([])
  })
})
