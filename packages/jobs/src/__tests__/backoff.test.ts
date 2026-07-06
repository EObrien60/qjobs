import { describe, expect, it } from "vitest"
import { computeBackoffMs } from "../backoff"

const opts = { initialMs: 1000, maxMs: 60_000, factor: 2, jitter: false }

describe("computeBackoffMs", () => {
  it("grows exponentially without jitter", () => {
    expect(computeBackoffMs(1, opts)).toBe(1000)
    expect(computeBackoffMs(2, opts)).toBe(2000)
    expect(computeBackoffMs(3, opts)).toBe(4000)
  })

  it("caps at maxMs", () => {
    expect(computeBackoffMs(20, opts)).toBe(60_000)
  })

  it("keeps jitter within [half, full]", () => {
    const jittered = { ...opts, jitter: true }
    for (let i = 0; i < 200; i++) {
      const v = computeBackoffMs(3, jittered)
      expect(v).toBeGreaterThanOrEqual(2000)
      expect(v).toBeLessThanOrEqual(4000)
    }
  })
})
