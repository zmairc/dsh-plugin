import { test } from 'node:test'
import assert from 'node:assert/strict'
import { annotateCatchphrases, buildChunks, verifyEvidence, consolidateObservations, extractJson, mergeObservations, observeChunks, renderChunk, renderDraft, toObservation, verifySamples } from '../src/core/distill.ts'
import type { LlmConfig } from '../src/core/llm.ts'
import type { ChatMessage } from '../src/core/types.ts'
import { computeStats } from '../src/core/stats.ts'

let counter = 0

/** Build a message at a fixed base time plus an offset. */
function message(role: 'self' | 'friend', text: string, offsetMs = 0): ChatMessage {
  counter += 1
  return {
    v: 1,
    id: `t:${counter}`,
    convId: 'c',
    source: 'manual',
    role,
    senderName: role === 'self' ? '我' : '他',
    ts: Date.UTC(2024, 0, 1) + offsetMs,
    kind: 'text',
    text,
  }
}

test('chunks pack separate sessions together when size allows', () => {
  const messages = [
    message('self', 'a', 0),
    message('friend', 'b', 1000),
    message('self', 'c', 10 * 3600_000),
  ]
  const chunks = buildChunks(messages, 100)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].length, 3)
})

test('a single long conversation is still cut to the size limit', () => {
  const messages: ChatMessage[] = []
  for (let index = 0; index < 25; index += 1) {
    messages.push(message('friend', `x${index}`, index * 1000))
  }
  const chunks = buildChunks(messages, 10)
  assert.equal(chunks.length, 3)
  for (const chunk of chunks) assert.ok(chunk.length <= 10)
})

test('chunks pack windows up to the size limit', () => {
  const messages: ChatMessage[] = []
  for (let index = 0; index < 5; index += 1) {
    messages.push(message('friend', `x${index}`, index * 1000))
  }
  const chunks = buildChunks(messages, 2)
  assert.equal(chunks.length, 3)
  assert.equal(chunks[0].length, 2)
  assert.equal(chunks[2].length, 1)
})

test('chunks drop third parties', () => {
  const other: ChatMessage = { ...message('friend', 'noise'), role: 'other' }
  const chunks = buildChunks([message('self', 'a'), other], 10)
  assert.equal(chunks.flat().length, 1)
})

test('chunks drop platform notices', () => {
  const notice: ChatMessage = { ...message('friend', ''), kind: 'system' }
  const chunks = buildChunks([message('self', 'a'), notice], 10)
  assert.equal(chunks.flat().length, 1)
})

test('extractJson handles fenced output', () => {
  const value = extractJson('```json\n{"a":1}\n```') as { a: number }
  assert.equal(value.a, 1)
})

test('extractJson handles surrounding prose', () => {
  const value = extractJson('好的，结果如下：\n{"a":2}\n以上。') as { a: number }
  assert.equal(value.a, 2)
})

test('extractJson rejects a reply with no object', () => {
  assert.throws(() => extractJson('没有 JSON'), /没有返回 JSON/)
})

test('toObservation drops wrong-typed fields instead of failing', () => {
  const observation = toObservation({
    traits: ['好的', 42, '  '],
    avoid: [{ behavior: '不安慰人', evidence: '我不知道' }, 42, '  '],
    catchphrases: 'not-an-array',
    humor: 7,
    topics: [{ name: '作业' }, 'bad'],
    samples: [{ user: 'a', reply: 'b' }, { user: 'x' }],
  })
  assert.deepEqual(observation.traits, [{ behavior: '好的', evidence: '' }])
  assert.deepEqual(observation.avoid, [{ behavior: '不安慰人', evidence: '我不知道' }])
  assert.deepEqual(observation.catchphrases, [])
  assert.equal(observation.humor, '')
  assert.deepEqual(observation.topics, [{ name: '作业', stance: '' }])
  assert.deepEqual(observation.samples, [{ turns: [{ role: 'self', text: 'a' }, { role: 'friend', text: 'b' }] }])
})

test('merging ranks repeated traits above one-offs', () => {
  const merged = mergeObservations([
    toObservation({ traits: ['常见', '少见'] }),
    toObservation({ traits: ['常见'] }),
  ])
  assert.equal(merged.traits[0].behavior, '常见')
  assert.equal(merged.traits[0].count, 2)
  assert.equal(merged.traits[1].count, 1)
})

test('merging keeps the first real quote for a repeated behavior', () => {
  const merged = mergeObservations([
    toObservation({ traits: [{ behavior: '被夸就否认', evidence: '' }] }),
    toObservation({ traits: [{ behavior: '被夸就否认', evidence: '滚之' }] }),
  ])
  assert.equal(merged.traits[0].count, 2)
  assert.equal(merged.traits[0].evidence, '滚之')
})

test('avoid is merged separately from traits', () => {
  const merged = mergeObservations([
    toObservation({ traits: ['会做的事'], avoid: ['不安慰人', '不追问细节'] }),
    toObservation({ avoid: ['不安慰人'] }),
  ])
  assert.equal(merged.traits.length, 1)
  assert.equal(merged.avoid[0].behavior, '不安慰人')
  assert.equal(merged.avoid[0].count, 2)
})

test('merging deduplicates samples', () => {
  const merged = mergeObservations([
    toObservation({ samples: [{ user: 'a', reply: 'b' }] }),
    toObservation({ samples: [{ user: 'a', reply: 'b' }, { user: 'c', reply: 'd' }] }),
  ])
  assert.equal(merged.samples.length, 2)
})

test('draft separates measured from inferred content', () => {
  const merged = mergeObservations([toObservation({ traits: ['特征一'] })])
  const draft = renderDraft({ name: '他', styleBlock: '- 平均 4 字', merged })
  assert.match(draft, /说话方式（统计）/)
  assert.match(draft, /模型观察，需核对/)
  assert.match(draft, /他是谁（需要你补）/)
  assert.match(draft, /平均 4 字/)
})

test('draft renders a burst as consecutive turns, not a single exchange', () => {
  const merged = mergeObservations([
    toObservation({
      samples: [{ turns: [{ role: 'self', text: '改写完了' }, { role: 'friend', text: '行' }, { role: 'friend', text: '我看看' }] }],
    }),
  ])
  const draft = renderDraft({ name: '他', styleBlock: '## 风格指纹', merged })
  assert.match(draft, /> 你：改写完了\n> 他：行\n> 他：我看看/)
})

test('draft calls out the negative rules it inferred', () => {
  const merged = mergeObservations([toObservation({ avoid: ['不安慰人'] })])
  const draft = renderDraft({ name: '他', styleBlock: '## 风格指纹', merged })
  assert.match(draft, /他从不做什么/)
  assert.match(draft, /不安慰人/)
})

test('verifySamples relabels a turn only the other role said', () => {
  const messages = [message('self', '这巧合吧'), message('friend', '注意我的用词')]
  const verified = verifySamples(
    [{
      turns: [
        { role: 'friend', text: '这巧合吧' },
        { role: 'self', text: '注意我的用词' },
      ],
    }],
    messages,
  )
  assert.deepEqual(verified[0].turns, [
    { role: 'self', text: '这巧合吧' },
    { role: 'friend', text: '注意我的用词' },
  ])
})

test('verifySamples keeps labels that already match the archive', () => {
  const messages = [message('self', '在吗'), message('friend', '在')]
  const verified = verifySamples(
    [{ turns: [{ role: 'self', text: '在吗' }, { role: 'friend', text: '在' }] }],
    messages,
  )
  assert.deepEqual(verified[0].turns, [{ role: 'self', text: '在吗' }, { role: 'friend', text: '在' }])
})

test('verifySamples drops a window with no real line', () => {
  const verified = verifySamples(
    [{ turns: [{ role: 'friend', text: '这句根本不存在' }] }],
    [message('self', '在吗')],
  )
  assert.equal(verified.length, 0)
})

test('verifySamples ignores punctuation when matching', () => {
  const messages = [message('friend', '没改我现在要去洗澡了')]
  const verified = verifySamples(
    [{ turns: [{ role: 'self', text: '没改，我现在要去洗澡了。' }] }],
    messages,
  )
  assert.equal(verified[0].turns[0].role, 'friend')
})

test('annotateCatchphrases counts how often each phrase really occurs', () => {
  const messages = [
    message('friend', '行', 0),
    message('friend', '行吧', 1000),
    message('friend', '错误', 2000),
    message('self', '行', 3000),
  ]
  const annotated = annotateCatchphrases([{ text: '行', count: 2 }, { text: '错误', count: 1 }], messages)
  assert.equal(annotated[0].text, '行')
  assert.equal(annotated[0].archiveCount, 2)
  assert.equal(annotated[1].text, '错误')
  assert.equal(annotated[1].archiveCount, 1)
})

test('draft shows how often each catchphrase occurs', () => {
  const merged = mergeObservations([toObservation({ catchphrases: ['行'] })])
  merged.catchphrases = annotateCatchphrases(merged.catchphrases, [message('friend', '行')])
  const draft = renderDraft({ name: '他', styleBlock: '## 风格指纹', merged })
  assert.match(draft, /`行`\(他 1\)/)
})

test('a catchphrase the owner uses too is shown with both counts', () => {
  // The two sections used to disagree: style.md filtered shared vocabulary out,
  // persona.md listed it unmarked. Printing both counts hands the judgement to
  // the reader instead of hiding it.
  const merged = mergeObservations([toObservation({ catchphrases: ['行'] })])
  merged.catchphrases = annotateCatchphrases(merged.catchphrases, [
    message('friend', '行'),
    message('self', '行'),
    message('self', '行'),
  ])
  assert.equal(merged.catchphrases[0].archiveCount, 1)
  assert.equal(merged.catchphrases[0].selfCount, 2)
  assert.match(renderDraft({ name: '他', styleBlock: '## 风格指纹', merged }), /`行`\(他 1 \/ 你 2\)/)
})

test('a claim about exclamation marks the archive contradicts is flagged', () => {
  // A ban is the most damaging error: it freezes a real habit out of the persona.
  const merged = mergeObservations([toObservation({ avoid: [{ behavior: '不用感叹号', evidence: '' }] })])
  const messages = [message('friend', '太好了！'), message('friend', '真的！'), message('friend', '嗯')]
  const stats = computeStats(messages)
  const draft = renderDraft({ name: '他', styleBlock: '## 风格指纹', merged, stats })
  assert.match(draft, /和统计对不上/)
  assert.match(draft, /感叹号占 66\.7%/)
})

test('a claim the archive supports is not flagged', () => {
  const merged = mergeObservations([toObservation({ avoid: [{ behavior: '不用问号', evidence: '' }] })])
  const stats = computeStats([message('friend', '嗯'), message('friend', '行吧')])
  const draft = renderDraft({ name: '他', styleBlock: '## 风格指纹', merged, stats })
  assert.doesNotMatch(draft, /和统计对不上/)
})

test('annotateCatchphrases drops grammar words a model mistook for habits', () => {
  const messages = [message('friend', '我要走了'), message('friend', '行')]
  const annotated = annotateCatchphrases(
    [{ text: '我', count: 3 }, { text: '要', count: 2 }, { text: '行', count: 1 }],
    messages,
  )
  assert.deepEqual(annotated.map((item) => item.text), ['行'])
})

test('draft drops an avoid entry contained in another', () => {
  const merged = mergeObservations([toObservation({ avoid: ['不道歉', '不道歉不客套', '不安慰'] })])
  const draft = renderDraft({ name: '他', styleBlock: '## 风格指纹', merged })
  assert.equal((draft.match(/不道歉/g) ?? []).length, 1)
  assert.match(draft, /不安慰/)
})

test('draft flattens a multi-line quote onto one line', () => {
  const merged = mergeObservations([
    toObservation({ traits: [{ behavior: '说天气', evidence: '确实\n我们也下了' }] }),
  ])
  const draft = renderDraft({ name: '他', styleBlock: '## 风格指纹', merged })
  assert.match(draft, /← `确实 我们也下了`/)
})

test('merging drops address terms that are really curses', () => {
  const merged = mergeObservations([toObservation({ addressTerms: ['你这他妈', '你', '赵明', '老弟'] })])
  assert.deepEqual(merged.addressTerms, ['赵明', '老弟'])
})

test('merging drops a negative rule that bans long messages', () => {
  const merged = mergeObservations([
    toObservation({ avoid: ['不写长段解释', '不写长句', '不安慰人'] }),
  ])
  assert.deepEqual(merged.avoid.map((trait) => trait.behavior), ['不安慰人'])
})

test('annotateCatchphrases drops a time adverb', () => {
  const annotated = annotateCatchphrases([{ text: '刚', count: 1 }, { text: '行', count: 1 }], [message('friend', '行')])
  assert.deepEqual(annotated.map((item) => item.text), ['行'])
})

test('renderChunk truncates a pasted document instead of blowing up the context', () => {
  const rendered = renderChunk([message('friend', 'x'.repeat(2000))], '我', '他')
  assert.ok(rendered.length < 500)
  assert.match(rendered, /共 2000 字/)
})

test('a malformed JSON reply is retried once', async () => {
  const chunks = buildChunks(sixMessages(), 2)
  let calls = 0
  const merged = await observeChunks(CONFIG, chunks, NAMES, {
    chunkSize: 2,
    maxChunks: 10,
    onProgress: () => {},
    complete: async () => {
      calls += 1
      return calls === 1 ? '这不是 JSON' : JSON.stringify({ traits: ['重试成功'] })
    },
  })
  assert.equal(merged.failedChunks, 0)
  assert.equal(merged.traits[0].behavior, '重试成功')
})

test('annotateCatchphrases drops placeholders and bare letters', () => {
  const annotated = annotateCatchphrases(
    [{ text: '[敲打]', count: 1 }, { text: '0', count: 1 }, { text: 'e', count: 1 }, { text: '行', count: 1 }],
    [message('friend', '行')],
  )
  assert.deepEqual(annotated.map((item) => item.text), ['行'])
})

test('annotateCatchphrases drops a word that is really an emotion code', () => {
  const annotated = annotateCatchphrases(
    [{ text: '敲打', count: 1 }, { text: '行', count: 1 }],
    [message('friend', '[敲打][敲打]'), message('friend', '行')],
  )
  assert.deepEqual(annotated.map((item) => item.text), ['行'])
})

test('annotateCatchphrases drops a long system message', () => {
  const annotated = annotateCatchphrases(
    [{ text: '如需收钱，请点此升级至最新版本', count: 1 }, { text: '行', count: 1 }],
    [message('friend', '行')],
  )
  assert.deepEqual(annotated.map((item) => item.text), ['行'])
})

test('draft truncates an over-long quote', () => {
  const merged = mergeObservations([
    toObservation({ traits: [{ behavior: '发链接', evidence: 'x'.repeat(200) }] }),
  ])
  const draft = renderDraft({ name: '他', styleBlock: '## 风格指纹', merged })
  assert.match(draft, /← `x{60}…`/)
})

test('merging drops a rule that bans a feature the archive has', () => {
  const merged = mergeObservations([toObservation({ avoid: ['不用问号', '不安慰人'] })])
  assert.deepEqual(merged.avoid.map((trait) => trait.behavior), ['不安慰人'])
})

test('draft folds near-duplicate negative rules', () => {
  const merged = mergeObservations([
    toObservation({ avoid: ['不道歉', '不主动道歉', '不安慰人'] }),
  ])
  const draft = renderDraft({ name: '他', styleBlock: '## 风格指纹', merged })
  assert.equal((draft.match(/不道歉/g) ?? []).length, 1)
  assert.match(draft, /不安慰人/)
})

test('draft folds a topic whose name contains another', () => {
  const merged = mergeObservations([
    toObservation({ topics: [{ name: '跑步', stance: 'a' }, { name: '跑步去', stance: 'b' }, { name: '打游戏', stance: 'c' }] }),
  ])
  const draft = renderDraft({ name: '他', styleBlock: '## 风格指纹', merged })
  assert.equal((draft.match(/\*\*跑步/g) ?? []).length, 1)
  assert.match(draft, /\*\*打游戏\*\*/)
})

test('consolidateObservations folds many behaviors into a few', async () => {
  const traits = Array.from({ length: 30 }, (_, index) => ({ behavior: `行为${index}`, evidence: '' }))
  const merged = mergeObservations([toObservation({ traits })])
  const result = await consolidateObservations(CONFIG, merged, {
    complete: async () => JSON.stringify({ traits: [{ behavior: '合并后', evidence: '原话' }], avoid: [], topics: [] }),
  })
  assert.equal(result.traits.length, 1)
  assert.equal(result.traits[0].behavior, '合并后')
  assert.equal(result.traits[0].evidence, '原话')
})

test('consolidateObservations keeps the originals when the call fails', async () => {
  const traits = Array.from({ length: 30 }, (_, index) => ({ behavior: `行为${index}`, evidence: '' }))
  const merged = mergeObservations([toObservation({ traits })])
  const result = await consolidateObservations(CONFIG, merged, {
    complete: async () => {
      throw new Error('boom')
    },
  })
  assert.equal(result.traits.length, 30)
})

const CONFIG: LlmConfig = { baseUrl: 'http://127.0.0.1:1', apiKey: 'test', model: 'test', temperature: 0 }
const NAMES = { self: '我', friend: '他' }

/** Six messages, packed into three chunks of two. */
function sixMessages(): ChatMessage[] {
  return Array.from({ length: 6 }, (_, index) => message(index % 2 === 0 ? 'self' : 'friend', `x${index}`, index * 1000))
}

test('buildChunks rejects a zero size instead of looping forever', () => {
  assert.throws(() => buildChunks([message('friend', 'a')], 0), /正整数/)
  assert.throws(() => buildChunks([message('friend', 'a')], -5), /正整数/)
  assert.throws(() => buildChunks([message('friend', 'a')], 2.5), /正整数/)
})

test('one failing chunk does not lose the others', async () => {
  const chunks = buildChunks(sixMessages(), 2)
  assert.equal(chunks.length, 3)
  let calls = 0
  const merged = await observeChunks(CONFIG, chunks, NAMES, {
    chunkSize: 2,
    maxChunks: 10,
    onProgress: () => {},
    complete: async () => {
      calls += 1
      // Chunk 2 fails on both attempts; the retry must not mask a real failure.
      if (calls === 2 || calls === 3) throw new Error('boom')
      return JSON.stringify({ traits: [`特征${calls}`] })
    },
  })
  assert.equal(merged.totalChunks, 3)
  assert.equal(merged.failedChunks, 1)
  assert.deepEqual(merged.traits.map((item) => item.behavior).sort(), ['特征1', '特征4'])
})

test('a reply that is not JSON counts as a failed chunk', async () => {
  const chunks = buildChunks(sixMessages(), 2)
  const merged = await observeChunks(CONFIG, chunks, NAMES, {
    chunkSize: 2,
    maxChunks: 10,
    onProgress: () => {},
    complete: async () => '抱歉，我无法完成',
  })
  assert.equal(merged.failedChunks, 3)
  assert.equal(merged.traits.length, 0)
})

test('chunks skipped by the budget count against coverage', async () => {
  const chunks = buildChunks(sixMessages(), 2)
  const merged = await observeChunks(CONFIG, chunks, NAMES, {
    chunkSize: 2,
    maxChunks: 1,
    onProgress: () => {},
    complete: async () => JSON.stringify({ traits: ['只有一块'] }),
  })
  assert.equal(merged.totalChunks, 3)
  assert.equal(merged.failedChunks, 2)
  assert.equal(merged.traits[0].behavior, '只有一块')
})

test('a trait backed by the other person quote is dropped', () => {
  // Real bug: one persona shipped 「被吵醒受气就连发脏话长段宣泄」 backed by a
  // rant the friend's roommate had said. verifySamples fixed the sample
  // dialogue only; trait evidence was never checked.
  const messages = [
    message('self', '我真草他妈，斯比东西，没有自制力，还定这么多闹钟，把我吵醒'),
    message('friend', '行'),
  ]
  const traits = [{ behavior: '被吵醒就连发脏话', evidence: '我真草他妈，斯比东西，没有自制力' }]
  assert.deepEqual(verifyEvidence(traits, messages), [])
})

test('a trait backed by his own quote is kept', () => {
  const messages = [message('self', '在吗'), message('friend', '不忙，咋了')]
  const traits = [{ behavior: '被问就说咋了', evidence: '不忙，咋了' }]
  assert.equal(verifyEvidence(traits, messages).length, 1)
})

test('ambiguous or paraphrased evidence is kept', () => {
  // Dropping on uncertainty would throw away real traits.
  const messages = [message('self', '行'), message('friend', '行')]
  const traits = [
    { behavior: '不知道', evidence: '行' },
    { behavior: '概括出来的', evidence: '他习惯用短句' },
  ]
  assert.equal(verifyEvidence(traits, messages).length, 2)
})

