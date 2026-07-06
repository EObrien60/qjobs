import type { ZodType } from "zod"
import type { JobDb } from "./db"
import type { Logger } from "./logger"

/**
 * queued     -> ready to run once run_after passes
 * processing -> claimed by a worker and running
 * succeeded  -> handler returned without error
 * failed     -> an attempt failed; will retry after run_after (backoff)
 * dead       -> exceeded max attempts (or unrunnable); not retried automatically
 * cancelled  -> cancelled before running
 */
export type JobStatus =
  | "queued"
  | "processing"
  | "succeeded"
  | "failed"
  | "dead"
  | "cancelled"

export type JsonObject = Record<string, unknown>

/** A small JSON blob a handler may return; stored in platform.jobs.result. */
export type JobResult = JsonObject

/**
 * The full shape of a row in platform.jobs, camel-cased. Returned by enqueue()
 * and handed to the worker; product code rarely constructs this directly.
 */
export type JobRecord<TPayload = unknown> = {
  id: string

  name: string
  version: number

  source: string
  workspaceId: string

  payload: TPayload
  metadata?: JsonObject

  status: JobStatus

  priority: number

  runAfter: string
  createdAt: string
  updatedAt: string

  startedAt?: string | null
  finishedAt?: string | null

  attemptCount: number
  maxAttempts: number

  lockedAt?: string | null
  lockedBy?: string | null

  idempotencyKey?: string | null
  correlationId?: string | null
  causationId?: string | null

  progress?: JsonObject
  result?: JobResult | null
  lastError?: string | null
}

/** Input to jobs.enqueue(). The explicit object form is canonical. */
export type EnqueueJobInput<TPayload = unknown> = {
  name: string
  version?: number
  source?: string
  workspaceId: string
  payload: TPayload
  metadata?: JsonObject
  priority?: number
  runAfter?: Date | string
  maxAttempts?: number
  idempotencyKey?: string | null
  correlationId?: string | null
  causationId?: string | null
}

/**
 * Optional bridge to an events system. Kept structural and optional so @obh/jobs
 * never has to depend on @obh/events.
 */
export type EmitEventInput = {
  name: string
  version?: number
  workspaceId: string
  actorId?: string | null
  correlationId?: string | null
  causationId?: string | null
  occurredAt?: Date | string
  payload: unknown
  metadata?: JsonObject
}

/**
 * What a handler receives. `db` is the worker's connection (autocommit, not a
 * transaction). `signal` aborts when the job's timeout elapses. `emitEvent`
 * and `enqueue` are present when the worker was configured with them.
 */
export type JobContext = {
  jobId: string
  workspaceId: string
  source: string

  attemptCount: number
  maxAttempts: number

  correlationId?: string | null
  causationId?: string | null

  signal: AbortSignal

  log: Logger
  db: JobDb

  progress(update: JsonObject): Promise<void>

  emitEvent?(event: EmitEventInput): Promise<void>
  enqueue?<TPayload>(job: EnqueueJobInput<TPayload>): Promise<JobRecord<TPayload>>
}

export type JobHandler<TPayload> = (
  ctx: JobContext,
  payload: TPayload,
) => Promise<JobResult | void> | JobResult | void

/**
 * A job contract: its name, version, payload schema and handler, plus optional
 * per-job retry/timeout defaults. Produced by defineJob().
 */
export type JobDefinition<TPayload = unknown> = {
  name: string
  version: number
  schema: ZodType<TPayload>
  handler: JobHandler<TPayload>
  defaultMaxAttempts?: number
  defaultTimeoutMs?: number
}
