import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTranscript, splitHoldout } from '../src/core/parse.ts'

const base = { source: 'manual' as const, convId: 'c' }

test('block layout splits speakers and assigns roles', () => {
  const text = [
    '老王  2024-03-15 21:08:12',
    '在吗',
    '',
    '我  2024-03-15 21:09:01',
    '在',
  ].join('\n')
  const parsed = parseTranscript(text, { ...base, selfNames: ['我'], friendName: '老王' })
  assert.equal(parsed.strategy, 'block')
  assert.equal(parsed.messages.length, 2)
  assert.equal(parsed.messages[0].role, 'friend')
  assert.equal(parsed.messages[0].text, '在吗')
  assert.equal(parsed.messages[1].role, 'self')
  assert.ok(parsed.messages[0].ts < parsed.messages[1].ts)
  assert.equal(parsed.syntheticTimestamps, false)
})

test('text before the first header is dropped, not attributed to a speaker', () => {
  const text = ['# 导出说明', '老王  2024-03-15 21:08:12', '在吗'].join('\n')
  const parsed = parseTranscript(text, { ...base, selfNames: ['我'], friendName: '老王' })
  assert.equal(parsed.messages.length, 1)
  assert.equal(parsed.speakers.length, 1)
})

test('inline prefix layout is detected', () => {
  const text = ['我：在吗', '老王：在', '我：最近怎么样', '老王：就那样'].join('\n')
  const parsed = parseTranscript(text, { ...base, selfNames: ['我'], friendName: '老王' })
  assert.equal(parsed.strategy, 'prefix')
  assert.equal(parsed.messages.length, 4)
  assert.deepEqual(parsed.messages.map((message) => message.role), ['self', 'friend', 'self', 'friend'])
})

test('unrecognized layout falls back to one voice and synthesizes timestamps', () => {
  const text = ['没有格式的第一行', '没有格式的第二行'].join('\n')
  const parsed = parseTranscript(text, { ...base, selfNames: ['我'], friendName: '他' })
  assert.equal(parsed.strategy, 'blob')
  assert.equal(parsed.syntheticTimestamps, true)
  assert.equal(parsed.messages.length, 2)
  assert.ok(parsed.messages[0].ts < parsed.messages[1].ts)
})

test('media placeholders become kinds, and text keeps only the words', () => {
  const text = [
    '老王  2024-03-15 21:08:12',
    '[表情]',
    '老王  2024-03-15 21:08:20',
    '[图片]你说这个',
  ].join('\n')
  const parsed = parseTranscript(text, { ...base, selfNames: ['我'], friendName: '老王' })
  assert.equal(parsed.messages[0].kind, 'sticker')
  assert.equal(parsed.messages[0].text, undefined)
  assert.equal(parsed.messages[1].kind, 'text')
  assert.equal(parsed.messages[1].text, '你说这个')
})

test('friend defaults to the most frequent non-self speaker', () => {
  const text = ['我：1', '老王：2', '老王：3', '老王：4'].join('\n')
  const parsed = parseTranscript(text, { ...base, selfNames: ['我'] })
  const friend = parsed.speakers.find((speaker) => speaker.role === 'friend')
  assert.equal(friend?.name, '老王')
})

test('holdout split keeps the tail', () => {
  const text = Array.from({ length: 10 }, (_, index) => `我：${index}`).join('\n')
  const parsed = parseTranscript(text, { ...base, selfNames: ['我'], friendName: '老王' })
  const { train, holdout } = splitHoldout(parsed.messages, 0.2)
  assert.equal(train.length, 8)
  assert.equal(holdout.length, 2)
  assert.equal(holdout[0].text, '8')
})

test('zero holdout keeps everything', () => {
  const text = '我：1'
  const parsed = parseTranscript(text, { ...base, selfNames: ['我'], friendName: '老王' })
  const { train, holdout } = splitHoldout(parsed.messages, 0)
  assert.equal(train.length, 1)
  assert.equal(holdout.length, 0)
})

test('bracket layout reads date sections and time headers', () => {
  const text = [
    '============================================================',
    '与 老王 的聊天记录',
    '2 条 · 2024-09-25 ~ 2024-09-25',
    '============================================================',
    '',
    '---------- 2024-09-25 ----------',
    '',
    '[22:32:24] 老王:',
    '    在吗',
    '',
    '[22:33:01] 我:',
    '    在',
  ].join('\n')
  const parsed = parseTranscript(text, { ...base, selfNames: ['我'] })
  assert.equal(parsed.strategy, 'bracket')
  assert.equal(parsed.messages.length, 2)
  assert.equal(parsed.messages[0].role, 'friend')
  assert.equal(parsed.messages[0].text, '在吗')
  assert.equal(parsed.messages[1].role, 'self')
  assert.equal(parsed.syntheticTimestamps, false)
})

test('bracket layout keeps a multi-line body with its speaker', () => {
  const text = [
    '---------- 2024-09-25 ----------',
    '[09:00:00] 老王:',
    '    第一行',
    '    第二行',
    '[09:00:10] 我:',
    '    好',
  ].join('\n')
  const parsed = parseTranscript(text, { ...base, selfNames: ['我'] })
  assert.equal(parsed.messages[0].text, '第一行\n第二行')
  assert.equal(parsed.messages[1].text, '好')
})

test('bracket layout accepts a body on the header line', () => {
  const text = [
    '---------- 2024-09-25 ----------',
    '[09:00:00] 老王: 在吗',
  ].join('\n')
  const parsed = parseTranscript(text, { ...base, selfNames: ['我'] })
  assert.equal(parsed.messages.length, 1)
  assert.equal(parsed.messages[0].text, '在吗')
})

test('a transfer notice becomes a system message, not talk', () => {
  const text = [
    '---------- 2024-09-25 ----------',
    '[09:00:00] 老王:',
    '    收到转账17.80元。如需收钱，请点此升级至最新版本',
    '[09:00:10] 我:',
    '    收到',
  ].join('\n')
  const parsed = parseTranscript(text, { ...base, selfNames: ['我'] })
  assert.equal(parsed.messages[0].kind, 'system')
  assert.equal(parsed.messages[0].text, undefined)
  assert.equal(parsed.messages[1].kind, 'text')
})
