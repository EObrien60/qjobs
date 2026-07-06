import { describe, expect, it } from "vitest"
import { z } from "zod"
import { defineJob } from "../defineJob"
import { createJobRegistry } from "../registry"

const noop = async () => {}

const generatePodPdf = defineJob({
  name: "generate_pod_pdf",
  version: 1,
  schema: z.object({ consignmentId: z.string() }),
  handler: noop,
})

describe("createJobRegistry", () => {
  it("supports get / has / list / latestVersion", () => {
    const r = createJobRegistry([generatePodPdf])
    expect(r.get("generate_pod_pdf", 1)).toBeDefined()
    expect(r.has("generate_pod_pdf", 1)).toBe(true)
    expect(r.has("generate_pod_pdf", 2)).toBe(false)
    expect(r.list()).toHaveLength(1)
    expect(r.latestVersion("generate_pod_pdf")).toBe(1)
  })

  it("validates known payloads", () => {
    const r = createJobRegistry([generatePodPdf])
    expect(r.validate("generate_pod_pdf", 1, { consignmentId: "c1" }).ok).toBe(true)
    expect(r.validate("generate_pod_pdf", 1, {}).ok).toBe(false)
  })

  it("fails validation for unknown jobs (never silently ignored)", () => {
    const r = createJobRegistry([generatePodPdf])
    const result = r.validate("no_such_job", 1, {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/unknown job/i)
  })

  it("throws on duplicate definitions", () => {
    expect(() => createJobRegistry([generatePodPdf, generatePodPdf])).toThrow(/duplicate/i)
  })
})
