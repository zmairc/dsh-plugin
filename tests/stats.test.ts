import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeStats, renderSpeechRules, renderStyleBlock } from '../src/core/stats.ts'
import type { ChatMessage } from '../src/core/types.ts'

let counter = 0

/** Build a text message for a role at a fixed base time plus an offset. */
function message(role: 'self' | 'friend', text: string, offsetMs = 0): ChatMessage {
  counter += 1
  return {
    v: 1,
    id: `test:${counter}`,
    convId: 'c',
    source: 'manual',
    role,
    senderName: role === 'self' ? '我' : '他',
    ts: Date.UTC(2024, 0, 1) + offsetMs,
    kind: 'text',
    text,
  }
}

test('measures length distribution over the friend only', () => {
  const stats = computeStats([
    message('self', '这是一句很长很长的来自我的话'),
    message('friend', 'um', 1000),
    message('friend', 'abcd', 2000),
    message('friend', 'abcdefghij', 3000),
  ])
  assert.equal(stats.counts.friend, 3)
  assert.equal(stats.counts.self, 1)
  assert.equal(stats.length.median, 4)
  assert.equal(stats.length.min, 2)
  assert.equal(stats.length.max, 10)
})

test('counts consecutive friend messages as one burst', () => {
  const stats = computeStats([
    message('friend', 'a', 0),
    message('friend', 'b', 1000),
    message('friend', 'c', 2000),
    message('self', 'd', 5000),
    message('friend', 'e', 500_000),
  ])
  assert.ok(stats.bursts.meanRun > 1)
  const single = stats.bursts.distribution.find((entry) => entry.run === 1)
  assert.ok(single !== undefined)
})

test('reply delay measures self to the next friend message', () => {
  const stats = computeStats([
    message('self', '在吗', 0),
    message('friend', '在', 120_000),
  ])
  assert.equal(stats.replyDelay.median, 120)
})

test('initiator counts session starts by role', () => {
  const stats = computeStats([
    message('self', 'a', 0),
    message('friend', 'b', 1000),
    message('friend', 'c', 10 * 3600_000),
    message('self', 'd', 10 * 3600_000 + 1000),
  ])
  assert.equal(stats.initiator.self, 0.5)
  assert.equal(stats.initiator.friend, 0.5)
})

test('surfaces phrases the friend uses more than the owner', () => {
  const messages: ChatMessage[] = []
  for (let index = 0; index < 10; index += 1) {
    messages.push(message('friend', '绝了真的', index * 1000))
    messages.push(message('self', '好的收到', index * 1000 + 500))
  }
  const stats = computeStats(messages)
  assert.ok(stats.phrases.some((phrase) => phrase.token === '绝了'))
})

test('multi-character punctuation is detected per message', () => {
  const stats = computeStats([
    message('friend', '好吧。', 0),
    message('friend', '行吧。', 1000),
    message('friend', '嗯', 2000),
  ])
  const period = stats.punctuation.find((entry) => entry.mark === '。')
  assert.ok(period !== undefined)
  assert.ok(Math.abs(period.rate - 2 / 3) < 1e-9)
})

test('non-text messages count toward the media rate', () => {
  const media: ChatMessage = {
    v: 1,
    id: 'test:media',
    convId: 'c',
    source: 'manual',
    role: 'friend',
    senderName: '他',
    ts: Date.UTC(2024, 0, 1),
    kind: 'sticker',
  }
  const stats = computeStats([message('friend', '在', 1000), media])
  assert.ok(Math.abs(stats.mediaRate - 0.5) < 1e-9)
})

test('measures how many messages are only one or two characters', () => {
  const stats = computeStats([
    message('friend', '行', 0),
    message('friend', '走了', 1000),
    message('friend', '明天见吧', 2000),
    message('friend', '这是一句比较长的消息内容', 3000),
  ])
  assert.equal(stats.length.shortRate, 0.5)
  assert.equal(stats.length.briefRate, 0.75)
})

test('question rate and question-mark rate are reported separately', () => {
  const stats = computeStats([
    message('friend', '走不', 0),
    message('friend', '饭还没到吗', 1000),
    message('friend', '好的', 2000),
  ])
  const block = renderStyleBlock(stats, { self: '你', friend: '他' })
  // A "吗" ending counts as a question, but no message contains "？" or "?".
  assert.match(block, /问句率：33%/)
  assert.match(block, /问号字符：0%（疑问靠语气词，不靠问号）/)
  assert.match(block, /长度分布：8 字以内占 100%/)
})

test('phrase statistics sample evenly instead of truncating a huge archive', () => {
  const messages: ChatMessage[] = []
  for (let index = 0; index < 50_000; index += 1) {
    messages.push(message('friend', index % 2 === 0 ? '绝了真的' : '行', index * 1000))
  }
  const stats = computeStats(messages)
  const phrase = stats.phrases.find((entry) => entry.token === '绝了')
  assert.ok(phrase !== undefined)
  // 12,500 matching messages; sampling must scale the count back up.
  assert.ok(phrase.count > 10_000, `expected a scaled count, got ${phrase.count}`)
})

test('speech rules turn measured habits into instructions', () => {
  // The archive never had a question mark; generations kept adding them
  // because the style block reads as reference rather than as a rule.
  const messages = [message('friend', '嗯'), message('friend', '行'), message('friend', '这个作业我写完了，明天交'), message('self', '好')]
  const rules = renderSpeechRules(computeStats(messages))
  assert.match(rules, /不用问号/)
  assert.match(rules, /句尾不加句号/)
  assert.match(rules, /用来断长句/)
  // The length rule must keep room for long messages, or the persona freezes
  // into one-word replies — the mistake this project made twice before.
  assert.match(rules, /不要只会发短句/)
})

test('speech rules stay silent when nothing was measured', () => {
  assert.equal(renderSpeechRules(computeStats([message('self', '嗯')])), '')
})


