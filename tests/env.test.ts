import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDotEnv } from '../src/core/env.ts'

test('loadDotEnv fills a missing key from the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'persona-forge-env-'))
  const file = join(dir, '.env')
  writeFileSync(file, 'PERSONAFORGE_TEST_KEY=from-file\n', 'utf8')
  delete process.env.PERSONAFORGE_TEST_KEY

  loadDotEnv(file)
  assert.equal(process.env.PERSONAFORGE_TEST_KEY, 'from-file')

  delete process.env.PERSONAFORGE_TEST_KEY
  rmSync(dir, { recursive: true, force: true })
})

test('loadDotEnv never overwrites a value the shell already set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'persona-forge-env-'))
  const file = join(dir, '.env')
  writeFileSync(file, 'PERSONAFORGE_TEST_KEY=from-file\n', 'utf8')
  process.env.PERSONAFORGE_TEST_KEY = 'from-shell'

  loadDotEnv(file)
  assert.equal(process.env.PERSONAFORGE_TEST_KEY, 'from-shell')

  delete process.env.PERSONAFORGE_TEST_KEY
  rmSync(dir, { recursive: true, force: true })
})

test('loadDotEnv replaces an empty value left by a parent process', () => {
  const dir = mkdtempSync(join(tmpdir(), 'persona-forge-env-'))
  const file = join(dir, '.env')
  writeFileSync(file, 'PERSONAFORGE_TEST_KEY=from-file\n', 'utf8')
  process.env.PERSONAFORGE_TEST_KEY = ''

  loadDotEnv(file)
  assert.equal(process.env.PERSONAFORGE_TEST_KEY, 'from-file')

  delete process.env.PERSONAFORGE_TEST_KEY
  rmSync(dir, { recursive: true, force: true })
})
