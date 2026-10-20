/**
 * Command-line argument parsing.
 *
 * The surface is small enough that a dependency would cost more than it saves:
 * flags are `--name value` or a bare `--name` meaning true.
 */

/** Parsed flags keyed by name without the leading dashes. */
export type Flags = Map<string, string | true>

/** Parse `--key value` and `--key` pairs, ignoring positional arguments. */
export function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      flags.set(key, true)
    } else {
      flags.set(key, next)
      index += 1
    }
  }
  return flags
}

/** Read a string flag. */
export function stringFlag(flags: Flags, key: string): string | undefined {
  const value = flags.get(key)
  return typeof value === 'string' ? value : undefined
}

/** Read a boolean flag. */
export function boolFlag(flags: Flags, key: string): boolean {
  return flags.has(key)
}

/** Read a numeric flag with a fallback. */
export function numberFlag(flags: Flags, key: string, fallback: number): number {
  const raw = stringFlag(flags, key)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`--${key} 需要一个数字，收到 ${raw}`)
  return value
}

/** Read a comma-separated list flag. */
export function listFlag(flags: Flags, key: string, fallback: readonly string[] = []): string[] {
  const raw = stringFlag(flags, key)
  if (raw === undefined) return [...fallback]
  return raw.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
}
