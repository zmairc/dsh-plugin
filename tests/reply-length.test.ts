import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lengthPlanFromStats, longHint, shouldAskForLong, type LengthPlan } from '../src/core/reply-length.ts'
import { computeStats } from '../src/core/stats.ts'
import type { ChatMessage } from '../src/core/types.ts'

/**
 * Generated replies flatten to one length: 1–11 characters against a real
 * 1–18, even with explicit rules in the prompt. Length is therefore balanced
 * across the conversation — and the balance must never turn a fragmentary
 * speaker into a lecturer.
 */

let counter = 0

/** Build a friend message. */
function message(text: string): ChatMessage {
  counter += 1
  return {
    v: 1,
    id: `rl:${counter}`,
    convId: 'c',
    source: 'manual',
    role: 'friend',
    senderName: '他',
    ts: Date.UTC(2024, 0, 1) + counter * 1000,
    kind: 'text',
    text,
  }
}

/** A two-peak speaker: half fragments, half full sentences. */
const plan: LengthPlan = { longShare: 0.44, threshold: 14 }

test('a plan comes from measured length, not from a constant', () => {
  const messages = [
    message('嗯'),
    message('行'),
    message('我估计一会忘了，我直接给你点了，回来吃凉的算了。'),
    message('不过楼下有别人点的鸡腿，你要是想要，我帮你拿上来。'),
  ]
  const derived = lengthPlanFromStats(computeStats(messages))
  assert.equal(derived.longShare, 0.5)
  assert.ok(derived.threshold >= 10)
})

test('a fragmentary speaker is never asked to write long', () => {
  // dennis writes 80% of messages within 8 characters; asking for length would
  // change who he is.
  assert.equal(shouldAskForLong([1, 1, 2, 1, 3, 1], { longShare: 0.1, threshold: 11 }), false)
})

test('the first replies are left alone so the shape can appear naturally', () => {
  assert.equal(shouldAskForLong([2, 3], plan), false)
})

test('long replies behind their share trigger the request', () => {
  assert.equal(shouldAskForLong([2, 3, 1, 4, 2, 3], plan), true)
})

test('long replies at their share do not repeat the request', () => {
  // 3 of 6 are long, ahead of the 44% target.
  assert.equal(shouldAskForLong([15, 2, 18, 3, 20, 1], plan), false)
})

test('the nudge states a length and allows a comma', () => {
  const hint = longHint(14)
  assert.match(hint, /14 个字以上/)
  assert.match(hint, /逗号/)
})

