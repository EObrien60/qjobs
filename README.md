# qjobs

A small, boring, reliable **Postgres-backed job queue + worker** for OBH SaaS
products (qHaul, qMechanic, …).

Product request paths should not do slow work. Instead:

```txt
API writes domain state
API enqueues a job
API returns
worker does the slow work
```

The whole system is five verbs:

```txt
put work in a table
claim work safely
run handler
retry failures
record result
```

This is **not** Temporal, a BullMQ clone, a workflow engine, or a distributed
scheduler. It is a Postgres table, a TypeScript contract, and a worker. On
purpose. See [Anti-bloat](#anti-bloat).

---

## Jobs vs Events

- **Events** (see [qevents](https://github.com/EObrien60/qevents)) are **facts**:
  `consignment.delivered`, `inspection.completed`. Past tense, dot notation.
- **Jobs** are **commands / work**: `generate_pod_pdf`, `process_invoice_ocr`.
  Imperative, snake_case.

Events usually *trigger* jobs (an event consumer enqueues a job), but product
code may enqueue jobs directly when it explicitly needs background work. qjobs
has no build-time dependency on qevents.

---

## How it works

Each SaaS owns its own Postgres database. qjobs adds one table under a `platform`
schema and a worker (`obh-workerd`) that runs alongside the app. There is **no**
global OBH job service — same code, separate deployments, separate databases.

The worker loop:

1. Poll for ready jobs (`queued`/`failed` past `run_after`, plus any stuck in
   `processing` past the reclaim window).
2. Claim a batch with `for update skip locked`, mark them `processing`,
   increment `attempt_count`.
3. Run each registered handler, up to `maxConcurrency` at a time.
4. On success → `succeeded` (+ optional small `result`).
5. On failure → retry with exponential backoff, or `dead` after `max_attempts`.

Execution is **at-least-once**: handlers must be idempotent. Read
[docs/EXECUTION_SEMANTICS.md](docs/EXECUTION_SEMANTICS.md).

---

## Repo layout

```txt
packages/jobs/     @obh/jobs     — the SDK (define, enqueue, registry, worker)
apps/workerd/      @obh/workerd  — the worker binary (obh-workerd) + demo
docs/              execution semantics
```

---

## Install

pnpm workspace, Node 20+.

```bash
pnpm install
pnpm -r build
```

SDK consumers also need `zod` (peer dependency) and a Postgres client such as `pg`.

---

## Quickstart (demo)

```bash
cp .env.example .env
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/qjobs_dev

pnpm --filter @obh/workerd migrate   # create platform.jobs
pnpm --filter @obh/workerd demo      # enqueue a qHaul + a qMechanic job
pnpm --filter @obh/workerd start     # worker claims and runs them
```

---

## Using the SDK

### 1. Define a job (schema + handler)

```ts
import { z } from "zod"
import { defineJob } from "@obh/jobs"

export const GeneratePodPdf = defineJob({
  name: "generate_pod_pdf",
  version: 1,
  defaultMaxAttempts: 5,
  defaultTimeoutMs: 60_000,
  schema: z.object({
    consignmentId: z.string(),
    podFileIds: z.array(z.string()).default([]),
  }),
  handler: async (ctx, payload) => {
    await ctx.progress({ stage: "rendering" })
    // ... generate + upload ...
    return { fileId: "file_123", pageCount: 4 } // small JSON result
  },
})
```

### 2. Enqueue — inside your transaction

The job insert commits with your domain write. If the transaction rolls back,
the job never existed.

```ts
import { createJobClient, pgAdapter } from "@obh/jobs"
import { Pool } from "pg"

const db = pgAdapter(new Pool({ connectionString: process.env.DATABASE_URL }))
const jobs = createJobClient({ source: "qhaul", registry })

await db.transaction(async (tx) => {
  await tx.query("update consignments set status='delivered' where id=$1", [consignmentId])

  await jobs.enqueue(tx, {
    name: "generate_pod_pdf",
    workspaceId,
    payload: { consignmentId, podFileIds },
    idempotencyKey: `generate_pod_pdf:${consignmentId}`,
    causationId: event.id,
  })
})
```

Convenience overload (explicit object form is canonical):

```ts
await jobs.enqueue(db, "cleanup_expired_uploads", { workspaceId, payload: {} })
```

Bring your own Postgres pool/ORM by implementing the tiny `JobDb` interface
(`query(sql, params)`); you don't have to use the `pg` adapter.

### 3. Idempotency, scheduling, cancellation

```ts
// Same (source, idempotencyKey) => returns the existing job, no duplicate row.
await jobs.enqueue(db, { name: "generate_pod_pdf", idempotencyKey: `pod:${id}`, ... })

// Schedule for later with runAfter.
await jobs.enqueue(db, { name: "send_delivery_reminder", runAfter: addHours(new Date(), 24), ... })

// Cancel a queued/failed job (processing/succeeded/dead cannot be cancelled).
await jobs.cancel(db, jobId)
```

### 4. Run a worker

```ts
import { createJobRegistry, createWorker, pgAdapter } from "@obh/jobs"

const registry = createJobRegistry([GeneratePodPdf, ProcessInvoiceOcr, ImportVehiclesCsv])
const worker = createWorker({ db, registry, instanceId: "workerd-1" })
// obh-workerd runs worker.tick() on a poll loop for you
```

### Handler context

```ts
type JobContext = {
  jobId; workspaceId; source
  attemptCount; maxAttempts
  correlationId?; causationId?
  signal: AbortSignal          // aborts on timeout
  log: Logger
  db: JobDb                    // worker connection (autocommit)
  progress(update): Promise<void>
  emitEvent?(event): Promise<void>   // present if the worker was given a bridge
  enqueue?(job): Promise<JobRecord>  // enqueue follow-up work
}
```

Return a **small** JSON `result` (ids, counts). Big outputs belong in a Files
service later, not in the row.

---

## The worker: `obh-workerd`

```bash
obh-workerd                          # once @obh/workerd is built and on PATH
pnpm --filter @obh/workerd start     # during development
```

Starts cleanly, logs config, polls, and shuts down gracefully on SIGTERM/SIGINT
(stops claiming, lets in-flight jobs finish, closes the pool).

| Variable                   | Default         | Meaning                                   |
| -------------------------- | --------------- | ----------------------------------------- |
| `DATABASE_URL`             | *(required)*    | Postgres connection string                |
| `WORKERD_INSTANCE_ID`      | `workerd-<pid>` | Worker id, recorded in `locked_by`        |
| `WORKERD_POLL_INTERVAL_MS` | `1000`          | Poll loop interval                        |
| `WORKERD_BATCH_SIZE`       | `50`            | Rows claimed per tick                     |
| `WORKERD_MAX_CONCURRENCY`  | `5`             | Jobs run at once within one worker        |
| `WORKERD_LOG_LEVEL`        | `info`          | `debug` \| `info` \| `warn` \| `error`    |
| `WORKERD_SOURCE`           | `workerd`       | Source for jobs enqueued from handlers    |
| `WORKERD_HEALTH_PORT`      | *(off)*         | If set, serves `/healthz` and `/readyz`   |

Retry defaults: exponential backoff + jitter, 5s initial, 15m max, dead-letter
after 10 attempts (override per-job with `defaultMaxAttempts`).

---

## Database schema

One table, `platform.jobs` — full SQL in
[`packages/jobs/src/migrations/0001_init.sql`](packages/jobs/src/migrations/0001_init.sql),
also exported as `INIT_SQL` / `runMigrations(db)` (idempotent DDL).

Statuses:

```txt
queued      ready to run once run_after passes
processing  claimed and running
succeeded   handler returned
failed      an attempt failed; will retry after backoff
dead        exceeded max attempts (or unrunnable); no auto-retry
cancelled   cancelled before running
```

Duplicate jobs are prevented by the partial unique index
`jobs_idempotency_idx (source, idempotency_key) where idempotency_key is not null`.

---

## Testing

```bash
pnpm -r test
```

Unit tests (definitions, registry, backoff, enqueue/cancel with a fake db) need
no database. The worker **integration tests** run against real Postgres and
self-skip unless `DATABASE_URL` is set:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/qjobs_test pnpm --filter @obh/jobs test
```

They cover success + result + progress, retry → dead, idempotency, scheduling,
cancellation, unknown-job dead-lettering, transaction rollback, and a
concurrency test proving two workers never run the same job twice. CI
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the lot against
Postgres 16.

---

## Exports

```ts
import {
  defineJob,
  createJobRegistry,
  createJobClient,
  createWorker,
  pgAdapter,
  runMigrations,
} from "@obh/jobs"

import type { JobRecord, JobDefinition, JobContext, JobDb } from "@obh/jobs"
```

---

## Anti-bloat

qjobs must **not**: know product domain models, import qHaul/qMechanic code,
become a workflow engine, require Redis/RabbitMQ/Kafka, require a central server,
block request paths, or own scheduling/reporting UIs.

It only: stores work, claims work, runs a registered handler, retries failure,
records result.

Not in v1 (add later, only once this is boring and used): DAGs, child jobs,
recurring cron, human approval steps, visual editor, per-customer rate limiting,
queue dashboards.

## License

MIT
