import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  aggregateBigFive,
  assessTranscripts,
  countUnverified,
  meanScores,
  personalityDistance,
  renderBigFiveReport,
  renderReplyItems,
  sumUnverified,
  toBigFive,
  verifyBigFiveEvidence,
} from '../src/core/bigfive.ts'
import type { LlmConfig } from '../src/core/llm.ts'

const config: LlmConfig = { baseUrl: 'http://x', apiKey: 'k', model: 'm', temperature: 0 }

/** A well-formed judge reply covering all five dimensions. */
function fullReply(): unknown {
  return {
    openness: { score: 4, evidence: ['这个怎么玩的', '我研究研究'] },
    conscientiousness: { score: 2, evidence: ['明天再说'] },
    extraversion: { score: 3, evidence: [] },
    agreeableness: { score: 2, evidence: ['那不关我事'] },
    neuroticism: { score: 3, evidence: [] },
  }
}

test('toBigFive reads a full judge reply', () => {
  const observation = toBigFive(fullReply())
  assert.equal(observation.scores.openness, 4)
  assert.equal(observation.scores.neuroticism, 3)
  assert.deepEqual(observation.evidence.openness, ['这个怎么玩的', '我研究研究'])
  // Empty evidence arrays stay absent, not empty arrays.
  assert.equal(observation.evidence.extraversion, undefined)
})

test('toBigFive coerces string scores, clamps ranges, and drops garbage', () => {
  const observation = toBigFive({
    openness: { score: '4', evidence: [] },
    conscientiousness: { score: 9, evidence: [] },
    extraversion: { score: 0, evidence: [] },
    agreeableness: { score: 'high', evidence: [] },
    neuroticism: 2,
  })
  assert.equal(observation.scores.openness, 4)
  assert.equal(observation.scores.conscientiousness, 5)
  assert.equal(observation.scores.extraversion, 1)
  assert.equal(observation.scores.agreeableness, undefined)
  // A bare number is a legal shorthand some models fall into.
  assert.equal(observation.scores.neuroticism, 2)
})

test('toBigFive keeps only string evidence', () => {
  const observation = toBigFive({
    openness: { score: 4, evidence: ['真的', 42, null, '  '] },
  })
  assert.deepEqual(observation.evidence.openness, ['真的'])
})

test('verifyBigFiveEvidence drops invented quotes and keeps real ones', () => {
  const observation = toBigFive({
    openness: { score: 4, evidence: ['这个怎么玩的', '我从来不说的原话', '受着'] },
  })
  const verified = verifyBigFiveEvidence(observation, ['我说：这个怎么玩的？', '别的'])
  // Found ignoring punctuation, invented quote dropped, too-short quote kept.
  assert.deepEqual(verified.evidence.openness, ['这个怎么玩的', '受着'])
  assert.equal(countUnverified(observation, verified).openness, 1)
})

test('aggregation averages scores per dimension and counts only scored chunks', () => {
  const summary = aggregateBigFive(
    [
      toBigFive(fullReply()),
      toBigFive({ openness: { score: 2, evidence: [] }, neuroticism: { score: 5, evidence: [] } }),
    ],
    sumUnverified([{ openness: 0, conscientiousness: 0, extraversion: 0, agreeableness: 0, neuroticism: 0 }]),
    1,
  )
  assert.equal(summary.chunks, 2)
  assert.equal(summary.failedChunks, 1)
  assert.equal(summary.stats.openness.n, 2)
  assert.equal(summary.stats.openness.mean, 3)
  assert.equal(summary.stats.openness.std, 1)
  // Extraversion appeared in one chunk only.
  assert.equal(summary.stats.extraversion.n, 1)
  assert.equal(summary.stats.agreeableness.n, 1)
  assert.equal(summary.stats.agreeableness.mean, 2)
})

test('aggregation dedups evidence across chunks and sorts by chunk count', () => {
  const summary = aggregateBigFive(
    [
      toBigFive({ openness: { score: 4, evidence: ['行，你吃啥'] } }),
      toBigFive({ openness: { score: 4, evidence: ['行，你吃啥！', '我研究研究'] } }),
      toBigFive({ openness: { score: 4, evidence: ['行，你吃啥'] } }),
    ],
    sumUnverified([]),
    0,
  )
  // Punctuation-insensitive dedup: the first spelling wins, three chunks cite it.
  assert.equal(summary.evidence.openness?.[0].count, 3)
  assert.equal(summary.evidence.openness?.length, 2)
})

test('personalityDistance is 0 for identical profiles and scales gaps to 0-1', () => {
  const base = meanScores(aggregateBigFive([toBigFive(fullReply())], sumUnverified([]), 0))
  assert.equal(personalityDistance(base, base), 0)
  const up = { openness: 5, conscientiousness: 3, extraversion: 4, agreeableness: 3, neuroticism: 4 }
  const down = { openness: 4, conscientiousness: 2, extraversion: 3, agreeableness: 2, neuroticism: 3 }
  // Every dimension one point apart: |1|/4 averaged.
  assert.equal(personalityDistance(up, down), 0.25)
  // Only shared dimensions count.
  assert.equal(personalityDistance({ openness: 3 }, { openness: 5 }), 0.5)
  // Nothing shared cannot be compared.
  assert.equal(personalityDistance({}, { openness: 5 }), 1)
})

test('renderReplyItems shows the situation and labels the reply under assessment', () => {
  const text = renderReplyItems([
    {
      context: [
        { role: 'user', content: '你咋了' },
        { role: 'assistant', content: '没事' },
      ],
      reply: '行吧',
    },
  ])
  assert.match(text, /【第 1 段】/)
  assert.match(text, /对方：你咋了/)
  assert.match(text, /他：没事/)
  assert.match(text, /他回：行吧/)
})

test('renderReplyItems caps long lines so one pasted document cannot eat the call', () => {
  const text = renderReplyItems([{ context: [{ role: 'user', content: '长'.repeat(300) }], reply: '行' }])
  assert.ok(!text.includes('长'.repeat(250)))
  assert.match(text, /…/)
})

test('the report names the person, shows every dimension, and carries the caveat', () => {
  const summary = aggregateBigFive(
    [toBigFive(fullReply())],
    sumUnverified([{ openness: 1, conscientiousness: 0, extraversion: 0, agreeableness: 0, neuroticism: 0 }]),
    0,
  )
  const report = renderBigFiveReport('赵明', summary, 'data/zhaoming.jsonl（562 条消息）')
  assert.match(report, /# 大五人格 · 赵明/)
  assert.match(report, /聊天记录里的他/)
  for (const label of ['开放性', '尽责性', '外向性', '宜人性', '神经质']) assert.ok(report.includes(label))
  assert.match(report, /「这个怎么玩的」/)
  assert.match(report, /1 条证据没能/)

  // A dimension with no scores shows a dash instead of a made-up number.
  const empty = aggregateBigFive([toBigFive({ openness: { score: 4, evidence: [] } })], sumUnverified([]), 0)
  const emptyReport = renderBigFiveReport('赵明', empty, 'data/x.jsonl')
  assert.match(emptyReport, /\| 尽责性 \| — \|/)
})

test('assessTranscripts retries malformed JSON once and counts hard failures', async () => {
  const replies = [
    JSON.stringify(fullReply()),
    '不是 JSON',
    JSON.stringify(fullReply()),
    '还是不行',
    '再不行',
  ]
  let call = 0
  const { observations, failed } = await assessTranscripts(config, ['a', 'b', 'c'], '你', '他', {
    complete: async () => replies[call++ % replies.length],
  })
  assert.equal(observations.length, 2)
  assert.equal(failed, 1)
})
