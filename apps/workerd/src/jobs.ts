import { defineJob, type JobDefinition } from "@obh/jobs"
import { z } from "zod"

/**
 * Example job contracts + handlers. In a real deployment each product owns its
 * own definitions; these live here so the worker and demo have something to run.
 * Handlers are placeholders: they log, maybe report progress, and return a small
 * result. No real PDF/OCR/CSV work — and no product-domain imports.
 *
 * Every handler is trivially idempotent, as all handlers must be: execution is
 * at-least-once.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// qHaul (logistics / TMS)
// ---------------------------------------------------------------------------

export const GeneratePodPdf = defineJob({
  name: "generate_pod_pdf",
  version: 1,
  defaultMaxAttempts: 5,
  defaultTimeoutMs: 60_000,
  schema: z.object({
    consignmentId: z.string(),
    podFileIds: z.array(z.string()).default([]),
  }),
  handler: async (ctx, payload) => {
    ctx.log.debug("generating POD pdf", { consignment_id: payload.consignmentId })
    await ctx.progress({ stage: "rendering" })
    // placeholder: a real handler would render + upload to the Files service
    return { fileId: `file_pod_${payload.consignmentId}`, pageCount: 1 }
  },
})

export const SendDeliverySummary = defineJob({
  name: "send_delivery_summary",
  version: 1,
  schema: z.object({
    consignmentId: z.string(),
    to: z.string().email().optional(),
  }),
  handler: async (ctx, payload) => {
    ctx.log.debug("sending delivery summary", { consignment_id: payload.consignmentId })
    return { sent: true }
  },
})

export const ImportConsignmentsCsv = defineJob({
  name: "import_consignments_csv",
  version: 1,
  defaultTimeoutMs: 10 * 60_000,
  schema: z.object({
    fileId: z.string(),
    rowCount: z.number().int().nonnegative().default(0),
  }),
  handler: async (ctx, payload) => {
    const total = payload.rowCount || 0
    for (let done = 0; done < total; done += Math.max(1, Math.ceil(total / 4))) {
      await ctx.progress({ processedRows: Math.min(done, total), totalRows: total })
      await sleep(1)
    }
    await ctx.progress({ processedRows: total, totalRows: total })
    return { imported: total }
  },
})

export const CleanupExpiredUploads = defineJob({
  name: "cleanup_expired_uploads",
  version: 1,
  schema: z.object({
    olderThanDays: z.number().int().positive().default(7),
  }),
  handler: async (ctx, payload) => {
    ctx.log.debug("cleaning expired uploads", { older_than_days: payload.olderThanDays })
    return { removed: 0 }
  },
})

export const qhaulJobs: JobDefinition[] = [
  GeneratePodPdf,
  SendDeliverySummary,
  ImportConsignmentsCsv,
  CleanupExpiredUploads,
]

// ---------------------------------------------------------------------------
// qMechanic (fleet / workshop)
// ---------------------------------------------------------------------------

export const GenerateInspectionPdf = defineJob({
  name: "generate_inspection_pdf",
  version: 1,
  defaultMaxAttempts: 5,
  defaultTimeoutMs: 60_000,
  schema: z.object({
    inspectionId: z.string(),
  }),
  handler: async (ctx, payload) => {
    ctx.log.debug("generating inspection pdf", { inspection_id: payload.inspectionId })
    await ctx.progress({ stage: "rendering" })
    return { fileId: `file_insp_${payload.inspectionId}`, pageCount: 1 }
  },
})

export const ProcessInvoiceOcr = defineJob({
  name: "process_invoice_ocr",
  version: 1,
  defaultMaxAttempts: 5,
  defaultTimeoutMs: 2 * 60_000,
  schema: z.object({
    invoiceId: z.string(),
  }),
  handler: async (ctx, payload) => {
    ctx.log.debug("running invoice OCR", { invoice_id: payload.invoiceId })
    await ctx.progress({ stage: "ocr" })
    return { fields: { total: null, currency: null } }
  },
})

export const ImportVehiclesCsv = defineJob({
  name: "import_vehicles_csv",
  version: 1,
  defaultTimeoutMs: 10 * 60_000,
  schema: z.object({
    fileId: z.string(),
    rowCount: z.number().int().nonnegative().default(0),
  }),
  handler: async (ctx, payload) => {
    const total = payload.rowCount || 0
    await ctx.progress({ processedRows: total, totalRows: total })
    return { imported: total }
  },
})

export const SendDailyWorkshopSummary = defineJob({
  name: "send_daily_workshop_summary",
  version: 1,
  schema: z.object({
    date: z.string().optional(),
  }),
  handler: async (ctx) => {
    ctx.log.debug("sending daily workshop summary")
    return { sent: true }
  },
})

export const qmechanicJobs: JobDefinition[] = [
  GenerateInspectionPdf,
  ProcessInvoiceOcr,
  ImportVehiclesCsv,
  SendDailyWorkshopSummary,
]

export const allJobs: JobDefinition[] = [...qhaulJobs, ...qmechanicJobs]
