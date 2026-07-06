#!/usr/bin/env node
import { createJobRegistry, createLogger, createWorker, pgAdapter } from "@obh/jobs"
import { Pool } from "pg"
import { loadConfig } from "./config"
import { startHealthServer } from "./health"
import { allJobs } from "./jobs"

async function main(): Promise<void> {
  const cfg = loadConfig()
  const log = createLogger(cfg.logLevel)
  const pool = new Pool({ connectionString: cfg.databaseUrl })
  const db = pgAdapter(pool)
  const registry = createJobRegistry(allJobs)

  log.info("workerd starting", {
    instance_id: cfg.instanceId,
    source: cfg.source,
    poll_interval_ms: cfg.pollIntervalMs,
    batch_size: cfg.batchSize,
    max_concurrency: cfg.maxConcurrency,
    log_level: cfg.logLevel,
    health_port: cfg.healthPort,
    jobs: registry.list().map((j) => `${j.name}@${j.version}`),
  })

  const worker = createWorker({
    db,
    registry,
    instanceId: cfg.instanceId,
    source: cfg.source,
    batchSize: cfg.batchSize,
    maxConcurrency: cfg.maxConcurrency,
    logger: log,
  })

  const health = cfg.healthPort ? startHealthServer(cfg.healthPort, db) : undefined

  let running = true
  let ticking = false

  const tick = async (): Promise<void> => {
    if (!running || ticking) return
    ticking = true
    try {
      const processed = await worker.tick()
      if (processed) log.debug("tick complete", { processed })
    } catch (err) {
      log.error("tick failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      ticking = false
    }
  }

  const timer = setInterval(() => void tick(), cfg.pollIntervalMs)

  const shutdown = async (signal: string): Promise<void> => {
    if (!running) return
    running = false
    log.info("workerd stopping", { signal })
    clearInterval(timer)

    // Let an in-flight tick (and its jobs) finish, bounded, before closing.
    let waited = 0
    while (ticking && waited < 60_000) {
      await new Promise((r) => setTimeout(r, 100))
      waited += 100
    }

    health?.close()
    await pool.end()
    log.info("workerd stopped")
    process.exit(0)
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"))
  process.on("SIGINT", () => void shutdown("SIGINT"))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
