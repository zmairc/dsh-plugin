/**
 * Statistical style fingerprint.
 *
 * This layer needs no model and no network: message length, cadence, reply
 * delay, punctuation, emoji, and distinctive phrases are counted directly from
 * the archive. These numbers carry more persona signal per token than any
 * sentence a model writes about someone, and they are exactly reproducible.
 */

import type { ChatMessage } from './types.ts'

/** One entry in a ranked frequency list. */
export interface Ranked {
  token: string
  count: number
}

/** One entry in a ranked phrase list, with the owner's competing rate. */
export interface Phrase extends Ranked {
  /** Share of the friend's text messages containing the phrase. */
  friendRate: number
  /** Share of the owner's text messages containing the phrase. */
  selfRate: number
}

/** Everything the statistics layer measures. */
export interface StyleStats {
  counts: { total: number; self: number; friend: number; other: number }
  /** Length in characters over the friend's text messages. */
  length: {
    mean: number
    median: number
    p90: number
    min: number
    max: number
    /** Share of messages that are 1-2 characters. */
    shortRate: number
    /** Share of messages that fit in 8 characters. */
    briefRate: number
    /** Messages over 1000 characters: pasted articles, code, or long forwards. */
    longCount: number
  }
  /** Share of the friend's text messages containing each punctuation mark. */
  punctuation: Array<{ mark: string; rate: number }>
  emojiTop: Ranked[]
  /** Phrases the friend uses proportionally more than the owner. */
  phrases: Phrase[]
  /** Consecutive friend messages sent within a minute. */
  bursts: { meanRun: number; distribution: Array<{ run: number; share: number }> }
  /** Seconds from the owner's message to the friend's next message. */
  replyDelay: { median: number; p90: number; mean: number }
  /** Share of conversation starts, by role. */
  initiator: { self: number; friend: number }
  /** Friend message counts per local hour, index 0-23. */
  hourHistogram: number[]
  questionRate: number
  mediaRate: number
  kinds: Record<string, number>
}

const EMOJI = /\p{Extended_Pictographic}/gu
const EMOJI_CODE = /\[[\p{Script=Han}A-Za-z]{1,6}\]/gu
const PUNCTUATION: ReadonlyArray<readonly [string, RegExp]> = [
  ['。', /。/],
  ['，', /，/],
  ['！', /！|!/],
  ['？', /？|\?/],
  ['…', /…|\.{3}/],
  ['～', /～|~/],
  ['、', /、/],
]

const BURST_GAP_MS = 60_000
const SESSION_GAP_MS = 30 * 60_000

/** Nearest-rank percentile over an ascending array. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

/** Mean of an array, or 0 when empty. */
function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/** Strip everything that is not a letter or digit, so n-grams span words not punctuation. */
function normalize(text: string): string {
  return text.replace(/[^\p{L}\p{N}]/gu, '')
}

/** Cap on messages sampled for phrase counting, so a huge archive cannot exhaust memory. */
const PHRASE_SAMPLE_MAX = 20_000

/** Count how many messages contain each 2-4 character phrase. */
function phraseCounts(messages: readonly ChatMessage[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const message of messages) {
    const text = normalize(message.text ?? '')
    if (text.length < 2 || text.length > 60) continue
    const seen = new Set<string>()
    for (let size = 2; size <= 4; size += 1) {
      for (let start = 0; start + size <= text.length; start += 1) {
        seen.add(text.slice(start, start + size))
      }
    }
    for (const phrase of seen) counts.set(phrase, (counts.get(phrase) ?? 0) + 1)
    if (counts.size > 1_000_000) break
  }
  return counts
}

/** Collect ranked emoji and bracketed emoji codes. */
function emojiCounts(messages: readonly ChatMessage[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const message of messages) {
    const text = message.text ?? ''
    for (const match of text.matchAll(EMOJI)) counts.set(match[0], (counts.get(match[0]) ?? 0) + 1)
    for (const match of text.matchAll(EMOJI_CODE)) counts.set(match[0], (counts.get(match[0]) ?? 0) + 1)
  }
  return counts
}

/** Top entries of a count map. */
function top(counts: Map<string, number>, limit: number): Ranked[] {
  return [...counts]
    .map(([token, count]) => ({ token, count }))
    .sort((a, b) => b.count - a.count || b.token.length - a.token.length)
    .slice(0, limit)
}

/**
 * Measure every style dimension from a normalized archive.
 * @param messages - normalized messages, sorted by time.
 * @returns the complete statistical fingerprint.
 */
export function computeStats(messages: readonly ChatMessage[]): StyleStats {
  const friend = messages.filter((message) => message.role === 'friend')
  const self = messages.filter((message) => message.role === 'self')
  const friendText = friend.filter((message) => message.kind === 'text' && (message.text ?? '').length > 0)
  const selfText = self.filter((message) => message.kind === 'text' && (message.text ?? '').length > 0)

  const lengths = friendText.map((message) => (message.text ?? '').length).sort((a, b) => a - b)
  const share = (limit: number): number =>
    friendText.length === 0 ? 0 : friendText.filter((message) => (message.text ?? '').length <= limit).length / friendText.length

  const punctuation = PUNCTUATION.map(([mark, pattern]) => ({
    mark,
    rate: friendText.length === 0 ? 0 : friendText.filter((message) => pattern.test(message.text ?? '')).length / friendText.length,
  }))

  // Phrase counting is the only quadratic-ish step, so a large archive is
  // sampled evenly (same step for both roles) instead of truncated: the ratios
  // survive sampling, and the counts are scaled back to the full archive.
  const phraseStep = Math.max(1, Math.ceil(Math.max(friendText.length, selfText.length) / PHRASE_SAMPLE_MAX))
  const phraseSample = (messages: readonly ChatMessage[]): ChatMessage[] =>
    phraseStep === 1 ? [...messages] : messages.filter((_, index) => index % phraseStep === 0)
  const friendSample = phraseSample(friendText)
  const selfSample = phraseSample(selfText)
  const friendPhrases = phraseCounts(friendSample)
  const selfPhrases = phraseCounts(selfSample)
  const phrases: Phrase[] = [...friendPhrases]
    .map(([token, sampledCount]) => {
      const friendRate = sampledCount / Math.max(1, friendSample.length)
      const selfRate = (selfPhrases.get(token) ?? 0) / Math.max(1, selfSample.length)
      return { token, count: sampledCount * phraseStep, friendRate, selfRate }
    })
    // A catchphrase is distinctive, not merely frequent: it must beat the
    // owner's own rate for the same phrase, otherwise it is shared vocabulary.
    .filter((phrase) => phrase.count >= 3 && phrase.friendRate >= 0.03 && phrase.friendRate > phrase.selfRate * 1.5)
    .sort((a, b) => b.friendRate - a.friendRate || b.token.length - a.token.length)
    .slice(0, 15)

  const runs: number[] = []
  let run = 0
  for (let index = 0; index < friend.length; index += 1) {
    const previous = index === 0 ? null : friend[index - 1]
    const gap = previous === null ? Number.POSITIVE_INFINITY : friend[index].ts - previous.ts
    if (gap <= BURST_GAP_MS) run += 1
    else {
      if (run > 0) runs.push(run)
      run = 1
    }
  }
  if (run > 0) runs.push(run)
  const runCounts = new Map<number, number>()
  for (const value of runs) runCounts.set(value, (runCounts.get(value) ?? 0) + 1)
  const bursts = {
    meanRun: mean(runs),
    distribution: [...runCounts]
      .sort((a, b) => a[0] - b[0])
      .slice(0, 6)
      .map(([value, count]) => ({ run: value, share: count / Math.max(1, runs.length) })),
  }

  const delays: number[] = []
  for (let index = 1; index < messages.length; index += 1) {
    const previous = messages[index - 1]
    const current = messages[index]
    if (previous.role !== 'self' || current.role !== 'friend') continue
    const delta = current.ts - previous.ts
    if (delta >= 0 && delta < 86_400_000) delays.push(delta / 1000)
  }
  delays.sort((a, b) => a - b)

  let selfStarts = 0
  let friendStarts = 0
  for (let index = 0; index < messages.length; index += 1) {
    if (index > 0 && messages[index].ts - messages[index - 1].ts <= SESSION_GAP_MS) continue
    if (messages[index].role === 'self') selfStarts += 1
    if (messages[index].role === 'friend') friendStarts += 1
  }
  const starts = Math.max(1, selfStarts + friendStarts)

  const hourHistogram = Array.from({ length: 24 }, () => 0)
  for (const message of friend) hourHistogram[new Date(message.ts).getHours()] += 1

  const questionRate = friendText.length === 0
    ? 0
    : friendText.filter((message) => /[?？]|(吗|呢|吧|么)[。.!！~～…]*$/.test(message.text ?? '')).length / friendText.length

  const kinds: Record<string, number> = {}
  for (const message of messages) kinds[message.kind] = (kinds[message.kind] ?? 0) + 1

  return {
    counts: {
      total: messages.length,
      self: self.length,
      friend: friend.length,
      other: messages.filter((message) => message.role === 'other').length,
    },
    length: {
      // One pasted document can double the mean while describing nothing about
      // how he talks, so the mean ignores thousand-character messages.
      mean: mean(lengths.filter((length) => length <= 1000)),
      median: percentile(lengths, 50),
      p90: percentile(lengths, 90),
      min: lengths[0] ?? 0,
      max: lengths[lengths.length - 1] ?? 0,
      shortRate: share(2),
      briefRate: share(8),
      longCount: lengths.filter((length) => length > 1000).length,
    },
    punctuation,
    emojiTop: top(emojiCounts(friendText), 12),
    phrases,
    bursts,
    replyDelay: {
      median: percentile(delays, 50),
      p90: percentile(delays, 90),
      mean: mean(delays),
    },
    initiator: { self: selfStarts / starts, friend: friendStarts / starts },
    hourHistogram,
    questionRate,
    mediaRate: friend.length === 0 ? 0 : (friend.length - friendText.length) / friend.length,
    kinds,
  }
}

/** Format a duration in seconds as a compact human string. */
function duration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} 秒`
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`
  return `${(seconds / 3600).toFixed(1)} 小时`
}

/** Percent formatter with one decimal only above 10%. */
function pct(value: number): string {
  const scaled = value * 100
  if (scaled === 0) return '0%'
  return `${scaled >= 10 ? Math.round(scaled) : scaled.toFixed(1)}%`
}

/** Describe the friend's busiest 3-hour window. */
function peakWindow(histogram: readonly number[]): string {
  let bestStart = 0
  let bestSum = -1
  for (let start = 0; start < 24; start += 1) {
    const sum = histogram[(start) % 24] + histogram[(start + 1) % 24] + histogram[(start + 2) % 24]
    if (sum > bestSum) {
      bestSum = sum
      bestStart = start
    }
  }
  return `${String(bestStart).padStart(2, '0')}:00–${String((bestStart + 3) % 24).padStart(2, '0')}:00`
}

/**
 * Render the fingerprint as Markdown, ready to paste into a persona file.
 * @param stats - output of {@link computeStats}.
 * @param names - display names for the owner and the friend.
 * @returns Markdown block.
 */
export function renderStyleBlock(stats: StyleStats, names: { self: string; friend: string }): string {
  const punctuation = stats.punctuation
    .filter((entry) => entry.rate >= 0.02)
    .sort((a, b) => b.rate - a.rate)
    .map((entry) => `${entry.mark}(${pct(entry.rate)})`)
    .join('、')
  // A question mark gets its own line below; leaving it in this list reads as
  // "he uses it a little" when the archive actually has none.
  const omitted = stats.punctuation.filter((entry) => entry.rate < 0.02 && entry.mark !== '？').map((entry) => entry.mark)
  const questionMark = stats.punctuation.find((entry) => entry.mark === '？')?.rate ?? 0

  const lines = [
    '## 风格指纹（自动统计，可直接引用）',
    '',
    `- 消息量：${names.self} ${stats.counts.self} 条 / ${names.friend} ${stats.counts.friend} 条`,
    `- 他平均每条 ${Math.round(stats.length.mean)} 字（中位 ${stats.length.median}，90 分位 ${stats.length.p90}）${stats.length.longCount > 0 ? `，另有 ${stats.length.longCount} 条千字长文不计` : ''}`,
    `- 长度分布：8 字以内占 ${pct(stats.length.briefRate)}，其中 ${pct(stats.length.shortRate)} 只有 1–2 字`,
    `- 连发习惯：平均 ${stats.bursts.meanRun.toFixed(1)} 条一组` +
      (stats.bursts.distribution.length > 0
        ? `，其中 ${stats.bursts.distribution.map((entry) => `${entry.run} 条占 ${pct(entry.share)}`).join('、')}`
        : ''),
    `- 回复延迟：中位 ${duration(stats.replyDelay.median)}，90 分位 ${duration(stats.replyDelay.p90)}`,
    `- 主动发起：他 ${pct(stats.initiator.friend)} / ${names.self} ${pct(stats.initiator.self)}`,
    `- 问句率：${pct(stats.questionRate)}（带问号，或句尾是 吗/呢/吧/么）`,
    `- 问号字符：${pct(questionMark)}${questionMark < 0.02 ? '（疑问靠语气词，不靠问号）' : ''}`,
    `- 图片表情等非文字消息占比：${pct(stats.mediaRate)}`,
  ]
  if (punctuation.length > 0) lines.push(`- 常用标点：${punctuation}${omitted.length > 0 ? `；几乎不用 ${omitted.join('')}` : ''}`)
  if (stats.emojiTop.length > 0) {
    lines.push(`- 高频表情：${stats.emojiTop.slice(0, 10).map((entry) => `${entry.token}(${entry.count})`).join('、')}`)
  }
  if (stats.phrases.length > 0) {
    lines.push(`- 口头禅（相对 ${names.self} 明显更常用）：${stats.phrases.slice(0, 10).map((entry) => `${entry.token}(${entry.count})`).join('、')}`)
  }
  lines.push(`- 活跃时段：${peakWindow(stats.hourHistogram)}`)
  // Two versions of the same persona are only comparable if the unit is
  // stated: these are shares of text messages, so a version built from a
  // bigger archive reads lower simply because it has more one-word messages.
  lines.push('- 以上比例都按「文字消息条数」算，不含图片、语音、文件、系统消息')
  return lines.join('\n')
}
