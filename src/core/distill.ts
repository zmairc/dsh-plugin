/**
 * Distillation: turn a normalized archive into a persona draft.
 *
 * Four stages, in decreasing order of trustworthiness:
 *   1. statistics  — deterministic, computed here (see `stats.ts`)
 *   2. chunking    — conversation windows, no model involved
 *   3. observation — one structured model call per chunk
 *   4. merge       — frequency-ranked, then rendered as Markdown
 *
 * The output is explicitly a *draft*. Statistics are exact, quoted samples are
 * real, and everything a model inferred is marked as such, because a plausible
 * sounding trait is the easiest thing for a model to invent.
 */

import type { ChatMessage } from './types.ts'
import type { LlmConfig, WireMessage } from './llm.ts'
import { complete } from './llm.ts'

/** One observed behavior, always paired with the line that supports it. */
export interface Trait {
  /** What he does, phrased as a behavior that can be acted out. */
  behavior: string
  /** Verbatim quote that shows it; empty when the chunk had nothing. */
  evidence: string
}

/** One verbatim stretch of conversation; consecutive turns keep bursts visible. */
export interface Sample {
  turns: Array<{ role: 'self' | 'friend'; text: string }>
}

/** One chunk's structured reading of the conversation. */
export interface Observation {
  /** Concrete behaviors, not adjectives. */
  traits: Trait[]
  /**
   * Things he never does in this stretch. Negative rules are the easiest to
   * act on and the easiest for a model to invent, so they stay in their own
   * bucket rather than being mixed into `traits`.
   */
  avoid: Trait[]
  catchphrases: string[]
  addressTerms: string[]
  humor: string
  conflict: string
  topics: Array<{ name: string; stance: string }>
  /** Verbatim exchange windows, the most valuable output of the whole pipeline. */
  samples: Sample[]
}

/** Merged result across every chunk. */
export interface MergedObservation {
  traits: Array<Trait & { count: number }>
  avoid: Array<Trait & { count: number }>
  catchphrases: Array<{ text: string; count: number; archiveCount?: number }>
  addressTerms: string[]
  humor: string[]
  conflict: string[]
  topics: Array<{ name: string; stance: string }>
  samples: Sample[]
  /** Chunks that produced no usable JSON, so the user can judge coverage. */
  failedChunks: number
  totalChunks: number
}

/** How one model call is made; injectable so the pipeline can be exercised offline. */
export type Completer = (config: LlmConfig, messages: readonly WireMessage[]) => Promise<string>

/** Tuning for one distillation run. */
export interface DistillOptions {
  /** Messages per model call. */
  chunkSize: number
  /** Cap on model calls, so an accidental huge archive cannot run away. */
  maxChunks: number
  /** Progress callback for the CLI. */
  onProgress: (message: string) => void
  /** Model call to use; defaults to the real endpoint. */
  complete?: Completer
}

/** Conversation gap that starts a new session. */
const SESSION_GAP_MS = 30 * 60_000

/**
 * Split messages into conversation windows, then pack windows into chunks.
 *
 * Cutting on session boundaries keeps each chunk on one topic; packing to a
 * fixed size bounds the number of model calls.
 * @param messages - normalized messages, sorted by time.
 * @param size - target messages per chunk.
 * @returns chunks, each a contiguous run of one conversation.
 */
export function buildChunks(messages: readonly ChatMessage[], size: number): ChatMessage[][] {
  // A non-positive size would make the slicing loop below never advance.
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`chunk 大小必须是正整数，收到 ${size}`)
  }
  // Platform notices are neither side speaking, so they never enter a chunk.
  const usable = messages.filter((message) => message.role === 'self' || message.role === 'friend')
    .filter((message) => message.kind !== 'system')

  const windows: ChatMessage[][] = []
  let current: ChatMessage[] = []
  for (let index = 0; index < usable.length; index += 1) {
    const previous = index === 0 ? null : usable[index - 1]
    if (previous !== null && usable[index].ts - previous.ts > SESSION_GAP_MS && current.length > 0) {
      windows.push(current)
      current = []
    }
    current.push(usable[index])
  }
  if (current.length > 0) windows.push(current)

  // A single long conversation must still be cut, or one model call would
  // exceed the context window; small windows are then packed back together so
  // the number of calls stays low.
  const pieces: ChatMessage[][] = []
  for (const window of windows) {
    for (let index = 0; index < window.length; index += size) {
      pieces.push(window.slice(index, index + size))
    }
  }

  const chunks: ChatMessage[][] = []
  let packed: ChatMessage[] = []
  for (const piece of pieces) {
    if (packed.length + piece.length > size && packed.length > 0) {
      chunks.push(packed)
      packed = []
    }
    packed.push(...piece)
  }
  if (packed.length > 0) chunks.push(packed)
  return chunks
}

/** A single message longer than this is a forwarded article or code, not talk. */
const MAX_RENDER_CHARS = 300

/** Render one chunk as the transcript the model reads. */
export function renderChunk(chunk: readonly ChatMessage[], selfName: string, friendName: string): string {
  return chunk
    .map((message) => {
      const who = message.role === 'self' ? selfName : friendName
      const text = message.text
      const body = text === undefined
        ? `[${message.kind}]`
        : text.length > MAX_RENDER_CHARS
          // A pasted document would eat the whole context window; its opening
          // still shows his tone, and the note says what was cut.
          ? `${text.slice(0, MAX_RENDER_CHARS)}…（共 ${text.length} 字）`
          : text
      return `${who}：${body}`
    })
    .join('\n')
}

/**
 * Prompt asking for behaviors and negative rules rather than prose.
 * @param transcript - one chunk, already rendered.
 * @param selfName - how the owner appears in the transcript.
 * @param friendName - how the friend appears in the transcript.
 * @param displayName - what the draft should call the friend; usually a real name.
 */
function observePrompt(transcript: string, selfName: string, friendName: string, displayName: string): WireMessage[] {
  const alias = displayName === friendName ? '' : `（草稿里叫他「${displayName}」）`
  const system = `你在分析一段真实的微信聊天记录，目标是提炼「${friendName}」${alias}说话和做事的特征。

记录里「${selfName}」是记录的主人，「${friendName}」是要模仿的那个人。

只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字。字段：
{
  "traits": [{"behavior": "触发场景 → 他具体怎么反应，20 字内", "evidence": "他说的原话"}],
  "avoid": [{"behavior": "他一次都没做的事，20 字内", "evidence": "能佐证的原话，没有就留空"}],
  "catchphrases": ["他说的口头禅或高频短语，原样摘录，最多 8 条"],
  "addressTerms": ["他当面叫「${selfName}」用的词"],
  "humor": "他开玩笑的方式，一句话，看不出来就留空",
  "conflict": "他不高兴、被质疑、被调侃时的反应，一句话，看不出来就留空",
  "topics": [{"name": "常聊话题", "stance": "他对这件事的立场，一句话"}],
  "samples": [{"turns": [{"role": "self", "text": "原话"}, {"role": "friend", "text": "原话"}]}]
}

要求：
- traits 最多 5 条。每条必须是能照着演的（『被问成绩就只报数字，不加解释』），不要形容词（『他很谦虚』），也不要总结（『他喜欢用短句』）。同一个意思只写一次
- evidence 必须逐字摘录，只摘一条消息，不要跨行或拼接两条；找不到原话就留空字符串
- avoid 写他在这段记录里**一次都没做**的事：不安慰、不追问、不解释、不写括号、不用问号、不道歉……只写你能确认的，不确定就不写；近义条目只留一条（『不道歉』和『不道歉不客套』算重复）
- 不要把「多数时候短」写成「不写长句」或「从不说长句」：长句是正常的一部分，只写他确实一次都没有的行为
- 不要从「这一次没做」推出「从不做」：他这次没解释，不等于「不解释原因」。只有整段记录里反复出现同一种缺失，才能写进 avoid
- addressTerms 只收他当面叫你的词。他骂第三人的话、骂自己的话，不算称呼
- catchphrases 只收他换到任何话题都挂嘴边的词（行、妈的、来着），不要收只在某次对话里出现的话题词（比如一起看代码那天的 错误、提示），也不要收我/你/他/要/这/那这类单字虚词
- 不要写反问句、不要写"他很幽默"这类评价
- samples 里每条 turn 必须标对说话人：role 只能是 "self"（「${selfName}」说的）或 "friend"（「${friendName}」说的），不要把两个人弄反
- samples 摘 2–3 段连续对话，每段 2–6 条 turn，**尽量包含他连发的多条短消息**。必须原样摘录，不要补写、不要改写
- 看不出来的字段留空数组或空字符串，不要编`
  return [
    { role: 'system', content: system },
    { role: 'user', content: `聊天记录：\n\n${transcript}` },
  ]
}

/** Pull the first JSON object out of a model reply, tolerating fences and prose. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = fenced === null ? text : fenced[1]
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON')
  return JSON.parse(body.slice(start, end + 1))
}

/** Read a trait list, accepting both the object shape and bare strings. */
function toTraits(input: unknown): Trait[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((item): Trait[] => {
    if (typeof item === 'string') {
      const behavior = item.trim()
      return behavior.length > 0 ? [{ behavior, evidence: '' }] : []
    }
    if (typeof item !== 'object' || item === null) return []
    const record = item as Record<string, unknown>
    const behavior = String(record.behavior ?? record.text ?? '').trim()
    const evidence = String(record.evidence ?? record.quote ?? '').trim()
    return behavior.length > 0 ? [{ behavior, evidence }] : []
  })
}

/** Read sample windows, accepting both consecutive turns and the old question/reply pair. */
function toSamples(input: unknown): Sample[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((item): Sample[] => {
    if (typeof item !== 'object' || item === null) return []
    const record = item as Record<string, unknown>

    if (Array.isArray(record.turns)) {
      const turns = record.turns.flatMap((turn): Sample['turns'] => {
        if (typeof turn !== 'object' || turn === null) return []
        const entry = turn as Record<string, unknown>
        const role = String(entry.role ?? entry.who ?? '').toLowerCase()
        const text = String(entry.text ?? entry.content ?? '').trim()
        if (text.length === 0) return []
        if (['self', 'me', 'user', '我', '你'].includes(role)) return [{ role: 'self', text }]
        if (['friend', 'him', 'assistant', '他'].includes(role)) return [{ role: 'friend', text }]
        return []
      })
      // A sample with no friend turn shows nothing about him.
      return turns.some((turn) => turn.role === 'friend') ? [{ turns }] : []
    }

    const user = String(record.user ?? '').trim()
    const reply = String(record.reply ?? '').trim()
    if (user.length === 0 || reply.length === 0) return []
    return [{
      turns: [
        { role: 'self', text: user },
        { role: 'friend', text: reply },
      ],
    }]
  })
}

/** Normalize a quote for matching: whitespace and punctuation are not the signal. */
function normalizeText(text: string): string {
  return text.replace(/[\s。，、！？：；""''「」『』《》…—～·.,!?:;"'()\-]/g, '')
}

/**
 * Correct speaker labels in extracted samples using the archive itself.
 *
 * Models flip self/friend about as often as they get it right, and a sample
 * with the wrong speaker teaches the opposite of the truth. Each turn is looked
 * up in the set of lines that role actually sent; a turn that only the other
 * role sent is relabeled, and a window where none of the lines exist was
 * rewritten by the model, so it is dropped rather than shown as real.
 * @param samples - verbatim windows as the model reported them.
 * @param messages - the archive the windows came from.
 * @returns the windows with corrected labels and invented ones removed.
 */
export function verifySamples(samples: readonly Sample[], messages: readonly ChatMessage[]): Sample[] {
  const vocab = {
    self: new Set(messages.filter((message) => message.role === 'self').map((message) => normalizeText(message.text ?? ''))),
    friend: new Set(messages.filter((message) => message.role === 'friend').map((message) => normalizeText(message.text ?? ''))),
  }
  const said = (text: string, role: 'self' | 'friend'): boolean => {
    const key = normalizeText(text)
    return key.length > 0 && vocab[role].has(key)
  }

  const verified: Sample[] = []
  for (const sample of samples) {
    let anyFound = false
    const turns = sample.turns.map((turn): Sample['turns'][number] => {
      const selfSaid = said(turn.text, 'self')
      const friendSaid = said(turn.text, 'friend')
      if (selfSaid || friendSaid) anyFound = true
      // Both (a phrase either of them uses) or neither: leave it as reported.
      if (selfSaid === friendSaid) return turn
      return { role: selfSaid ? 'self' : 'friend', text: turn.text }
    })
    if (anyFound) verified.push({ turns })
  }
  return verified
}

/**
 * Grammar words, not habits. A pronoun or a particle is never a catchphrase,
 * and a model asked for frequent words will still offer `我` and `要`.
 */
const FUNCTION_WORDS = new Set([
  '我', '你', '他', '她', '它', '这', '那', '是', '的', '了', '在', '有',
  '就', '也', '都', '还', '和', '跟', '个', '们', '会', '能', '把', '被',
  '给', '让', '从', '到', '过', '着', '要', '对', '不', '没', '吗', '呢', '吧', '刚',
  // Connectives and openers belong to a separate "开头词" list, not here.
  '然后', '而且', '后来', '我也', '就是', '主要', '还有', '那个', '上面',
  '一会', '所以', '但是', '因为', '可是', '如果', '虽然', '不过', '只是', '其实',
  '不是', '没有', '才', '这个', '什么', '为什么', '怎么', '这样', '那样',
  '可', '得', '给我', '今天', '明天', '昨天', '来了', '感觉', '应该', '知道',
  '上', '啊', '快', '直接', '之', '才', '就是', '晚上', '早上', '中午', '拿', '无',
])

/** System or media words that are never a speaking habit. */
const SYSTEM_WORDS = /转账|红包|撤回|语音|通话|图片|文件|位置|链接|表情|系统/

/**
 * Attach how often each catchphrase actually occurs in the archive.
 *
 * The model reliably lists a context word from one conversation as a
 * catchphrase; the occurrence count lets a reader tell a habit from a one-off
 * and puts the real habits first. Pure grammar words are dropped outright.
 * @param phrases - phrases reported by the model, with how many chunks used them.
 * @param messages - the archive to count against.
 * @returns the same phrases with an archive count, most frequent first.
 */
export function annotateCatchphrases(
  phrases: ReadonlyArray<{ text: string; count: number }>,
  messages: readonly ChatMessage[],
): Array<{ text: string; count: number; archiveCount: number }> {
  // `[敲打]` is an emotion code and the model reports it without brackets, so a
  // bracket code in the archive means the "word" is an emoji, not a habit.
  const bracketCodes = new Set<string>()
  for (const message of messages) {
    for (const match of (message.text ?? '').matchAll(/\[([\p{Script=Han}A-Za-z0-9]{1,4})\]/gu)) {
      bracketCodes.add(match[1])
    }
  }
  const annotated = phrases
    .filter((phrase) => isUsableCatchphrase(phrase.text) && !bracketCodes.has(phrase.text.trim()))
    .map((phrase) => ({
      ...phrase,
      archiveCount: messages.filter((message) => message.role === 'friend' && (message.text ?? '').includes(phrase.text)).length,
    }))
  return annotated.sort((a, b) => b.archiveCount - a.archiveCount || b.count - a.count)
}

/** Coerce an unknown parsed value into an Observation, dropping wrong-typed fields. */export function toObservation(value: unknown): Observation {
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const strings = (input: unknown): string[] =>
    Array.isArray(input) ? input.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()) : []
  const topics = Array.isArray(record.topics)
    ? record.topics
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .map((item) => ({ name: String(item.name ?? '').trim(), stance: String(item.stance ?? '').trim() }))
        .filter((item) => item.name.length > 0)
    : []
  return {
    traits: toTraits(record.traits),
    avoid: toTraits(record.avoid),
    catchphrases: strings(record.catchphrases),
    addressTerms: strings(record.addressTerms),
    humor: typeof record.humor === 'string' ? record.humor.trim() : '',
    conflict: typeof record.conflict === 'string' ? record.conflict.trim() : '',
    topics,
    samples: toSamples(record.samples),
  }
}

/** A term of address is short and is not a curse aimed at someone else. */
const ADDRESS_NOISE = /他妈|几把|艹|操|妈的|傻|滚|死/

/**
 * Reject the "address terms" a model pulls from an insult.
 * `你这他妈` is a curse, not what he calls the owner, and a bare pronoun is
 * not a name either.
 */
function isAddressTerm(term: string): boolean {
  if (term.length === 0 || term.length > 4) return false
  if (term === '你' || term === '喂') return false
  return !ADDRESS_NOISE.test(term)
}

/** A negative rule that contradicts the measured length distribution. */
const LENGTH_BAN = /不[^，。]{0,6}(长句|长段|长文|长篇|长解释)/

/** A negative rule contradicted by the archive having that feature at all. */
const PRESENCE_BAN = /不(用|写|发|打)(问号|表情|标点)/

/** Whether a model-inferred negative rule contradicts the measured data. */
function isPlausibleBan(behavior: string): boolean {
  return !LENGTH_BAN.test(behavior) && !PRESENCE_BAN.test(behavior)
}

/** Catchphrases are short by definition; longer matches are system text or quotes. */
const MAX_CATCHPHRASE_LENGTH = 6

/**
 * Reject catchphrases that are noise rather than habit: emotion placeholders
 * (`[敲打]`), single Latin characters or digits (`e`, `0`), and grammar words.
 */
function isUsableCatchphrase(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_CATCHPHRASE_LENGTH) return false
  if (FUNCTION_WORDS.has(trimmed)) return false
  if (/^\[.+\]$/.test(trimmed)) return false
  if (SYSTEM_WORDS.test(trimmed)) return false
  if (trimmed.length === 1 && !/[\u4e00-\u9fff]/.test(trimmed)) return false
  return true
}

/** Merge a trait list and drop the length bans that would freeze the persona. */
function mergeTraits(values: readonly Trait[]): Array<Trait & { count: number }> {
  const map = new Map<string, Trait & { count: number }>()
  for (const trait of values) {
    const behavior = trait.behavior.trim()
    if (behavior.length === 0) continue
    const existing = map.get(behavior)
    if (existing === undefined) {
      map.set(behavior, { behavior, evidence: trait.evidence.trim(), count: 1 })
      continue
    }
    existing.count += 1
    // Prefer the first real quote; later chunks usually repeat the same one.
    if (existing.evidence.length === 0) existing.evidence = trait.evidence.trim()
  }
  return [...map.values()]
    .filter((trait) => isPlausibleBan(trait.behavior))
    // Same frequency: a behavior with a real quote is more useful than a
    // generic one-liner, so the quote decides the order.
    .sort((a, b) => b.count - a.count || b.evidence.length - a.evidence.length)
}

/**
 * Rank everything the chunks reported, so a trait one chunk noticed once does
 * not outweigh one every chunk noticed.
 * @param observations - one entry per successful chunk.
 * @returns merged, frequency-ranked observations.
 */
export function mergeObservations(observations: readonly Observation[]): MergedObservation {
  const tally = (values: readonly string[]): Map<string, number> => {
    const counts = new Map<string, number>()
    for (const value of values) {
      const key = value.trim()
      if (key.length === 0) continue
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }
  const ranked = (counts: Map<string, number>): Array<{ text: string; count: number }> =>
    [...counts].map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count || a.text.length - b.text.length)

  const seen = new Set<string>()
  const samples: Sample[] = []
  for (const observation of observations) {
    for (const sample of observation.samples) {
      const key = JSON.stringify(sample.turns)
      if (seen.has(key)) continue
      seen.add(key)
      samples.push(sample)
    }
  }

  const topicSeen = new Set<string>()
  const topics: Array<{ name: string; stance: string }> = []
  for (const observation of observations) {
    for (const topic of observation.topics) {
      if (topicSeen.has(topic.name)) continue
      topicSeen.add(topic.name)
      topics.push(topic)
    }
  }

  const uniqueLines = (values: readonly string[]): string[] => [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))]

  return {
    traits: mergeTraits(observations.flatMap((observation) => observation.traits)),
    avoid: mergeTraits(observations.flatMap((observation) => observation.avoid)),
    catchphrases: ranked(tally(observations.flatMap((observation) => observation.catchphrases))),
    addressTerms: uniqueLines(observations.flatMap((observation) => observation.addressTerms)).filter(isAddressTerm),
    humor: uniqueLines(observations.map((observation) => observation.humor)),
    conflict: uniqueLines(observations.map((observation) => observation.conflict)),
    topics,
    samples,
    failedChunks: 0,
    totalChunks: observations.length,
  }
}

/**
 * Run the model over every chunk and merge what comes back.
 * @param config - model endpoint settings.
 * @param chunks - conversation windows to read.
 * @param names - display names for the two speakers.
 * @param options - chunk budget and progress reporting.
 * @returns merged observations, including how many chunks failed.
 */
export async function observeChunks(
  config: LlmConfig,
  chunks: readonly ChatMessage[][],
  names: { self: string; friend: string; display?: string },
  options: DistillOptions,
): Promise<MergedObservation> {
  const selected = chunks.slice(0, Math.max(0, Math.floor(options.maxChunks)))
  const call = options.complete ?? complete
  const observations: Observation[] = []
  let failedChunks = 0

  for (let index = 0; index < selected.length; index += 1) {
    options.onProgress(`观察第 ${index + 1}/${selected.length} 块（${selected[index].length} 条消息）... `)
    // Malformed JSON is the one failure worth retrying: the model usually gets
    // it right on the second try, and a fallback parse would guess at data.
    let observed = false
    for (let attempt = 0; attempt < 2 && !observed; attempt += 1) {
      try {
        const reply = await call(
          config,
          observePrompt(
            renderChunk(selected[index], names.self, names.friend),
            names.self,
            names.friend,
            names.display ?? names.friend,
          ),
        )
        observations.push(toObservation(extractJson(reply)))
        observed = true
        options.onProgress(attempt > 0 ? 'ok（重试成功）\n' : 'ok\n')
      } catch (error) {
        if (attempt === 0) {
          options.onProgress('JSON 有问题，重试... ')
        } else {
          failedChunks += 1
          options.onProgress(`失败：${error instanceof Error ? error.message : String(error)}\n`)
        }
      }
    }
  }

  const merged = mergeObservations(observations)
  // Slices the run actually covered, so a truncated run never claims full coverage.
  merged.failedChunks = failedChunks + Math.max(0, chunks.length - selected.length)
  merged.totalChunks = chunks.length
  return merged
}

/**
 * Second pass over the merged observations: one model call that folds hundreds
 * of chunk-level behaviors into a handful a persona can actually use.
 *
 * Exact-match merging keeps every chunk's own wording, so on a large archive
 * the top entries are whichever phrasing happened to be shortest. This is the
 * reduce step that makes scale useful instead of noisy. Failure is contained:
 * the un-consolidated observations are still usable.
 * @param config - model endpoint settings.
 * @param merged - merged observations from every chunk.
 * @param options - progress reporting, an injectable model call, and the trigger size.
 * @returns the consolidated observations, or the input when it failed or was small enough.
 */
export async function consolidateObservations(
  config: LlmConfig,
  merged: MergedObservation,
  options: { onProgress?: (message: string) => void; complete?: Completer; minTraits?: number } = {},
): Promise<MergedObservation> {
  if (merged.traits.length <= (options.minTraits ?? 20)) return merged
  const call = options.complete ?? complete

  const traits = merged.traits.slice(0, 80).map((trait) =>
    `- ${trait.behavior}（${trait.count} 段提到）${trait.evidence.length > 0 ? ` ← ${trait.evidence}` : ''}`)
  const avoid = merged.avoid.slice(0, 40).map((trait) => `- ${trait.behavior}`)
  const humor = merged.humor.slice(0, 10).map((item) => `- ${item}`)
  const topics = merged.topics.slice(0, 30).map((topic) => `- ${topic.name}：${topic.stance}`)
  const input = [
    '行为特征：', ...traits, '',
    '他从不做的事：', ...avoid, '',
    '幽默和火气：', ...humor, '',
    '常聊话题和立场：', ...topics,
  ].join('\n')

  const system = `你在整理一份人物观察笔记。下面是模型分段读出的记录，括号里是被多少段对话提到。

只输出一个 JSON 对象：
{"traits":[{"behavior":"行为，20 字内","evidence":"原话"}],"avoid":[{"behavior":"他从不做的事","evidence":""}],"topics":[{"name":"话题","stance":"立场"}]}

要求：
- traits 最多 8 条。合并同义项，保留最具体、最能照着演的
- behavior 必须能直接照着演（『被问成绩就报数字，不解释』），不要形容词，不要『喜欢…』『经常…』式总结
- evidence 只能从下面摘，不要新写；没有就留空字符串
- avoid 最多 5 条，只留能确认的
- topics 最多 10 条
- 不要新增下面没有的内容`

  options.onProgress?.('归纳观察结果... ')
  try {
    const reply = await call(config, [
      { role: 'system', content: system },
      { role: 'user', content: input },
    ])
    const consolidated = toObservation(extractJson(reply))
    if (consolidated.traits.length === 0) throw new Error('归纳结果里没有特征')
    options.onProgress?.(`ok（${merged.traits.length} 条 → ${consolidated.traits.length} 条）\n`)
    return {
      ...merged,
      traits: consolidated.traits.map((trait) => ({ ...trait, count: 1 })),
      avoid: consolidated.avoid.map((trait) => ({ ...trait, count: 1 })),
      topics: consolidated.topics,
    }
  } catch (error) {
    options.onProgress?.(`失败，保留原始观察：${error instanceof Error ? error.message : String(error)}\n`)
    return merged
  }
}

/** Inputs the renderer needs beyond the merged observations. */
export interface RenderInput {
  /** Display name for the persona, used as the heading. */
  name: string
  styleBlock: string
  merged: MergedObservation
}

/** Longest quote shown beside a behavior; longer ones are pasted documents. */
const MAX_EVIDENCE_CHARS = 60

/** Render one behavior with its supporting quote, flattened onto one line. */
function behaviorLine(trait: Trait, count: number): string {
  let evidence = trait.evidence.replace(/\s+/g, ' ').trim()
  if (evidence.length > MAX_EVIDENCE_CHARS) evidence = `${evidence.slice(0, MAX_EVIDENCE_CHARS)}…`
  const support = evidence.length > 0 ? ` ← \`${evidence}\`` : ''
  const repeated = count > 1 ? `（${count} 块都提到）` : ''
  return `- ${trait.behavior}${repeated}${support}`
}

/**
 * Levenshtein distance, used to catch near-duplicate rules such as
 * "不道歉" and "不主动道歉" that exact matching keeps apart.
 */
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const previous = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
      diagonal = previous
    }
  }
  return row[b.length]
}

/** Whether two short phrases say the same thing: contained or one edit apart. */
function similarPhrases(a: string, b: string): boolean {
  if (a.includes(b) || b.includes(a)) return true
  const longest = Math.max(a.length, b.length)
  if (longest === 0) return true
  return 1 - editDistance(a, b) / longest >= 0.6
}

/** Drop entries whose text is contained in, or nearly the same as, another kept entry. */
function dedupeBySimilarity<T>(items: readonly T[], textOf: (item: T) => string): T[] {
  const kept: T[] = []
  for (const item of items) {
    const text = textOf(item)
    if (kept.some((other) => similarPhrases(textOf(other), text))) continue
    kept.push(item)
  }
  return kept
}

/**
 * Render a persona Markdown draft.
 * @param input - name, statistics block, and merged observations.
 * @returns Markdown text, with inferred content clearly separated from measured content.
 */
export function renderDraft(input: RenderInput): string {
  const { name, styleBlock, merged } = input
  const lines: string[] = []

  lines.push(
    `# ${name}`,
    '',
    '> 由 `distill` 自动生成的初稿。',
    '> **统计部分是精确的**（从全部消息算出来的）。',
    '> **观察部分是模型读出来的**，可能不准，需要你核对。',
    '> **示例是真实原话**，可以直接用。',
    '',
    '## 说话方式（统计）',
    '',
    // The stats renderer emits its own `## 风格指纹` heading; demote it one
    // level so it nests under 说话方式 instead of fighting it.
    styleBlock.trimStart().replace(/^## /m, '### '),
    '',
    '## 他的特征（模型观察，需核对）',
    '',
  )
  if (merged.traits.length === 0) {
    lines.push('- （这一块没跑出结果）')
  } else {
    for (const trait of dedupeBySimilarity(merged.traits, (item) => item.behavior).slice(0, 8)) {
      lines.push(behaviorLine(trait, trait.count))
    }
  }

  if (merged.avoid.length > 0) {
    lines.push(
      '',
      '## 他从不做什么（模型观察，最有用，也最容易编）',
      '',
      '> 一条没把握的否定规则比没有更糟，逐条核对，删掉不确定的。',
      '',
    )
    for (const trait of dedupeBySimilarity(merged.avoid, (item) => item.behavior).slice(0, 6)) {
      lines.push(`- ${trait.behavior}`)
    }
  }

  if (merged.catchphrases.length > 0) {
    lines.push('', '## 口头禅（模型摘录，括号里是全库出现次数）', '')
    const unique = dedupeBySimilarity(merged.catchphrases, (item) => item.text)
    lines.push(
      unique
        .slice(0, 16)
        .map((item) => `\`${item.text}\`${item.archiveCount === undefined ? '' : `(${item.archiveCount})`}`)
        .join('　'),
    )
  }

  if (merged.addressTerms.length > 0) {
    lines.push('', '## 他怎么称呼你（模型观察，需核对）', '')
    lines.push(merged.addressTerms.map((item) => `\`${item}\``).join('　'))
  }

  const behavior = dedupeBySimilarity(
    [...merged.humor, ...merged.conflict].filter((item) => item.length > 0),
    (item) => item,
  )
  if (behavior.length > 0) {
    lines.push('', '## 他的幽默和火气（模型观察，需核对）', '')
    for (const item of behavior.slice(0, 8)) lines.push(`- ${item}`)
  }

  if (merged.topics.length > 0) {
    lines.push('', '## 常聊的和立场（模型观察，需核对）', '')
    for (const topic of dedupeBySimilarity(merged.topics, (item) => item.name).slice(0, 12)) {
      lines.push(`- **${topic.name}**${topic.stance.length > 0 ? `：${topic.stance}` : ''}`)
    }
  }

  if (merged.samples.length > 0) {
    lines.push('', '## 真实对话（原话，最有用）', '')
    for (const sample of merged.samples.slice(0, 6)) {
      for (const turn of sample.turns) {
        lines.push(`> ${turn.role === 'self' ? '你' : '他'}：${turn.text}`)
      }
      lines.push('')
    }
  }

  lines.push(
    '## 他是谁（需要你补）',
    '',
    '- 年龄、做什么工作、和你什么关系',
    '- 怎么认识的、多久见一次',
    '- 他叫你什么、你叫他什么',
    '- 他的雷区、不能提的事',
    '- 被夸的时候他怎么回、求人帮忙时怎么开口',
    '- 聊天记录里没有、但你知道的习惯',
    '',
    `覆盖 ${merged.totalChunks - merged.failedChunks}/${merged.totalChunks} 块对话。`,
    '失败的块没有参与生成，块数越少可信度越低。',
    '',
  )

  return lines.join('\n')
}
