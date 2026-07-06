import type { JobDefinition } from "./types"

export type ValidationResult<T = unknown> =
  | { ok: true; payload: T }
  | { ok: false; error: string }

export type JobRegistry = {
  get(name: string, version: number): JobDefinition | undefined
  has(name: string, version: number): boolean
  latestVersion(name: string): number | undefined
  validate(name: string, version: number, payload: unknown): ValidationResult
  list(): JobDefinition[]
}

const key = (name: string, version: number) => `${name}@${version}`

/**
 * Holds the known job definitions a worker can run. Unknown jobs never validate
 * (the worker dead-letters them with a clear error rather than silently
 * ignoring them).
 */
export function createJobRegistry(defs: JobDefinition[]): JobRegistry {
  const map = new Map<string, JobDefinition>()
  const versionsByName = new Map<string, number[]>()

  for (const d of defs) {
    const k = key(d.name, d.version)
    if (map.has(k)) throw new Error(`Duplicate job definition: ${k}`)
    map.set(k, d)
    const versions = versionsByName.get(d.name) ?? []
    versions.push(d.version)
    versionsByName.set(d.name, versions)
  }

  return {
    get: (name, version) => map.get(key(name, version)),
    has: (name, version) => map.has(key(name, version)),
    latestVersion(name) {
      const versions = versionsByName.get(name)
      return versions && versions.length > 0 ? Math.max(...versions) : undefined
    },
    validate(name, version, payload): ValidationResult {
      const def = map.get(key(name, version))
      if (!def) {
        return { ok: false, error: `Unknown job ${key(name, version)} (no definition registered)` }
      }
      const parsed = def.schema.safeParse(payload)
      if (!parsed.success) {
        return { ok: false, error: parsed.error.message }
      }
      return { ok: true, payload: parsed.data }
    },
    list: () => [...map.values()],
  }
}
