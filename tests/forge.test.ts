import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertSafePersonaName, sampleEvenly } from '../src/core/forge.ts'

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
