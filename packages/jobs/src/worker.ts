import { computeBackoffMs, DEFAULT_BACKOFF, type BackoffOptions } from "./backoff"
import { createJobClient } from "./client"
import type { TransactionalJobDb } from "./db"
import { createLogger, type Logger } from "./logger"
import type { JobRegistry } from "./registry"
import { rowToJobRecord, type JobRow } from "./rows"
import type { EmitEventInput, JobContext, JobDefinition, JobResult } from "./types"

export type WorkerOptions = {
  db: TransactionalJobDb
  registry: JobRegistry
  instanceId: string
  /** Source for jobs enqueued from within a handler (default "workerd"). */
  source?: string
  /** Max rows claimed per tick (default 50). */
  batchSize?: number
  /** Max jobs run concurrently within one tick (default 5). */
  maxConcurrency?: number
  backoff?: BackoffOptions
  /** Fallback per-job timeout when a definition sets none (default: none). */
  defaultTimeoutMs?: number
  /** Reclaim jobs stuck in `processing` for longer than this (default 15m). */
  reclaimAfterMs?: number
  logger?: Logger
  /** Optional bridge so handlers can emit events via ctx.emitEvent. */
  emitEvent?: (event: EmitEventInput) => Promise<void>
}

export type Worker = {
  /** Claim and process one batch. Returns the number of jobs processed. */
  tick(): Promise<number>
}

const MAX_ERROR_LEN = 4000
const truncateError = (err: unknown): string => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err)
  return msg.length > MAX_ERROR_LEN ? msg.slice(0, MAX_ERROR_LEN) : msg
}
const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

// Claim ready jobs (queued/failed past run_after) plus any stuck in processing
// past the reclaim window. Increments attempt_count at claim time.
const CLAIM_SQL = `
with picked as (
  select id
  from platform.jobs
  where (
    (status in ('queued', 'failed') and run_after <= now())
    or (
      status = 'processing'
      and locked_at is not null
      and locked_at < now() - ($1::bigint * interval '1 millisecond')
    )
  )
  order by priority desc, created_at asc
  limit $2
  for update skip locked
)
update platform.jobs j
set status = 'processing',
    locked_at = now(),
    locked_by = $3,
    started_at = coalesce(j.started_at, now()),
    attempt_count = j.attempt_count + 1,
    updated_at = now()
from picked
where j.id = picked.id
returning j.*
`

/** Run each item through fn with at most `limit` running at once. */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const size = Math.max(1, Math.min(limit, items.length))
  const runners = Array.from({ length: size }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      await fn(items[index] as T)
    }
  })
  await Promise.all(runners)
}

/**
 * Run a handler with an optional timeout. On timeout the AbortController is
 * aborted (cooperative — a handler that ignores the signal keeps running in the
 * background, but its result is discarded and the attempt is recorded failed).
 */
async function runHandler<TPayload>(
  def: JobDefinition<TPayload>,
  ctx: JobContext,
  payload: TPayload,
  timeoutMs: number | undefined,
  controller: AbortController,
): Promise<JobResult | void> {
  const handlerPromise = Promise.resolve().then(() => def.handler(ctx, payload))
  // Swallow a late rejection if the timeout wins the race below.
  handlerPromise.catch(() => {})

  if (!timeoutMs || timeoutMs <= 0) return handlerPromise

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`job timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })
  try {
    return await Promise.race([handlerPromise, timeoutPromise])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Create a worker over a job registry.
 *
 * Execution is at-least-once: a job may run more than once (crash after handler
 * but before the result write, or a timeout that couldn't truly cancel).
 * Handlers must be idempotent.
 */
export function createWorker(opts: WorkerOptions): Worker {
  const log = opts.logger ?? createLogger("info")
  const batchSize = opts.batchSize ?? 50
  const maxConcurrency = opts.maxConcurrency ?? 5
  const backoff = opts.backoff ?? DEFAULT_BACKOFF
  const reclaimAfterMs = opts.reclaimAfterMs ?? 15 * 60_000
  const source = opts.source ?? "workerd"

  // Client used only for ctx.enqueue (handlers enqueuing follow-up work).
  const jobClient = createJobClient({ source, registry: opts.registry })

  const markSucceeded = (jobId: string, result: JobResult | null) =>
    opts.db.query(
      `update platform.jobs
       set status = 'succeeded', result = $2::jsonb, finished_at = now(),
           locked_at = null, locked_by = null, last_error = null, updated_at = now()
       where id = $1`,
      [jobId, result === null ? null : JSON.stringify(result)],
    )

  const markFailure = async (
    jobId: string,
    attemptCount: number,
    maxAttempts: number,
    err: unknown,
  ): Promise<boolean> => {
    const dead = attemptCount >= maxAttempts
    const errText = truncateError(err)
    if (dead) {
      await opts.db.query(
        `update platform.jobs
         set status = 'dead', finished_at = now(), locked_at = null, locked_by = null,
             last_error = $2, updated_at = now()
         where id = $1`,
        [jobId, errText],
      )
    } else {
      const delayMs = computeBackoffMs(attemptCount, backoff)
      await opts.db.query(
        `update platform.jobs
         set status = 'failed', locked_at = null, locked_by = null, last_error = $2,
             run_after = now() + ($3::bigint * interval '1 millisecond'), updated_at = now()
         where id = $1`,
        [jobId, errText, delayMs],
      )
    }
    return dead
  }

  const markUnrunnable = (jobId: string, reason: string) =>
    opts.db.query(
      `update platform.jobs
       set status = 'dead', finished_at = now(), locked_at = null, locked_by = null,
           last_error = $2, updated_at = now()
       where id = $1`,
      [jobId, reason],
    )

  const processRow = async (row: JobRow): Promise<void> => {
    const record = rowToJobRecord(row)
    const jobLog = log.child({
      job_id: record.id,
      job_name: record.name,
      workspace_id: record.workspaceId,
      attempt_count: record.attemptCount,
      correlation_id: record.correlationId ?? undefined,
    })

    const def = opts.registry.get(record.name, record.version)
    if (!def) {
      const reason = `No handler registered for ${record.name}@${record.version}`
      await markUnrunnable(record.id, reason)
      jobLog.error("job dead-lettered: unknown job", { status: "dead" })
      return
    }

    const parsed = def.schema.safeParse(record.payload)
    if (!parsed.success) {
      await markUnrunnable(record.id, `Invalid payload: ${parsed.error.message}`)
      jobLog.error("job dead-lettered: invalid payload", { status: "dead" })
      return
    }

    const controller = new AbortController()
    const ctx: JobContext = {
      jobId: record.id,
      workspaceId: record.workspaceId,
      source: record.source,
      attemptCount: record.attemptCount,
      maxAttempts: record.maxAttempts,
      correlationId: record.correlationId,
      causationId: record.causationId,
      signal: controller.signal,
      log: jobLog,
      db: opts.db,
      progress: async (update) => {
        await opts.db.query(
          `update platform.jobs
           set progress = progress || $2::jsonb, updated_at = now()
           where id = $1`,
          [record.id, JSON.stringify(update)],
        )
      },
      emitEvent: opts.emitEvent,
      enqueue: (job) => jobClient.enqueue(opts.db, job),
    }

    const timeoutMs = def.defaultTimeoutMs ?? opts.defaultTimeoutMs
    const startedMs = Date.now()
    jobLog.debug("job claimed", { status: "processing" })

    try {
      const result = await runHandler(def, ctx, parsed.data, timeoutMs, controller)
      await markSucceeded(record.id, (result as JobResult | undefined) ?? null)
      jobLog.debug("job succeeded", {
        status: "succeeded",
        duration_ms: Date.now() - startedMs,
      })
    } catch (err) {
      const dead = await markFailure(
        record.id,
        record.attemptCount,
        record.maxAttempts,
        err,
      )
      const fields = {
        status: dead ? "dead" : "failed",
        duration_ms: Date.now() - startedMs,
        error: errMessage(err),
      }
      if (dead) jobLog.error("job dead-lettered", fields)
      else jobLog.warn("job failed, will retry", fields)
    }
  }

  return {
    async tick() {
      const claimed = await opts.db.query<JobRow>(CLAIM_SQL, [
        reclaimAfterMs,
        batchSize,
        opts.instanceId,
      ])
      if (claimed.rows.length === 0) return 0
      await runWithConcurrency(claimed.rows, maxConcurrency, processRow)
      return claimed.rows.length
    },
  }
}
