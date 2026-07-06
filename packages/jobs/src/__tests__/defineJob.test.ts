import { describe, expect, it } from "vitest"
import { z } from "zod"
import { defineJob } from "../defineJob"

const noop = async () => {}

describe("defineJob", () => {
  it("accepts snake_case names", () => {
    const j = defineJob({
      name: "generate_pod_pdf",
      version: 1,
      schema: z.object({ consignmentId: z.string() }),
      handler: noop,
    })
    expect(j.name).toBe("generate_pod_pdf")
    expect(j.version).toBe(1)
  })

  it("rejects event-style dotted names with a helpful message", () => {
    expect(() =>
      defineJob({ name: "consignment.delivered", version: 1, schema: z.object({}), handler: noop }),
    ).toThrow(/event name/i)
  })

  it("rejects non snake_case names", () => {
    expect(() =>
      defineJob({ name: "GeneratePdf", version: 1, schema: z.object({}), handler: noop }),
    ).toThrow(/snake_case/i)
    expect(() =>
      defineJob({ name: "send report", version: 1, schema: z.object({}), handler: noop }),
    ).toThrow(/snake_case/i)
  })

  it("rejects invalid versions and maxAttempts", () => {
    expect(() =>
      defineJob({ name: "a_b", version: 0, schema: z.object({}), handler: noop }),
    ).toThrow(/version/i)
    expect(() =>
      defineJob({
        name: "a_b",
        version: 1,
        schema: z.object({}),
        handler: noop,
        defaultMaxAttempts: 0,
      }),
    ).toThrow(/maxattempts/i)
  })

  it("carries defaults through", () => {
    const j = defineJob({
      name: "process_invoice_ocr",
      version: 2,
      schema: z.object({ invoiceId: z.string() }),
      handler: noop,
      defaultMaxAttempts: 3,
      defaultTimeoutMs: 30_000,
    })
    expect(j.defaultMaxAttempts).toBe(3)
    expect(j.defaultTimeoutMs).toBe(30_000)
  })
})
