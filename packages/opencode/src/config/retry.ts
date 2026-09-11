import { Schema } from "effect"

const NonNegativeInt = Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))
const MaxRetries = NonNegativeInt.check(Schema.isLessThanOrEqualTo(100))
const PositiveInt = Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThan(0))
const Ratio = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(1))
const DeadlineOptions = Schema.makeFilter<{ deadlineMs?: number; noDeadline?: boolean }>((input) =>
  input.deadlineMs === undefined || input.noDeadline !== true || {
    path: ["noDeadline"],
    message: "deadlineMs and noDeadline cannot be configured together",
  },
)

export const Budget = Schema.Struct({
  mode: Schema.optional(Schema.Literals(["bounded", "persistent"])).annotate({
    description: "bounded stops after maxRetries; persistent ignores the retry count and waits until cancellation or deadline",
  }),
  maxRetries: Schema.optional(MaxRetries).annotate({
    description: "Retries after the initial attempt; 0 disables retries and the maximum is 100",
  }),
  deadlineMs: Schema.optional(PositiveInt).annotate({
    description: "Wall-clock retry deadline in milliseconds; use noDeadline for an explicit unlimited deadline",
  }),
  noDeadline: Schema.optional(Schema.Boolean).annotate({
    description: "Disable the wall-clock retry deadline explicitly; maxRetries still applies to bounded budgets",
  }),
  initialDelayMs: Schema.optional(PositiveInt),
  maxDelayMs: Schema.optional(PositiveInt),
  jitterRatio: Schema.optional(Ratio),
}).check(DeadlineOptions)

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
