import type { JobDb } from "./db"
import { newId } from "./ids"
import type { JobRegistry } from "./registry"
import { rowToJobRecord, type JobRow } from "./rows"
import type { EnqueueJobInput, JobRecord } from "./types"

export type JobClientOptions = {
  /** Default `source` recorded on jobs and used as the idempotency scope. */
  source: string
  /** Optional registry. When present, payloads of KNOWN jobs are validated. */
  registry?: JobRegistry
  /** Id prefix for generated job ids (default "job"). */
  idPrefix?: string
  /** Fallback maxAttempts when neither the input nor the definition sets one. */
  defaultMaxAttempts?: number
  /** Injectable clock, mainly for tests. */
  now?: () => Date
}

export type JobClient = {
  enqueue<TPayload>(
    db: JobDb,
    input: EnqueueJobInput<TPayload>,
  ): Promise<JobRecord<TPayload>>
  enqueue<TPayload>(
    db: JobDb,
    name: string,
    input: Omit<EnqueueJobInput<TPayload>, "name">,
  ): Promise<JobRecord<TPayload>>
  /** Cancel a queued/failed job. Returns the job if cancelled, else null. */
  cancel(db: JobDb, jobId: string): Promise<JobRecord | null>
}

const toIso = (value: Date | string | undefined, fallback: Date): string => {
  if (value == null) return fallback.toISOString()
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

// The ON CONFLICT clause matches the partial unique index
// jobs_idempotency_idx (source, idempotency_key) where idempotency_key is not null.
// When idempotency_key is null the index doesn't apply, so the insert proceeds
// normally and no conflict is possible.
const INSERT_SQL = `
insert into platform.jobs
  (id, name, version, source, workspace_id, payload, metadata,
   priority, run_after, max_attempts, idempotency_key, correlation_id, causation_id)
values
  ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb,
   $8, $9, $10, $11, $12, $13)
on conflict (source, idempotency_key) where idempotency_key is not null
  do nothing
returning *
`

const SELECT_BY_IDEMPOTENCY_SQL = `
select * from platform.jobs where source = $1 and idempotency_key = $2 limit 1
`

const CANCEL_SQL = `
update platform.jobs
set status = 'cancelled', finished_at = now(), locked_at = null, locked_by = null, updated_at = now()
where id = $1 and status in ('queued', 'failed')
returning *
`

/**
 * Create a job client bound to a source. enqueue() runs a single INSERT using
 * the caller-supplied db/transaction handle, so the domain write and the job
 * commit atomically together. If the surrounding transaction rolls back, the
 * job never existed.
 *
 * Idempotency: if a job with the same (source, idempotencyKey) already exists,
 * enqueue returns the existing job instead of inserting a duplicate.
 */
export function createJobClient(opts: JobClientOptions): JobClient {
  const now = opts.now ?? (() => new Date())
  const idPrefix = opts.idPrefix ?? "job"

  const enqueue = async (
    db: JobDb,
    inputOrName: EnqueueJobInput | string,
    maybeInput?: Omit<EnqueueJobInput, "name">,
  ): Promise<JobRecord> => {
    const input: EnqueueJobInput =
      typeof inputOrName === "string"
        ? { ...(maybeInput as Omit<EnqueueJobInput, "name">), name: inputOrName }
        : inputOrName

    if (!input.workspaceId) {
      throw new Error(`jobs.enqueue: workspaceId is required (job "${input.name}")`)
    }

    const source = input.source ?? opts.source
    const version = input.version ?? opts.registry?.latestVersion(input.name) ?? 1

    // Validate known jobs up front. Unknown jobs are allowed through here (the
    // enqueuing app may not carry handlers); the worker dead-letters them.
    const def = opts.registry?.get(input.name, version)
    if (def) {
      const result = opts.registry?.validate(input.name, version, input.payload)
      if (result && !result.ok) {
        throw new Error(
          `jobs.enqueue: invalid payload for ${input.name}@${version}: ${result.error}`,
        )
      }
    }

    const nowDate = now()
    const id = newId(idPrefix)
    const maxAttempts =
      input.maxAttempts ?? def?.defaultMaxAttempts ?? opts.defaultMaxAttempts ?? 10

    const params = [
      id,
      input.name,
      version,
      source,
      input.workspaceId,
      JSON.stringify(input.payload ?? {}),
      JSON.stringify(input.metadata ?? {}),
      input.priority ?? 0,
      toIso(input.runAfter, nowDate),
      maxAttempts,
      input.idempotencyKey ?? null,
      input.correlationId ?? null,
      input.causationId ?? null,
    ]

    const inserted = await db.query<JobRow>(INSERT_SQL, params)
    if (inserted.rows[0]) {
      return rowToJobRecord(inserted.rows[0])
    }

    // do nothing fired: a job with this (source, idempotencyKey) already exists.
    if (input.idempotencyKey) {
      const existing = await db.query<JobRow>(SELECT_BY_IDEMPOTENCY_SQL, [
        source,
        input.idempotencyKey,
      ])
      if (existing.rows[0]) return rowToJobRecord(existing.rows[0])
    }

    throw new Error(`jobs.enqueue: insert returned no row for job "${input.name}"`)
  }

  return {
    enqueue: enqueue as JobClient["enqueue"],
    async cancel(db, jobId) {
      const res = await db.query<JobRow>(CANCEL_SQL, [jobId])
      return res.rows[0] ? rowToJobRecord(res.rows[0]) : null
    },
  }
}
