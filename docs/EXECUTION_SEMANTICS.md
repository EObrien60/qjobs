# Execution semantics

## At-least-once. Handlers must be idempotent.

qjobs targets **at-least-once** execution. A job may run **more than once**.
Design every handler so that running it twice has the same effect as once.

> At-least-once execution.
> Handlers must tolerate retries.

### Where duplicates come from

1. A worker claims a job (`status = processing`, `attempt_count += 1`), then
   **crashes before writing the result**. The row sits in `processing` until the
   reclaim window (`reclaimAfterMs`, default 15m) passes, then another worker
   claims and runs it **again**.
2. A job **times out**. The timeout aborts the `AbortController`, but a handler
   that ignores `ctx.signal` keeps running in the background — its result is
   discarded and the attempt is recorded failed, so the retry runs the work
   again. (V1 cannot truly kill a runaway handler; it only stops waiting.)

### Making handlers idempotent

- Use the job's `idempotencyKey` / a natural key as the unit of work.
- `insert ... on conflict do nothing` when writing derived rows.
- Make external calls safe to repeat (send an idempotency key downstream, or
  check-before-write).

## Idempotent enqueue vs idempotent execution

Two different things:

- **Enqueue idempotency** (`idempotencyKey`) stops *duplicate jobs* being
  created. If a job with the same `(source, idempotency_key)` already exists,
  `enqueue` returns it instead of inserting a new row. Enforced by the partial
  unique index `jobs_idempotency_idx`.
- **Execution idempotency** is your handler's job. Even a single job row can run
  its handler more than once (see above).

## Retry and dead-letter

`attempt_count` is incremented **at claim time**. On failure:

- if `attempt_count >= max_attempts` → `status = dead`, `finished_at = now()`,
  not retried automatically;
- otherwise → `status = failed`, `run_after = now() + backoff(attempt_count)`
  (exponential + jitter), lock cleared.

`last_error` stores the (truncated) error. Manual re-drive of dead jobs is left
for later.

## Ordering

Claim order is `priority desc, created_at asc`, but there is **no ordering
guarantee** in the face of concurrency, retries, and backoff. Don't rely on jobs
running in enqueue order.

## Concurrency safety

Workers claim with `for update skip locked`, so multiple `obh-workerd` instances
(and multiple concurrent slots within one) never claim the same row. Within a
tick a worker claims up to `batchSize` rows and runs up to `maxConcurrency` at a
time.
