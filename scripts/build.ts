/**
 * Build step: emit plain JavaScript into `dist/`.
 *
 * Node refuses to strip TypeScript types for files under `node_modules`, so a
 * published plugin cannot ship `.ts` sources. This script uses Node's built-in
 * `stripTypeScriptTypes` (no compiler dependency) and rewrites relative `.ts`
 * imports to `.js`, producing a package that any client can load.
 */

import { stripTypeScriptTypes } from 'node:module'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src')
const DIST = join(ROOT, 'dist')

/** List every file under a directory. */
function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name)
    return entry.isDirectory() ? walk(full) : [full]
  })
}

/** Point relative imports at the emitted files. */
function rewriteImports(code: string): string {
  return code
    .replace(/(from\s+['"])([^'"]+)\.ts(['"])/g, '$1$2.js$3')
    .replace(/(import\(\s*['"])([^'"]+)\.ts(['"]\s*\))/g, '$1$2.js$3')
}

rmSync(DIST, { recursive: true, force: true })

let count = 0
for (const file of walk(SRC)) {
  if (!file.endsWith('.ts')) continue
  const source = readFileSync(file, 'utf8')
  const stripped = rewriteImports(stripTypeScriptTypes(source, { mode: 'strip' }))
  const target = join(DIST, relative(SRC, file).replace(/\.ts$/, '.js'))
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, stripped, 'utf8')
  count += 1
}

console.log(`构建完成：${count} 个文件 -> dist/`)
