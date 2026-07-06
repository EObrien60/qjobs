import { randomUUID } from "node:crypto"

/**
 * Generate a prefixed, url-safe id, e.g. newId("job") -> "job_9f2c...".
 * Prefixes make ids self-describing in logs and error messages.
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`
}
