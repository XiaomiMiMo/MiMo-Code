import { Schema } from "effect"

const NonNegativeInt = Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))
const MaxRetries = NonNegativeInt.check(Schema.isLessThanOrEqualTo(100))
const PositiveInt = Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThan(0))
const Ratio = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(1))

export const Budget = Schema.Struct({
  mode: Schema.optional(Schema.Literals(["bounded", "persistent"])),
  maxRetries: Schema.optional(MaxRetries),
  deadlineMs: Schema.optional(NonNegativeInt),
  initialDelayMs: Schema.optional(PositiveInt),
  maxDelayMs: Schema.optional(PositiveInt),
  jitterRatio: Schema.optional(Ratio),
})

export const Info = Schema.Struct({
  request: Schema.optional(Budget),
  stream: Schema.optional(Budget),
  maxCandidate: Schema.optional(Budget),
  maxJudge: Schema.optional(Budget),
  network: Schema.optional(Budget),
  server: Schema.optional(Budget),
  rateLimit: Schema.optional(Budget),
  unknown: Schema.optional(Budget),
  jitterRatio: Schema.optional(Ratio),
})

export type Budget = Schema.Schema.Type<typeof Budget>
export type Info = Schema.Schema.Type<typeof Info>

export * as ConfigRetry from "./retry"
