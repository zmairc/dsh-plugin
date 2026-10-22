import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assertSafePersonaName, backupFile, sampleEvenly } from '../src/core/forge.ts'

test('sampleEvenly spreads picks across the whole archive', () => {
  const items = Array.from({ length: 100 }, (_, index) => index)
  assert.deepEqual(sampleEvenly(items, 5), [0, 20, 40, 60, 80])
})

test('sampleEvenly keeps everything when the count is not smaller', () => {
  assert.deepEqual(sampleEvenly([1, 2, 3], 10), [1, 2, 3])
  assert.deepEqual(sampleEvenly([1, 2, 3], 0), [1, 2, 3])
})

test('sampleEvenly keeps the last item reachable', () => {
  const items = Array.from({ length: 7 }, (_, index) => index)
  const picked = sampleEvenly(items, 3)
  assert.equal(picked.length, 3)
  assert.ok(picked.every((value) => value >= 0 && value <= 6))
})

test('assertSafePersonaName rejects paths that would escape personas/', () => {
  assert.throws(() => assertSafePersonaName('../evil'), /人设名/)
  assert.throws(() => assertSafePersonaName('a/b'), /人设名/)
  assert.throws(() => assertSafePersonaName(''), /人设名/)
  assertSafePersonaName('dennis')
  assertSafePersonaName('wang_lao-2')
})

test('backupFile keeps the previous contents and reports the backup path', () => {
  // Only persona.md used to be backed up, so a rerun destroyed a hand-written
  // style.md and the cleaned transcript with no trace.
  const dir = mkdtempSync(join(tmpdir(), 'persona-forge-backup-'))
  try {
    const style = join(dir, 'style.md')
    writeFileSync(style, '手写版内容', 'utf8')

    assert.equal(backupFile(style), join(dir, 'style.prev.md'))
    assert.equal(readFileSync(join(dir, 'style.prev.md'), 'utf8'), '手写版内容')

    // Nothing to copy on a second run over a fresh file.
    assert.equal(backupFile(join(dir, 'missing.md')), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('backupFile keeps a .txt extension readable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'persona-forge-backup-'))
  try {
    const transcript = join(dir, 'transcript.txt')
    writeFileSync(transcript, '原始对话', 'utf8')
    assert.equal(backupFile(transcript), join(dir, 'transcript.prev.txt'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
