-- qjobs queue schema.
-- This file is a verbatim copy of INIT_SQL in ../migrations.ts, provided for
-- DBAs who apply SQL by hand. Idempotent: safe to run repeatedly.

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
