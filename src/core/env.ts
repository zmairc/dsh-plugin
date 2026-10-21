/**
 * Minimal `.env` loader.
 *
 * The MCP server is started by another process — a desktop client, an IDE, the
 * DSH runtime — whose environment the user cannot easily edit. Loading the
 * project's `.env` (which is gitignored) keeps the API key out of both the
 * client's config file and the shell history.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { rootDir } from './archive.ts'

/**
 * Read `KEY=VALUE` pairs from a `.env` file into `process.env`.
 * Existing variables win, so a shell-provided key is never overwritten.
 * The default path is resolved per call, so retargeting the archive root
 * redirects `.env` lookups too.
 * @param path - file to read; defaults to `<root>/.env`.
 */
export function loadDotEnv(path: string = join(rootDir(), '.env')): void {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index <= 0) continue
    const key = trimmed.slice(0, index).trim()
    let value = trimmed.slice(index + 1).trim()
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    if (key.length > 0 && (process.env[key] === undefined || process.env[key] === '')) {
      process.env[key] = value
    }
  }
}
