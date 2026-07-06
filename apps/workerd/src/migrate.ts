import { createLogger, pgAdapter, runMigrations } from "@obh/jobs"
import { Pool } from "pg"
import { loadConfig } from "./config"

async function main(): Promise<void> {
  const cfg = loadConfig()
  const log = createLogger(cfg.logLevel)
  const pool = new Pool({ connectionString: cfg.databaseUrl })
  const db = pgAdapter(pool)

  log.info("running migrations")
  await runMigrations(db)
  log.info("migrations complete")

  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
