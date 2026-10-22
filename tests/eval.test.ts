import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPredictions, findLeaked, selectSpread } from '../src/cli/eval.ts'
import type { ChatMessage } from '../src/core/types.ts'

let counter = 0

/** Build a message at a fixed base time plus an offset. */
function message(role: 'self' | 'friend', text: string, offsetMs = 0): ChatMessage {
  counter += 1
  return {
    v: 1,
    id: `e:${counter}`,
    convId: 'c',
    source: 'manual',
    role,
    senderName: role === 'self' ? '我' : '他',
    ts: Date.UTC(2024, 0, 1) + offsetMs,
    kind: 'text',
    text,
  }
}

test('a prediction pairs the real reply with the turn before it', () => {
  const messages = [message('self', '在吗'), message('friend', '在')]
  const predictions = buildPredictions(messages, 10)
  assert.equal(predictions.length, 1)
  assert.equal(predictions[0].truth, '在')
  assert.deepEqual(predictions[0].context, [{ role: 'user', content: '在吗' }])
})

test('a friend message without a preceding self turn is skipped', () => {
  const messages = [
    message('friend', '在', 0),
    message('friend', '睡了', 1000),
    message('self', '明天见', 2000),
    message('friend', '行', 3000),
  ]
  const predictions = buildPredictions(messages, 10)
  assert.equal(predictions.length, 1)
  assert.equal(predictions[0].truth, '行')
})

test('the context window is capped and stays in order', () => {
  const messages: ChatMessage[] = []
  for (let index = 0; index < 10; index += 1) {
    messages.push(message(index % 2 === 0 ? 'self' : 'friend', `x${index}`, index * 1000))
  }
  const predictions = buildPredictions(messages, 10)
  const last = predictions[predictions.length - 1]
  assert.ok(last.context.length <= 8)
  assert.deepEqual(last.context.map((wire) => wire.content), ['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8'])
})

test('the limit stops prediction building', () => {
  const messages: ChatMessage[] = []
  for (let index = 0; index < 40; index += 1) {
    messages.push(message(index % 2 === 0 ? 'self' : 'friend', `x${index}`, index * 1000))
  }
  assert.equal(buildPredictions(messages, 3).length, 3)
})

test('media messages are neither truth nor context', () => {
  const image: ChatMessage = { ...message('friend', ''), kind: 'image' }
  const messages = [message('self', '看图'), image, message('self', '在吗'), message('friend', '在')]
  const predictions = buildPredictions(messages, 10)
  assert.equal(predictions.length, 1)
  assert.equal(predictions[0].truth, '在')
  assert.deepEqual(predictions[0].context.map((wire) => wire.content), ['看图', '在吗'])
})

test('findLeaked flags an answer the persona already quotes', () => {
  const predictions = [
    { context: [{ role: 'user' as const, content: '在吗' }], truth: '我要是九点多没醒，你给我打电话' },
    { context: [{ role: 'user' as const, content: '今天好热' }], truth: '走' },
  ]
  const system = '# 吴文哲\n\n> 我要是九点多没醒，你给我打电话'
  assert.deepEqual(findLeaked(predictions, [system]), [0])
})

test('findLeaked flags a window whose lines were quoted', () => {
  const context = [
    { role: 'user' as const, content: '洗不洗衣服' },
    { role: 'assistant' as const, content: '我就一身' },
  ]
  const predictions = [{ context, truth: '明天再洗吧' }]
  const system = '> 你：洗不洗衣服\n> 他：我就一身'
  assert.deepEqual(findLeaked(predictions, [system]), [0])
})

test('findLeaked leaves an unseen answer alone', () => {
  const predictions = [{ context: [{ role: 'user' as const, content: '在吗' }], truth: '在' }]
  assert.deepEqual(findLeaked(predictions, ['完全不相关的人设']), [])
})

test('buildPredictions records where each task sits in the holdout', () => {
  const messages = [message('self', '在吗'), message('friend', '在')]
  assert.equal(buildPredictions(messages, 10)[0].index, 1)
})

test('selectSpread spaces items so one answer is not the next context', () => {
  const predictions = Array.from({ length: 10 }, (_, i) => ({ context: [], truth: 'x', index: i * 2 }))
  const picked = selectSpread(predictions, 4)
  assert.deepEqual(picked.map((prediction) => prediction.index), [0, 6, 12, 18])
})

test('selectSpread relaxes spacing when the slice is short', () => {
  const predictions = Array.from({ length: 5 }, (_, i) => ({ context: [], truth: 'x', index: i }))
  const picked = selectSpread(predictions, 3)
  assert.deepEqual(picked.map((prediction) => prediction.index), [0, 2, 4])
})

