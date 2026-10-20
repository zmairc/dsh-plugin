/**
 * Archive storage: paths, JSONL read/write, and text files.
 *
 * Everything resolves from the repository root rather than the process working
 * directory, so the CLI behaves the same however it is invoked.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root, resolved from this module. */
export const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** Absolute path under `data/`, creating no directory. */
export function dataPath(...parts: string[]): string {
  return join(ROOT, 'data', ...parts)
}

/** Absolute path under `personas/<name>/`. */
export function personaPath(name: string, ...parts: string[]): string {
  return join(ROOT, 'personas', name, ...parts)
}

/** Read a JSONL file, returning an empty array when it does not exist. */
export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T)
}

/** Write one JSON value per line. */
export function writeJsonl(path: string, rows: readonly unknown[]): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
}

/** Write a text file, creating parent directories. */
export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
}

/** Read a text file, or null when it does not exist. */
export function readText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

/** Whether a path exists. */
export function exists(path: string): boolean {
  return existsSync(path)
}
