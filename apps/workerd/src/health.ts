import { createServer, type Server } from "node:http"
import type { TransactionalJobDb } from "@obh/jobs"

/**
 * Optional health server.
 *   GET /healthz -> 200 while the process is alive
 *   GET /readyz  -> 200 when the DB answers `select 1`, else 503
 */
export function startHealthServer(port: number, db: TransactionalJobDb): Server {
  const server = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ status: "ok" }))
      return
    }
    if (req.url === "/readyz") {
      db.query("select 1")
        .then(() => {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ status: "ready" }))
        })
        .catch(() => {
          res.writeHead(503, { "content-type": "application/json" })
          res.end(JSON.stringify({ status: "unready" }))
        })
      return
    }
    res.writeHead(404)
    res.end()
  })
  server.listen(port)
  return server
}
