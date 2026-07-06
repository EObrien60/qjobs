import {
  createJobClient,
  createJobRegistry,
  createLogger,
  pgAdapter,
  runMigrations,
} from "@obh/jobs"
import { Pool } from "pg"
import { loadConfig } from "./config"
import { allJobs } from "./jobs"

/**
 * Enqueue one qHaul job (generate_pod_pdf) and one qMechanic job
 * (generate_inspection_pdf), each with an idempotency key. Run this, then run
 * `obh-workerd` (or `pnpm --filter @obh/workerd start`) to see them claimed and
 * run. Re-running the demo is a no-op thanks to the idempotency keys.
 */
async function main(): Promise<void> {
  const cfg = loadConfig()
  const log = createLogger(cfg.logLevel)
  const pool = new Pool({ connectionString: cfg.databaseUrl })
  const db = pgAdapter(pool)

  await runMigrations(db)

  const registry = createJobRegistry(allJobs)
  const jobs = createJobClient({ source: "demo", registry })

  const pod = await jobs.enqueue(db, {
    name: "generate_pod_pdf",
    source: "qhaul",
    workspaceId: "ws_demo",
    payload: { consignmentId: "con_demo", podFileIds: [] },
    idempotencyKey: "generate_pod_pdf:con_demo",
  })
  log.info("enqueued qHaul job", { job_id: pod.id, job_name: pod.name })

  const inspection = await jobs.enqueue(db, {
    name: "generate_inspection_pdf",
    source: "qmechanic",
    workspaceId: "ws_demo",
    payload: { inspectionId: "insp_demo" },
    idempotencyKey: "generate_inspection_pdf:insp_demo",
  })
  log.info("enqueued qMechanic job", { job_id: inspection.id, job_name: inspection.name })

  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
