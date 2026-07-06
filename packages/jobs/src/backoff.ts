export type BackoffOptions = {
  initialMs: number
  maxMs: number
  factor: number
  jitter: boolean
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  initialMs: 5_000,
  maxMs: 15 * 60_000,
  factor: 2,
  jitter: true,
}

/**
 * Exponential backoff with equal jitter.
 *
 * @param attempt number of attempts already made (>= 1). The delay returned is
 *   how long to wait before the next attempt.
 * @returns milliseconds to wait
 *
 * With jitter, the result lands in [capped/2, capped] to spread retries across
 * multiple workers and avoid thundering herds.
 */
export function computeBackoffMs(
  attempt: number,
  opts: BackoffOptions = DEFAULT_BACKOFF,
): number {
  const n = Math.max(1, Math.floor(attempt))
  const raw = opts.initialMs * Math.pow(opts.factor, n - 1)
  const capped = Math.min(opts.maxMs, raw)
  if (!opts.jitter) return Math.round(capped)
  const half = capped / 2
  return Math.round(half + Math.random() * half)
}
