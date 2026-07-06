import type { JobDb } from "./db"

/**
 * Schema for the job queue. Idempotent (safe to run repeatedly). This string is
 * the source of truth; src/migrations/0001_init.sql is a verbatim copy kept for
 * DBAs who prefer to apply SQL by hand.
 */
export const INIT_SQL = `
create schema if not exists platform;

create table if not exists platform.jobs (
  id text primary key,

  name text not null,
  version integer not null default 1,

  source text not null,
  workspace_id text not null,

  payload jsonb not null,
  metadata jsonb not null default '{}'::jsonb,

  status text not null default 'queued',

  priority integer not null default 0,

  run_after timestamptz not null default now(),

  attempt_count integer not null default 0,
  max_attempts integer not null default 10,

  locked_at timestamptz null,
  locked_by text null,

  started_at timestamptz null,
  finished_at timestamptz null,

  idempotency_key text null,
  correlation_id text null,
  causation_id text null,

  progress jsonb not null default '{}'::jsonb,
  result jsonb null,

  last_error text null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists jobs_ready_idx
  on platform.jobs (status, run_after, priority desc, created_at);

create index if not exists jobs_workspace_idx
  on platform.jobs (workspace_id, created_at desc);

create index if not exists jobs_name_idx
  on platform.jobs (name, created_at desc);

create index if not exists jobs_correlation_idx
  on platform.jobs (correlation_id);

create unique index if not exists jobs_idempotency_idx
  on platform.jobs (source, idempotency_key)
  where idempotency_key is not null;
`

export type Migration = { id: string; sql: string }

export const migrations: Migration[] = [{ id: "0001_init", sql: INIT_SQL }]

/**
 * Apply all migrations. Each migration is idempotent DDL, so this is safe to
 * run on every boot if you like.
 */
export async function runMigrations(db: JobDb): Promise<void> {
  for (const migration of migrations) {
    await db.query(migration.sql)
  }
}
