import type { ZodType } from "zod"
import type { JobDefinition, JobHandler } from "./types"

// snake_case: lowercase letters/digits, underscores between segments.
// Good: generate_pod_pdf, process_invoice_ocr, import_vehicles_csv
// Bad:  consignment.delivered (that's an event), GeneratePdf, send email
const NAME_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/

/**
 * Declare a job contract. Jobs are commands (work to do), not facts. Name them
 * as snake_case imperatives (generate_pod_pdf), never in event dot-notation.
 *
 *   export const GeneratePodPdf = defineJob({
 *     name: "generate_pod_pdf",
 *     version: 1,
 *     schema: z.object({ consignmentId: z.string() }),
 *     handler: async (ctx, payload) => { ... },
 *   })
 */
export function defineJob<TPayload>(def: {
  name: string
  version: number
  schema: ZodType<TPayload>
  handler: JobHandler<TPayload>
  defaultMaxAttempts?: number
  defaultTimeoutMs?: number
}): JobDefinition<TPayload> {
  if (def.name.includes(".")) {
    throw new Error(
      `Invalid job name "${def.name}": that looks like an event name. Jobs are commands — use snake_case, e.g. "generate_pod_pdf".`,
    )
  }
  if (!NAME_RE.test(def.name)) {
    throw new Error(
      `Invalid job name "${def.name}". Use lowercase snake_case, e.g. "generate_pod_pdf".`,
    )
  }
  if (!Number.isInteger(def.version) || def.version < 1) {
    throw new Error(
      `Invalid version for job "${def.name}": version must be an integer >= 1.`,
    )
  }
  if (
    def.defaultMaxAttempts !== undefined &&
    (!Number.isInteger(def.defaultMaxAttempts) || def.defaultMaxAttempts < 1)
  ) {
    throw new Error(
      `Invalid defaultMaxAttempts for job "${def.name}": must be an integer >= 1.`,
    )
  }

  return {
    name: def.name,
    version: def.version,
    schema: def.schema,
    handler: def.handler,
    defaultMaxAttempts: def.defaultMaxAttempts,
    defaultTimeoutMs: def.defaultTimeoutMs,
  }
}
