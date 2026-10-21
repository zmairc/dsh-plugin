/**
 * Archive storage: paths, JSONL read/write, and text files.
 *
 * Everything resolves from one root directory rather than the process working
 * directory, so the CLI behaves the same however it is invoked.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Pick the directory that holds `data/` and `personas/`.
 *
 * In a checkout the module's own two-level walk lands on the repository root,
 * which is what the CLI and the tests expect. Installed from npm that same walk
 * lands on the package inside `node_modules` — personas written there would be
 * deleted by the next install, so a packaged plugin falls back to the caller's
 * working directory instead. `PERSONAFORGE_ROOT` overrides both.
 * @param env - process environment, for the override.
 * @param moduleDir - the directory two levels above this module.
 * @param cwd - the process working directory.
 * @returns an absolute directory path.
 */
export function resolveRoot(env: Record<string, string | undefined>, moduleDir: string, cwd: string): string {
  const override = env.PERSONAFORGE_ROOT
  if (override !== undefined && override.trim().length > 0) return resolve(override)
  if (moduleDir.includes(`${sep}node_modules${sep}`)) return resolve(cwd)
  return resolve(moduleDir)
}

/** Directory that `data/` and `personas/` live under. */
let currentRoot = resolveRoot(process.env, fileURLToPath(new URL('../../', import.meta.url)), process.cwd())

/**
 * The directory `data/` and `personas/` currently resolve under.
 * @returns an absolute directory path.
 */
export function rootDir(): string {
  return currentRoot
}

/**
 * Point the archive at another root.
 *
 * A harness is not started from the user's project: the DSH session carries its
 * own working directory, which may differ from `process.cwd()`. The plugin
 * retargets per call; the CLI and the MCP server keep the module default.
 * @param dir - the new root.
 */
export function setRoot(dir: string): void {
  currentRoot = resolve(dir)
}

/** Absolute path under `data/`, creating no directory. */
export function dataPath(...parts: string[]): string {
  return join(currentRoot, 'data', ...parts)
}

/** Absolute path under `personas/<name>/`. */
export function personaPath(name: string, ...parts: string[]): string {
  return join(currentRoot, 'personas', name, ...parts)
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
