import type { LogLevel } from "@obh/jobs"

export type WorkerdConfig = {
  databaseUrl: string
  instanceId: string
  pollIntervalMs: number
  batchSize: number
  maxConcurrency: number
  logLevel: LogLevel
  source: string
  healthPort?: number
}

const int = (value: string | undefined, fallback: number): number => {
  const n = value ? Number.parseInt(value, 10) : Number.NaN
  return Number.isFinite(n) ? n : fallback
}

const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"]

const logLevel = (value: string | undefined): LogLevel =>
  LOG_LEVELS.includes(value as LogLevel) ? (value as LogLevel) : "info"

/**
 * Read worker configuration from the environment. Throws if DATABASE_URL is
 * missing; everything else has a sensible default.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerdConfig {
  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required")
  }
  return {
    databaseUrl,
    instanceId: env.WORKERD_INSTANCE_ID || `workerd-${process.pid}`,
    pollIntervalMs: int(env.WORKERD_POLL_INTERVAL_MS, 1000),
    batchSize: int(env.WORKERD_BATCH_SIZE, 50),
    maxConcurrency: int(env.WORKERD_MAX_CONCURRENCY, 5),
    logLevel: logLevel(env.WORKERD_LOG_LEVEL),
    source: env.WORKERD_SOURCE || "workerd",
    healthPort: env.WORKERD_HEALTH_PORT ? int(env.WORKERD_HEALTH_PORT, 0) : undefined,
  }
}
