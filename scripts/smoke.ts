/**
 * Self-check for every offline layer. No network, no model, no credentials.
 * `node scripts/smoke.ts`
 */

import { readFileSync } from 'node:fs'
import { parseTranscript, splitHoldout } from '../src/core/parse.ts'
import { computeStats, renderStyleBlock } from '../src/core/stats.ts'
import { redact } from '../src/core/redact.ts'
import { buildPredictions } from '../src/cli/eval.ts'

const text = readFileSync(new URL('../personas/example/transcript.sample.txt', import.meta.url), 'utf8')
const parsed = parseTranscript(text, {
  source: 'manual',
  convId: 'demo',
  selfNames: ['我'],
  friendName: '老王',
})

console.log('strategy:', parsed.strategy)
console.log('speakers:', parsed.speakers.map((speaker) => `${speaker.name}=${speaker.role}(${speaker.count})`).join(' '))
console.log('messages:', parsed.messages.length)
console.log('first:', JSON.stringify(parsed.messages[0]))
console.log('media kinds:', parsed.messages.filter((message) => message.kind !== 'text').map((message) => message.kind))

const stats = computeStats(parsed.messages)
console.log('\n' + renderStyleBlock(stats, { self: '我', friend: '老王' }))

const { train, holdout } = splitHoldout(parsed.messages, 0.15)
console.log(`\nsplit: train=${train.length} holdout=${holdout.length}`)
const predictions = buildPredictions(holdout, 5)
console.log(`predictions: ${predictions.length}`)
for (const prediction of predictions.slice(0, 2)) {
  console.log(`  context=${prediction.context.length} truth=${JSON.stringify(prediction.truth)}`)
}

console.log('\nredact:', redact('打 13812345678 或 a@b.com 找我', ['老王']))
