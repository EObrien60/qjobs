import { describe, expect, it } from "vitest"
import { z } from "zod"
import type { JobDb, QueryResult } from "../db"
import { createJobClient } from "../client"
import { defineJob } from "../defineJob"
import { createJobRegistry } from "../registry"
import type { JobRow } from "../rows"

/* eslint-disable @typescript-eslint/no-explicit-any */
function buildRow(params: unknown[], overrides: Partial<JobRow> = {}): JobRow {
  const [
    id,
    name,
    version,
    source,
    workspace_id,
    payloadJson,
    metadataJson,
    priority,
    run_after,
    max_attempts,
    idempotency_key,
    correlation_id,
    causation_id,
  ] = params as any[]
  return {
    id,
    name,
    version,
    source,
    workspace_id,
    payload: JSON.parse(payloadJson),
    metadata: JSON.parse(metadataJson),
    status: "queued",
    priority,
    run_after,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    started_at: null,
    finished_at: null,
    attempt_count: 0,
    max_attempts,
    locked_at: null,
    locked_by: null,
    idempotency_key,
    correlation_id,
    causation_id,
    progress: {},
    result: null,
    last_error: null,
    ...overrides,
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

type Call = { sql: string; params?: unknown[] }

function fakeDb(handler: (call: Call) => QueryResult<JobRow>) {
  const calls: Call[] = []
  const db: JobDb = {
    async query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
      const call = { sql, params }
      calls.push(call)
      return handler(call) as unknown as QueryResult<T>
    },
  }
  return { db, calls }
}

describe("createJobClient.enqueue", () => {
  it("inserts a job row and returns a record", async () => {
    const { db, calls } = fakeDb((call) => ({ rows: [buildRow(call.params ?? [])] }))
    const client = createJobClient({ source: "qhaul" })
    const job = await client.enqueue(db, {
      name: "generate_pod_pdf",
      workspaceId: "ws_1",
      payload: { consignmentId: "con_1" },
      idempotencyKey: "pod:con_1",
    })

    expect(calls[0]?.sql).toContain("insert into platform.jobs")
    expect(job.name).toBe("generate_pod_pdf")
    expect(job.source).toBe("qhaul")
    expect(job.workspaceId).toBe("ws_1")
    expect(job.status).toBe("queued")
    expect(job.maxAttempts).toBe(10)
    expect(job.id.startsWith("job_")).toBe(true)
    expect(job.idempotencyKey).toBe("pod:con_1")
    expect(job.payload).toEqual({ consignmentId: "con_1" })
  })

  it("supports the (db, name, input) overload", async () => {
    const { db } = fakeDb((call) => ({ rows: [buildRow(call.params ?? [])] }))
    const client = createJobClient({ source: "qhaul" })
    const job = await client.enqueue(db, "cleanup_expired_uploads", {
      workspaceId: "ws_1",
      payload: {},
    })
    expect(job.name).toBe("cleanup_expired_uploads")
  })

  it("returns the existing job when the idempotency key conflicts", async () => {
    const existing = buildRow(
      ["job_existing", "generate_pod_pdf", 1, "qhaul", "ws_1", "{}", "{}", 0, "x", 10, "pod:con_1", null, null],
      { id: "job_existing" },
    )
    const { db, calls } = fakeDb((call) => {
      if (call.sql.includes("insert into platform.jobs")) return { rows: [] } // do nothing fired
      return { rows: [existing] } // the follow-up select
    })
    const client = createJobClient({ source: "qhaul" })
    const job = await client.enqueue(db, {
      name: "generate_pod_pdf",
      workspaceId: "ws_1",
      payload: { consignmentId: "con_1" },
      idempotencyKey: "pod:con_1",
    })
    expect(job.id).toBe("job_existing")
    // second call is the select scoped by (source, idempotencyKey)
    expect(calls[1]?.sql).toContain("select * from platform.jobs")
    expect(calls[1]?.params).toEqual(["qhaul", "pod:con_1"])
  })

  it("uses the definition's defaultMaxAttempts when set", async () => {
    const def = defineJob({
      name: "process_invoice_ocr",
      version: 1,
      schema: z.object({ invoiceId: z.string() }),
      handler: async () => {},
      defaultMaxAttempts: 3,
    })
    const registry = createJobRegistry([def])
    const { db } = fakeDb((call) => ({ rows: [buildRow(call.params ?? [])] }))
    const client = createJobClient({ source: "qmechanic", registry })
    const job = await client.enqueue(db, {
      name: "process_invoice_ocr",
      workspaceId: "ws_1",
      payload: { invoiceId: "inv_1" },
    })
    expect(job.maxAttempts).toBe(3)
  })

  it("rejects invalid payloads for known jobs", async () => {
    const def = defineJob({
      name: "process_invoice_ocr",
      version: 1,
      schema: z.object({ invoiceId: z.string() }),
      handler: async () => {},
    })
    const registry = createJobRegistry([def])
    const { db, calls } = fakeDb(() => ({ rows: [] }))
    const client = createJobClient({ source: "qmechanic", registry })
    await expect(
      client.enqueue(db, { name: "process_invoice_ocr", workspaceId: "ws_1", payload: {} }),
    ).rejects.toThrow(/invalid payload/i)
    expect(calls).toHaveLength(0)
  })

  it("requires workspaceId", async () => {
    const { db, calls } = fakeDb(() => ({ rows: [] }))
    const client = createJobClient({ source: "qhaul" })
    await expect(
      client.enqueue(db, { name: "generate_pod_pdf", workspaceId: "", payload: {} }),
    ).rejects.toThrow(/workspaceId/)
    expect(calls).toHaveLength(0)
  })
})

describe("createJobClient.cancel", () => {
  it("returns the cancelled job when a row was updated", async () => {
    const row = buildRow(
      ["job_1", "generate_pod_pdf", 1, "qhaul", "ws_1", "{}", "{}", 0, "x", 10, null, null, null],
      { status: "cancelled" },
    )
    const { db } = fakeDb(() => ({ rows: [row] }))
    const client = createJobClient({ source: "qhaul" })
    const result = await client.cancel(db, "job_1")
    expect(result?.status).toBe("cancelled")
  })

  it("returns null when nothing was cancellable", async () => {
    const { db } = fakeDb(() => ({ rows: [] }))
    const client = createJobClient({ source: "qhaul" })
    expect(await client.cancel(db, "job_x")).toBeNull()
  })
})
