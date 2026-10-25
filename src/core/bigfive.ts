/**
 * Big Five personality assessment over a chat archive.
 *
 * `compare` measures shape — lengths, punctuation, emoji — and cannot see the
 * difference between "comforts a friend in trouble" and "changes the subject";
 * that difference is personality, and it is exactly what a persona either
 * carries or loses. This module scores the Big Five (OCEAN) the same way
 * `distill` reads habits: a fixed rubric prompt, one model call per chunk,
 * verbatim evidence that is then checked against the archive. The judge is a
 * model, but the rubric is versioned, the temperature is zero, and the scores
 * are aggregated and stored — so given the same archive the profile is stable,
 * and any distance computed from stored profiles is exact.
 */

import { complete, type LlmConfig, type WireMessage } from './llm.ts'
import { extractJson, type Completer } from './distill.ts'

/** Bump when the rubric wording changes; written into every stored profile. */
export const RUBRIC_VERSION = 2

/** The five dimensions, in a fixed order for tables and reports. */
export const DIMENSIONS = ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'neuroticism'] as const

/** One of the five Big Five dimensions. */
export type Dimension = (typeof DIMENSIONS)[number]

/** Chinese labels for reports and tables, keyed by dimension. */
export const DIMENSION_LABELS: Record<Dimension, string> = {
  openness: '开放性',
  conscientiousness: '尽责性',
  extraversion: '外向性',
  agreeableness: '宜人性',
  neuroticism: '神经质',
}

/** One chunk's (or batch's) assessment: scores plus verbatim evidence. */
export interface BigFiveObservation {
  /** Only dimensions the call actually produced; the rest are absent. */
  scores: Partial<Record<Dimension, number>>
  evidence: Partial<Record<Dimension, string[]>>
}

/** Mean and spread of one dimension across all assessed chunks. */
export interface DimensionStat {
  mean: number
  std: number
  /** Chunks that produced a valid score for this dimension. */
  n: number
}

/** Aggregated profile, everything a report or a distance needs. */
export interface BigFiveSummary {
  rubricVersion: number
  chunks: number
  failedChunks: number
  stats: Record<Dimension, DimensionStat>
  /** Verified evidence per dimension, most frequently seen first. */
  evidence: Record<Dimension, Array<{ text: string; count: number }>>
  /** Evidence quotes dropped because the archive does not contain them. */
  unverified: Record<Dimension, number>
}

/**
 * Rubric text shared by both modes (archive chunks and reply segments).
 *
 * v1 said "score 3 when you can't tell", and the judge read that as a default:
 * both people came out 2.7–3.1 on every dimension, and dennis — who opens
 * topics and fires off bursts constantly — scored extraversion 3.0 ±0.0. v2
 * makes the judge hunt for the diagnostic moments first and treats 3 as the
 * answer only when a segment truly holds nothing. Two guards stay from v1:
 * length/punctuation/emoji are morphology measured exactly by `stats.ts`, so
 * they must not be re-counted as personality, and one outburst is not a 5.
 */
const DIMENSION_DEFS = `维度定义（只看聊天里能观察到的）：
- openness 开放性：对新东西的反应——新话题、新玩法、没见过的梗，他是接住、好奇追问，还是敷衍（随便、行吧、不来）
- conscientiousness 尽责性：答应的事办不办、时间准不准、安排有没有谱
- extraversion 外向性：互动倾向——话题是谁开的、他主动找人说话还是只接话、连发多条、语气热度
- agreeableness 宜人性：对方诉苦、求助、起冲突时他怎么回——安慰、迁就、让步，还是讲自己的事、怼回去、不让步
- neuroticism 神经质：情绪起伏——急、烦、炸、焦虑外露，还是稳得住`

const SCORE_ANCHORS = `分数锚点：
- 1 = 明显且反复的反面行为
- 2 = 偏低，能看到倾向
- 3 = 这段材料里真的找不到相关行为
- 4 = 偏高，有倾向
- 5 = 明显且反复出现`

const HUNT_RULE = `打分方法：先把材料里最能看出性格的时刻找出来——对方诉苦时他安慰还是只讲自己的事、答应的事办没办、起冲突时让不让、话题是谁开的、他什么时候急或烦——分数从这些时刻来。大量的日常碎片（确认时间、发文件、催一下）不携带人格信息，不要让它们的数量把分数拉向中间。`

const GUARD_RULES = `- 不要从消息长短、标点、表情数量推断任何维度——那是说话习惯，不是人格。评分只看他怎么回应对方
- 1 分和 5 分需要反复出现的行为，一次不算；在这份材料里反复出现就算`

/** Mode A (assess): one whole archive chunk per call, evidence required. */
function rubricSystem(selfName: string, friendName: string): string {
  return `你在给一段真实聊天记录里的「${friendName}」做大五人格评估。记录里「${selfName}」是对方，「${friendName}」是被评的人。

${DIMENSION_DEFS}

${SCORE_ANCHORS}

${HUNT_RULE}一段正常对话通常至少有一两个维度能看出倾向，实在没有才给 3。

只输出一个 JSON 对象，不要 markdown 代码块，不要解释：
{"openness":{"score":1,"evidence":["他说的原话"]},"conscientiousness":{"score":1,"evidence":[]},"extraversion":{"score":1,"evidence":[]},"agreeableness":{"score":1,"evidence":[]},"neuroticism":{"score":1,"evidence":[]}}

要求：
- evidence 每维最多 3 条，必须逐字摘自「${friendName}」自己的消息，只摘一条消息里的连续片段，不要拼接、不要改写
- 原话里如有英文双引号，写进 JSON 时换成中文引号（核对时忽略标点差异）
- 看不出的维度 score 给 3，evidence 留空数组，不要硬凑
${GUARD_RULES}`
}

/** Mode B (compare): numbered reply segments per call, per-segment scores. */
function segmentRubricSystem(): string {
  return `你在评估「他」在每一段对话末尾的回复，据此给他做大五人格评分。每段里「对方」是和他聊天的人，最后一行「他回：」是他在这个情境下的回复。

${DIMENSION_DEFS}

${SCORE_ANCHORS}

${HUNT_RULE}一段回复常常只有一个字（行、去、嗯）——那一段给 3 是对的；回复有内容时，他怎么回应就是信号，按锚点打。

只输出一个 JSON 对象，不要 markdown 代码块，不要解释：
{"scores":[{"n":1,"openness":3,"conscientiousness":3,"extraversion":3,"agreeableness":3,"neuroticism":3}]}

要求：
- scores 数组必须给每一段的评分，n 是【第 n 段】的段号，从 1 开始一段不落
- 五个维度各是 1–5 的整数
- 只输出分数，不要摘证据
${GUARD_RULES}`
}

/**
 * Build one assessment call over an already-rendered transcript.
 * @param transcript - the text the judge reads; speakers labeled by the caller.
 * @param selfName - how the archive owner is labeled in the transcript.
 * @param friendName - how the assessed person is labeled in the transcript.
 * @returns the wire messages for one call.
 */
export function assessPrompt(transcript: string, selfName: string, friendName: string): WireMessage[] {
  return [
    { role: 'system', content: rubricSystem(selfName, friendName) },
    { role: 'user', content: transcript },
  ]
}

/**
 * Build one assessment call over numbered reply segments (see {@link renderReplyItems}).
 * @param transcript - the rendered segments, each numbered 【第 n 段】.
 * @param segmentCount - how many segments the transcript holds.
 * @returns the wire messages for one call.
 */
export function segmentPrompt(transcript: string, segmentCount: number): WireMessage[] {
  return [
    { role: 'system', content: segmentRubricSystem() },
    { role: 'user', content: `${transcript}\n\n共 ${segmentCount} 段，从第 1 段评到第 ${segmentCount} 段。` },
  ]
}

/**
 * Render reply items for the judge: each item shows the situation and the
 * reply being assessed.
 *
 * An isolated one-word reply carries no personality; the same reply after the
 * friend's complaint does. Compare generates replies against held-out
 * contexts, so the context is exactly the social situation the reply belongs
 * to, and the judge must see it.
 * @param items - context messages plus the reply under assessment.
 * @returns a transcript where `对方` is the archive owner and `他` the persona.
 */
export function renderReplyItems(items: ReadonlyArray<{ context: readonly WireMessage[]; reply: string }>): string {
  const blocks = items.map((item, index) => {
    const lines = item.context.map((wire) =>
      `${wire.role === 'user' ? '对方' : '他'}：${wire.content.length > 200 ? `${wire.content.slice(0, 200)}…` : wire.content}`)
    lines.push(`他回：${item.reply.length > 200 ? `${item.reply.slice(0, 200)}…` : item.reply}`)
    return `【第 ${index + 1} 段】\n${lines.join('\n')}`
  })
  const intro = items.some((item) => item.context.some((wire) => wire.role === 'assistant'))
    ? '下面每段是一段对话的末尾，「对方」是和他聊天的人，「他」是被评的人，每段最后一行「他回：」是他在这个情境下的回复。评估「他」。'
    : '下面每段是一段对话的末尾，「对方」是和他聊天的人，每段最后一行「他回：」是他在这个情境下的回复。评估「他」。'
  return `${intro}\n\n${blocks.join('\n\n')}`
}

/**
 * Coerce a parsed judge reply into an observation, dropping wrong-typed fields.
 * @param value - whatever `JSON.parse` produced.
 * @returns the scores and evidence that were actually usable.
 */
export function toBigFive(value: unknown): BigFiveObservation {
  const observation: BigFiveObservation = { scores: {}, evidence: {} }
  if (typeof value !== 'object' || value === null) return observation
  for (const dimension of DIMENSIONS) {
    const entry = (value as Record<string, unknown>)[dimension]
    if (typeof entry === 'number') {
      // A bare number per dimension is a legal shorthand some models fall into.
      const score = clampScore(entry)
      if (score !== undefined) observation.scores[dimension] = score
      continue
    }
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const score = clampScore(record.score)
    if (score !== undefined) observation.scores[dimension] = score
    const evidence = Array.isArray(record.evidence)
      ? record.evidence.filter((quote): quote is string => typeof quote === 'string' && quote.trim().length > 0)
      : []
    if (evidence.length > 0) observation.evidence[dimension] = evidence
  }
  return observation
}

/** Accept a score in [1, 5]; round, clamp, and reject what is not a number. */
function clampScore(value: unknown): number | undefined {
  const score = typeof value === 'string' ? Number(value) : value
  if (typeof score !== 'number' || !Number.isFinite(score)) return undefined
  return Math.min(5, Math.max(1, Math.round(score)))
}

/**
 * Parse a per-segment judge reply into one observation per segment.
 *
 * Each entry anchors itself with `n` (the segment number printed in the
 * transcript), so a dropped entry cannot silently shift the ones after it.
 * Anything less than every segment scored is a malformed reply: the caller
 * retries rather than averaging over an unaligned subset.
 * @param value - whatever `JSON.parse` produced.
 * @param expectedSegments - how many segments the call was given.
 * @returns one observation per segment, in segment order.
 */
export function toBigFiveBatch(value: unknown, expectedSegments: number): BigFiveObservation[] {
  const observations: BigFiveObservation[] = Array.from({ length: expectedSegments }, () => ({ scores: {}, evidence: {} }))
  let scored = 0
  if (typeof value === 'object' && value !== null && Array.isArray((value as Record<string, unknown>).scores)) {
    for (const item of (value as Record<string, unknown>).scores as unknown[]) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      const n = Math.round(Number(record.n))
      if (!Number.isInteger(n) || n < 1 || n > expectedSegments) continue
      const observation = observations[n - 1]
      let any = false
      for (const dimension of DIMENSIONS) {
        const score = clampScore(record[dimension])
        if (score !== undefined) {
          observation.scores[dimension] = score
          any = true
        }
      }
      if (any) scored += 1
    }
  }
  if (scored < expectedSegments) throw new Error(`段评分不完整：${scored}/${expectedSegments}`)
  return observations
}

/** Normalize a quote for matching: whitespace and punctuation are not the signal. */
function normalizeQuote(text: string): string {
  return text.replace(/[\s。，、！？：；""''「」『』《》…—～·.,!?:;"'()\-]/g, '')
}

/**
 * Drop evidence quotes the archive does not contain.
 *
 * The judge invents or paraphrases quotes at about the rate `distill` taught
 * us to expect; a personality score standing on a quote the person never said
 * must not be shown as proof. Quotes too short to check are kept — dropping on
 * uncertainty would throw away real two-word tics.
 * @param observation - one assessment's evidence.
 * @param texts - every message the assessed person sent in the archive.
 * @returns the observation with unverifiable quotes removed.
 */
export function verifyBigFiveEvidence(observation: BigFiveObservation, texts: readonly string[]): BigFiveObservation {
  const haystack = texts.map((text) => normalizeQuote(text))
  const verified: BigFiveObservation = { scores: observation.scores, evidence: {} }
  for (const dimension of DIMENSIONS) {
    const quotes = observation.evidence[dimension]
    if (quotes === undefined) continue
    const kept = quotes.filter((quote) => {
      const needle = normalizeQuote(quote)
      if (needle.length < 4) return true
      return haystack.some((text) => text.includes(needle))
    })
    if (kept.length > 0) verified.evidence[dimension] = kept
  }
  return verified
}

/** Count evidence quotes removed by verification, per dimension. */
export function countUnverified(before: BigFiveObservation, after: BigFiveObservation): Record<Dimension, number> {
  const counts = {} as Record<Dimension, number>
  for (const dimension of DIMENSIONS) {
    const a = before.evidence[dimension]?.length ?? 0
    const b = after.evidence[dimension]?.length ?? 0
    counts[dimension] = a - b
  }
  return counts
}

/** Sum dropped-quote counts across chunks, keyed by dimension. */
export function sumUnverified(parts: readonly Record<Dimension, number>[]): Record<Dimension, number> {
  const total = {} as Record<Dimension, number>
  for (const dimension of DIMENSIONS) total[dimension] = parts.reduce((sum, part) => sum + part[dimension], 0)
  return total
}

/** Population standard deviation, or 0 for fewer than two samples. */
function stdOf(values: readonly number[], mean: number): number {
  if (values.length < 2) return 0
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

/**
 * Aggregate chunk-level observations into one profile.
 * @param observations - one per successfully assessed chunk, evidence already verified.
 * @param unverified - dropped-quote counts per dimension, summed across chunks.
 * @param failedChunks - chunks whose calls failed; reported, not hidden.
 * @returns the summary written to `bigfive.json` and rendered to `bigfive.md`.
 */
export function aggregateBigFive(
  observations: readonly BigFiveObservation[],
  unverified: Record<Dimension, number>,
  failedChunks: number,
): BigFiveSummary {
  const stats = {} as Record<Dimension, DimensionStat>
  const evidence = {} as Record<Dimension, Array<{ text: string; count: number }>>
  for (const dimension of DIMENSIONS) {
    const values = observations
      .map((observation) => observation.scores[dimension])
      .filter((score): score is number => score !== undefined)
    const mean = values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
    stats[dimension] = { mean, std: stdOf(values, mean), n: values.length }

    // Dedup by normalized quote, keep the first spelling, count chunks citing it.
    const seen = new Map<string, { text: string; count: number }>()
    for (const observation of observations) {
      const cited = new Set<string>()
      for (const quote of observation.evidence[dimension] ?? []) {
        const key = normalizeQuote(quote)
        if (key.length === 0 || cited.has(key)) continue
        cited.add(key)
        const existing = seen.get(key)
        if (existing === undefined) seen.set(key, { text: quote, count: 1 })
        else existing.count += 1
      }
    }
    evidence[dimension] = [...seen.values()].sort((a, b) => b.count - a.count).slice(0, 10)
  }
  return {
    rubricVersion: RUBRIC_VERSION,
    chunks: observations.length,
    failedChunks,
    stats,
    evidence,
    unverified,
  }
}

/** Mean absolute Big Five gap between two profiles, normalized to 0–1. */
export function personalityDistance(
  candidate: Partial<Record<Dimension, number>>,
  reference: Partial<Record<Dimension, number>>,
): number {
  const gaps = DIMENSIONS
    .filter((dimension) => candidate[dimension] !== undefined && reference[dimension] !== undefined)
    .map((dimension) => Math.abs((candidate[dimension] as number) - (reference[dimension] as number)) / 4)
  if (gaps.length === 0) return 1
  return gaps.reduce((sum, value) => sum + value, 0) / gaps.length
}

/** Mean scores as a plain map, for `personalityDistance` and tables. */
export function meanScores(summary: BigFiveSummary): Partial<Record<Dimension, number>> {
  const scores: Partial<Record<Dimension, number>> = {}
  for (const dimension of DIMENSIONS) {
    const stat = summary.stats[dimension]
    if (stat.n > 0) scores[dimension] = stat.mean
  }
  return scores
}

/** How a tiered score reads, so the report says what the number means. */
const TIER_READINGS: Record<Dimension, [string, string, string]> = {
  // [high, mid, low] readings; tiers at >=3.5 / >2.5 / <=2.5.
  openness: ['爱琢磨新东西，接得住没见过的梗', '对新东西的反应看场合', '话题固定，对新东西多敷衍'],
  conscientiousness: ['答应的事上心，安排有谱', '该办的办，偶有走神', '随口答应，转头就忘'],
  extraversion: ['主动开话题，语气热度高', '有人聊就接，不主动找', '话少被动，人来了才接'],
  agreeableness: ['顺着对方，安慰、迁就', '平时随和，立场不让', '有话直说，不顺从、不安慰'],
  neuroticism: ['情绪起伏外露，急了会说', '平时稳，偶尔烦', '基本不炸，稳得住'],
}

/**
 * Render the human-readable report.
 * @param name - the assessed person's display name.
 * @param summary - aggregated profile with verified evidence.
 * @param corpus - one-line description of where the messages came from.
 * @returns markdown for `personas/<name>/bigfive.md`.
 */
export function renderBigFiveReport(name: string, summary: BigFiveSummary, corpus: string): string {
  const lines: string[] = []
  lines.push(`# 大五人格 · ${name}`, '')
  lines.push('> 这是**聊天记录里的他**，不是全面人格测评。分数只依据这段记录里他说的话、怎么回应对方。', '')
  lines.push(`- 语料：${corpus}（成功 ${summary.chunks} 块 / 失败 ${summary.failedChunks}）`)
  lines.push(`- 量表版本 ${summary.rubricVersion} · 温度 0`)
  lines.push('')
  lines.push('| 维度 | 分数 | 波动 | 读作 |')
  lines.push('|---|---|---|---|')
  for (const dimension of DIMENSIONS) {
    const stat = summary.stats[dimension]
    const score = stat.n > 0 ? stat.mean.toFixed(1) : '—'
    const spread = stat.n > 1 ? `±${stat.std.toFixed(1)}` : '—'
    const readings = TIER_READINGS[dimension]
    const reading = stat.n === 0 ? '这一维没有可靠分数' : stat.mean >= 3.5 ? readings[0] : stat.mean > 2.5 ? readings[1] : readings[2]
    lines.push(`| ${DIMENSION_LABELS[dimension]} | ${score} | ${spread} | ${reading} |`)
  }
  lines.push('')
  const dropped = DIMENSIONS.reduce((sum, dimension) => sum + summary.unverified[dimension], 0)
  const shown = DIMENSIONS.some((dimension) => (summary.evidence[dimension]?.length ?? 0) > 0)
  if (shown) {
    lines.push('## 证据（逐字摘录，已在记录里核到）', '')
    for (const dimension of DIMENSIONS) {
      const entries = summary.evidence[dimension]
      if (entries === undefined || entries.length === 0) continue
      const stat = summary.stats[dimension]
      lines.push(`### ${DIMENSION_LABELS[dimension]}${stat.n > 0 ? `（${stat.mean.toFixed(1)}）` : ''}`)
      lines.push('')
      for (const entry of entries.slice(0, 5)) {
        lines.push(`- 「${entry.text}」${entry.count > 1 ? `（${entry.count} 块提到）` : ''}`)
      }
      lines.push('')
    }
  }
  if (dropped > 0) lines.push(`另有 ${dropped} 条证据没能在记录里找到原话，已剔除。`, '')
  lines.push('复跑同一份记录，分数应落在上表「波动」范围内；超出说明信号不稳，别当成结论用。')
  return `${lines.join('\n')}\n`
}

/** One model call per transcript, one retry when the reply will not parse. */
async function runWithRetry<T>(
  config: LlmConfig,
  transcripts: readonly string[],
  call: (send: Completer, transcript: string, index: number) => Promise<T>,
  options: { onProgress?: (message: string) => void; complete?: Completer } = {},
): Promise<{ results: T[]; failed: number }> {
  const results: T[] = []
  let failed = 0
  for (let index = 0; index < transcripts.length; index += 1) {
    options.onProgress?.(`评估第 ${index + 1}/${transcripts.length} 段... `)
    // Malformed JSON or an incomplete batch is worth one retry; a fallback
    // parse would guess at data.
    let done = false
    for (let attempt = 0; attempt < 2 && !done; attempt += 1) {
      try {
        results.push(await call(options.complete ?? complete, transcripts[index], index))
        done = true
        options.onProgress?.(attempt > 0 ? 'ok（重试成功）\n' : 'ok\n')
      } catch (error) {
        if (attempt === 0) {
          options.onProgress?.('JSON 有问题，重试... ')
        } else {
          failed += 1
          options.onProgress?.(`失败：${error instanceof Error ? error.message : String(error)}\n`)
        }
      }
    }
  }
  return { results, failed }
}

/**
 * Run the judge over whole-archive chunks (mode A: evidence included).
 * @param config - endpoint settings; the caller pins temperature to 0.
 * @param transcripts - one rendered transcript per chunk.
 * @param selfName - how the archive owner is labeled.
 * @param friendName - how the assessed person is labeled.
 * @param options - progress reporting and an injectable call for tests.
 * @returns the observations plus how many chunks failed after retries.
 */
export async function assessTranscripts(
  config: LlmConfig,
  transcripts: readonly string[],
  selfName: string,
  friendName: string,
  options: { onProgress?: (message: string) => void; complete?: Completer } = {},
): Promise<{ observations: BigFiveObservation[]; failed: number }> {
  const { results, failed } = await runWithRetry(
    config,
    transcripts,
    async (send, transcript) => toBigFive(extractJson(await send(config, assessPrompt(transcript, selfName, friendName)))),
    options,
  )
  return { observations: results, failed }
}

/**
 * Run the judge over numbered reply segments (mode B: per-segment scores,
 * no evidence). Compare uses this so a 50-item run aggregates 50 samples per
 * side instead of one integer per 20-item batch.
 * @param config - endpoint settings; the caller pins temperature to 0.
 * @param transcripts - one rendered multi-segment transcript per batch.
 * @param expectedSegments - how many segments each transcript holds, aligned by index.
 * @param options - progress reporting and an injectable call for tests.
 * @returns observations flattened across batches, plus failed batch count.
 */
export async function assessSegments(
  config: LlmConfig,
  transcripts: readonly string[],
  expectedSegments: readonly number[],
  options: { onProgress?: (message: string) => void; complete?: Completer } = {},
): Promise<{ observations: BigFiveObservation[]; failed: number }> {
  const { results, failed } = await runWithRetry(
    config,
    transcripts,
    async (send, transcript, index) =>
      toBigFiveBatch(extractJson(await send(config, segmentPrompt(transcript, expectedSegments[index]))), expectedSegments[index]),
    options,
  )
  return { observations: results.flat(), failed }
}
