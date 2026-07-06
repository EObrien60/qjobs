import type { JobRecord, JobStatus, JsonObject } from "./types"

/** Raw column shape of a platform.jobs row as returned by node-postgres. */
export type JobRow = {
  id: string
  name: string
  version: number
  source: string
  workspace_id: string
  payload: unknown
  metadata: unknown
  status: string
  priority: number
  run_after: string | Date
  created_at: string | Date
  updated_at: string | Date
  started_at: string | Date | null
  finished_at: string | Date | null
  attempt_count: number
  max_attempts: number
  locked_at: string | Date | null
  locked_by: string | null
  idempotency_key: string | null
  correlation_id: string | null
  causation_id: string | null
  progress: unknown
  result: unknown
  last_error: string | null
}

const iso = (v: string | Date | null): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString()

/** Map a raw jobs row to the camel-cased JobRecord returned by the SDK. */
export function rowToJobRecord<TPayload = unknown>(row: JobRow): JobRecord<TPayload> {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    source: row.source,
    workspaceId: row.workspace_id,
    payload: row.payload as TPayload,
    metadata: (row.metadata as JsonObject) ?? {},
    status: row.status as JobStatus,
    priority: row.priority,
    runAfter: iso(row.run_after) as string,
    createdAt: iso(row.created_at) as string,
    updatedAt: iso(row.updated_at) as string,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    lockedAt: iso(row.locked_at),
    lockedBy: row.locked_by,
    idempotencyKey: row.idempotency_key,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    progress: (row.progress as JsonObject) ?? {},
    result: (row.result as JsonObject | null) ?? null,
    lastError: row.last_error,
  }
}
