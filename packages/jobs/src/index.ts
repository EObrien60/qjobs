// Public surface of @obh/jobs. Keep this small and boring.

export type {
  JobRecord,
  JobStatus,
  JobDefinition,
  JobHandler,
  JobContext,
  JobResult,
  EnqueueJobInput,
  EmitEventInput,
  JsonObject,
} from "./types"

export type { JobDb, TransactionalJobDb, QueryResult } from "./db"

export { defineJob } from "./defineJob"

export { createJobRegistry } from "./registry"
export type { JobRegistry, ValidationResult } from "./registry"

export { createJobClient } from "./client"
export type { JobClient, JobClientOptions } from "./client"

export { createWorker } from "./worker"
export type { Worker, WorkerOptions } from "./worker"

export { computeBackoffMs, DEFAULT_BACKOFF } from "./backoff"
export type { BackoffOptions } from "./backoff"

export { createLogger } from "./logger"
export type { Logger, LogLevel, LogFields } from "./logger"

export { newId } from "./ids"

export { pgAdapter } from "./adapters/pg"

export { rowToJobRecord } from "./rows"
export type { JobRow } from "./rows"

export { runMigrations, migrations, INIT_SQL } from "./migrations"
export type { Migration } from "./migrations"
