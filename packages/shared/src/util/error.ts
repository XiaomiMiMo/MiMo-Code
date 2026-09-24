import z from "zod"

export const HOST_RETRY_CLASSES = ["terminal", "persistent", "bounded"] as const

export abstract class NamedError extends Error {
  abstract schema(): z.core.$ZodType
  abstract toObject(): { name: string; data: any }
  /** Optional host registry stamp (merged into toObject().data). */
  hostCode?: string
  hostRetryClass?: string

  static hasName(error: unknown, name: string): boolean {
    return (
      typeof error === "object" && error !== null && "name" in error && (error as Record<string, unknown>).name === name
    )
  }

  static create<Name extends string, Data extends z.core.$ZodType>(name: Name, data: Data) {
    const schema = z
      .object({
        name: z.literal(name),
        data,
      })
      .meta({
        ref: name,
      })
    const result = class extends NamedError {
      public static readonly Schema = schema

      public override readonly name = name as Name

      constructor(
        public readonly data: z.input<Data>,
        options?: ErrorOptions,
      ) {
        super(name, options)
        this.name = name
      }

      static isInstance(input: any): input is InstanceType<typeof result> {
        return typeof input === "object" && "name" in input && input.name === name
      }

      schema() {
        return schema
      }

      toObject() {
        if (this.hostCode || this.hostRetryClass) {
          const base =
            this.data !== null && typeof this.data === "object"
              ? ({ ...(this.data as Record<string, unknown>) } as Record<string, unknown>)
              : ({ value: this.data } as Record<string, unknown>)
          if (this.hostCode) base.hostCode = this.hostCode
          if (this.hostRetryClass) base.hostRetryClass = this.hostRetryClass
          return { name: name, data: base as z.input<Data> }
        }
        return {
          name: name,
          data: this.data,
        }
      }
    }
    Object.defineProperty(result, "name", { value: name })
    return result
  }

  public static readonly Unknown = NamedError.create(
    "UnknownError",
    z.object({
      message: z.string(),
      hostCode: z.string().optional(),
      hostRetryClass: z.enum(HOST_RETRY_CLASSES).optional(),
      metadata: z.record(z.string(), z.string()).optional(),
    }),
  )
}
