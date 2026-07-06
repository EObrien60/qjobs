import { Pool } from "pg"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { z } from "zod"
import { pgAdapter } from "../adapters/pg"
import { createJobClient } from "../client"
import { defineJob } from "../defineJob"
import { createJobRegistry } from "../registry"
import { runMigrations } from "../migrations"
import { createWorker } from "../worker"

// Integration tests: require a real Postgres. Skipped automatically when
// DATABASE_URL is not set, so `pnpm test` stays green on a laptop with no DB.
const url = process.env.DATABASE_URL
const suite = url ? describe : describe.skip

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

suite("integration: enqueue -> claim -> run", () => {
  const pool = new Pool({ connectionString: url })
  const db = pgAdapter(pool)

  const state = { okRuns: 0, failRuns: 0, counter: 0 }

  const okJob = defineJob({
    name: "ok_job",
    version: 1,
    schema: z.object({ label: z.string() }),
    handler: async (ctx, payload) => {
      await ctx.progress({ step: 1, total: 1 })
      state.okRuns++
      return { done: true, label: payload.label }
    },
  })

  const failJob = defineJob({
    name: "fail_job",
    version: 1,
    schema: z.object({}),
    handler: async () => {
      state.failRuns++
      throw new Error("boom")
    },
  })

  const counterJob = defineJob({
    name: "counter_job",
    version: 1,
    schema: z.object({}),
    handler: async () => {
      state.counter++
      await sleep(15)
    },
  })

  const registry = createJobRegistry([okJob, failJob, counterJob])
  const client = createJobClient({ source: "test", registry })

  beforeAll(async () => {
    await runMigrations(db)
  })

  beforeEach(async () => {
    state.okRuns = 0
    state.failRuns = 0
    state.counter = 0
    await db.query("truncate platform.jobs")
  })

  afterAll(async () => {
    await pool.end()
  })

  it("runs a job to success with result and progress", async () => {
    const job = await client.enqueue(db, {
      name: "ok_job",
      workspaceId: "ws_int",
      payload: { label: "hello" },
    })

    const worker = createWorker({ db, registry, instanceId: "w1" })
    expect(await worker.tick()).toBe(1)
    expect(state.okRuns).toBe(1)

    const row = await db.query<{
      status: string
      result: { done: boolean; label: string } | null
      progress: { step?: number }
      attempt_count: number
      finished_at: string | null
    }>(
      "select status, result, progress, attempt_count, finished_at from platform.jobs where id=$1",
      [job.id],
    )
    expect(row.rows[0]?.status).toBe("succeeded")
    expect(row.rows[0]?.result).toEqual({ done: true, label: "hello" })
    expect(row.rows[0]?.progress?.step).toBe(1)
    expect(row.rows[0]?.attempt_count).toBe(1)
    expect(row.rows[0]?.finished_at).not.toBeNull()
  })

  it("retries on failure with backoff, then dead-letters at max attempts", async () => {
    const job = await client.enqueue(db, {
      name: "fail_job",
      workspaceId: "ws_int",
      payload: {},
      maxAttempts: 2,
    })

    const worker = createWorker({
      db,
      registry,
      instanceId: "w1",
      backoff: { initialMs: 1, maxMs: 5, factor: 2, jitter: false },
    })

    // Attempt 1 -> failed, scheduled for a retry
    await worker.tick()
    let row = await db.query<{ status: string; attempt_count: number }>(
      "select status, attempt_count from platform.jobs where id=$1",
      [job.id],
    )
    expect(row.rows[0]?.status).toBe("failed")
    expect(row.rows[0]?.attempt_count).toBe(1)

    // Attempt 2 -> dead
    await sleep(25)
    await worker.tick()
    row = await db.query<{ status: string; attempt_count: number }>(
      "select status, attempt_count from platform.jobs where id=$1",
      [job.id],
    )
    expect(row.rows[0]?.status).toBe("dead")
    expect(row.rows[0]?.attempt_count).toBe(2)
    expect(state.failRuns).toBe(2)

    // Dead jobs are not claimed again
    await sleep(25)
    expect(await worker.tick()).toBe(0)
  })

  it("returns the existing job for a repeated idempotency key", async () => {
    const a = await client.enqueue(db, {
      name: "ok_job",
      workspaceId: "ws_int",
      payload: { label: "x" },
      idempotencyKey: "ok:x",
    })
    const b = await client.enqueue(db, {
      name: "ok_job",
      workspaceId: "ws_int",
      payload: { label: "x" },
      idempotencyKey: "ok:x",
    })
    expect(b.id).toBe(a.id)

    const count = await db.query<{ n: string }>(
      "select count(*)::text as n from platform.jobs where source='test' and idempotency_key='ok:x'",
    )
    expect(count.rows[0]?.n).toBe("1")
  })

  it("does not claim a scheduled job before run_after", async () => {
    await client.enqueue(db, {
      name: "ok_job",
      workspaceId: "ws_int",
      payload: { label: "later" },
      runAfter: new Date(Date.now() + 60 * 60 * 1000),
    })
    const worker = createWorker({ db, registry, instanceId: "w1" })
    expect(await worker.tick()).toBe(0)
    expect(state.okRuns).toBe(0)
  })

  it("cancels a queued job so it never runs", async () => {
    const job = await client.enqueue(db, {
      name: "ok_job",
      workspaceId: "ws_int",
      payload: { label: "nope" },
    })
    const cancelled = await client.cancel(db, job.id)
    expect(cancelled?.status).toBe("cancelled")

    const worker = createWorker({ db, registry, instanceId: "w1" })
    expect(await worker.tick()).toBe(0)
    expect(state.okRuns).toBe(0)
  })

  it("dead-letters an unknown job with a clear error", async () => {
    // Enqueue a job whose name has no registered handler.
    const looseClient = createJobClient({ source: "test" })
    const job = await looseClient.enqueue(db, {
      name: "ghost_job",
      workspaceId: "ws_int",
      payload: {},
    })
    const worker = createWorker({ db, registry, instanceId: "w1" })
    await worker.tick()

    const row = await db.query<{ status: string; last_error: string }>(
      "select status, last_error from platform.jobs where id=$1",
      [job.id],
    )
    expect(row.rows[0]?.status).toBe("dead")
    expect(row.rows[0]?.last_error).toMatch(/no handler registered/i)
  })

  it("does not enqueue when the surrounding transaction rolls back", async () => {
    await expect(
      db.transaction(async (tx) => {
        await client.enqueue(tx, {
          name: "ok_job",
          workspaceId: "ws_int",
          payload: { label: "rollback" },
        })
        throw new Error("force rollback")
      }),
    ).rejects.toThrow(/force rollback/)

    const count = await db.query<{ n: string }>(
      "select count(*)::text as n from platform.jobs",
    )
    expect(count.rows[0]?.n).toBe("0")
  })

  it("does not run the same job twice across concurrent workers", async () => {
    for (let i = 0; i < 25; i++) {
      await client.enqueue(db, { name: "counter_job", workspaceId: "ws_int", payload: {} })
    }

    const a = createWorker({ db, registry, instanceId: "wA", batchSize: 50, maxConcurrency: 5 })
    const b = createWorker({ db, registry, instanceId: "wB", batchSize: 50, maxConcurrency: 5 })
    await Promise.all([a.tick(), b.tick()])

    expect(state.counter).toBe(25)
    const succeeded = await db.query<{ n: string }>(
      "select count(*)::text as n from platform.jobs where status='succeeded'",
    )
    expect(succeeded.rows[0]?.n).toBe("25")
    const maxAttempt = await db.query<{ m: number }>(
      "select coalesce(max(attempt_count),0)::int as m from platform.jobs",
    )
    expect(maxAttempt.rows[0]?.m).toBe(1)
  })
})
