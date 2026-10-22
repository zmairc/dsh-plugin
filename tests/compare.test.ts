import { test } from 'node:test'
import assert from 'node:assert/strict'
import { binomialP, distance, profileMorphology } from '../src/core/compare.ts'

/**
 * These numbers decide "which persona is shaped more like the real messages",
 * so the measures have to mean what the table claims: rates are shares of
 * messages, lengths are lengths, and a distance of 0 means identical.
 */

test('profileMorphology measures message shares, not character counts', () => {
  const profile = profileMorphology(['嗯', '好的', '这是一条比较长的消息'])
  assert.equal(profile.count, 3)
  assert.equal(profile.meanLength, (1 + 2 + 10) / 3)
  assert.equal(profile.medianLength, 2)
  // Two of three messages are 1–2 characters long (`嗯`, `好的`).
  assert.equal(profile.shortRate, 2 / 3)
  // The same two are also within 8 characters.
  assert.equal(profile.briefRate, 2 / 3)
})

test('profileMorphology counts punctuation and emoji by message', () => {
  const profile = profileMorphology(['真的吗？', '好的，走吧', '🤔', '嗯'])
  assert.equal(profile.questionRate, 1 / 4)
  assert.equal(profile.commaRate, 1 / 4)
  assert.equal(profile.emojiRate, 1 / 4)
  assert.equal(profile.exclamationRate, 0)
})

test('an empty sample yields zeros instead of NaN', () => {
  const profile = profileMorphology([])
  assert.equal(profile.count, 0)
  assert.equal(profile.meanLength, 0)
  assert.equal(profile.medianLength, 0)
  assert.equal(profile.exclamationRate, 0)
})

test('distance is zero for identical profiles and grows with the gap', () => {
  const real = profileMorphology(['嗯', '行', '这是一条比较长的消息，带逗号'])
  const same = profileMorphology(['嗯', '行', '这是一条比较长的消息，带逗号'])
  const close = profileMorphology(['嗯', '行', '这又是一条比较长的消息，带逗号'])
  const far = profileMorphology(['很久以前我们聊过这个问题，我觉得应该先看完材料再说，不过也说不准'])

  assert.equal(distance(same, real), 0)
  assert.ok(distance(close, real) < distance(far, real), '越不像的候选距离应该越大')
})

test('a 3-character median gap counts for more at a short median than a long one', () => {
  const shortReal = profileMorphology(['嗯', '行', '好', '走吧'])
  const shortBad = profileMorphology(['一二三四五六七八', '一二三四五六七八', '一二三四五六七八', '一二三四五六七八'])
  const longReal = profileMorphology(Array.from({ length: 4 }, () => '一二三四五六七八九十'))
  const longBad = profileMorphology(Array.from({ length: 4 }, () => '一二三四五六七八九十，再补一句'))

  // Relative length error keeps a long, chatty persona from looking worse than it is.
  assert.ok(distance(shortBad, shortReal) > distance(longBad, longReal))
})

test('binomialP calls a lopsided duel significant and a near-even one not', () => {
  assert.ok(binomialP(15, 20) < 0.05, '15/20 应该显著')
  assert.ok(binomialP(12, 20) > 0.05, '12/20 不应该显著')
  assert.ok(binomialP(10, 10) < 0.01)
  assert.equal(binomialP(10, 0), 1)
})

test('binomialP is symmetric around the middle', () => {
  assert.equal(binomialP(4, 20), binomialP(16, 20))
})
