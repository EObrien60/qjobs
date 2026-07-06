/**
 * The tiny database contract the core depends on. Anything that can run a
 * parameterised SQL query satisfies JobDb; this keeps the core free of any
 * particular Postgres client or ORM.
 *
 * Enqueuing only needs JobDb (so it can run inside the app's own transaction).
 * The worker needs TransactionalJobDb so it can own short claim transactions.
 */
export type QueryResult<T = unknown> = { rows: T[] }

export type JobDb = {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>>
}

export type TransactionalJobDb = JobDb & {
  transaction<T>(fn: (tx: JobDb) => Promise<T>): Promise<T>
}
