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
export const RUBRIC_VERSION = 1

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
 * The rubric: dimension anchors a judge can actually see in chat, score
 * anchors so a lazy judge cannot park everything at 3, and the two biases the
 * project has already paid for elsewhere.
 *
 * Message length, punctuation, and emoji are morphology — measured exactly by
 * `stats.ts` — so inferring personality from them would count the same signal
 * twice and dress it up as a new one. And one outburst is not a 5: extreme
 * scores must recur.
 */
function rubricSystem(selfName: string, friendName: string): string {
  return `你在给一段真实聊天记录里的「${friendName}」做大五人格评估。记录里「${selfName}」是对方，「${friendName}」是被评的人。

只依据这段记录里「${friendName}」自己说的话和回应方式，给五个维度各打 1–5 分。

维度定义（只看聊天里能观察到的）：
- openness 开放性：对新东西的反应——新话题、新玩法、没见过的梗，他是接住、好奇追问，还是敷衍（随便、行吧、不来）
- conscientiousness 尽责性：答应的事办不办、时间准不准、安排有没有谱
- extraversion 外向性：互动倾向——话题是谁开的、他主动找人说话还是只接话、语气热度
- agreeableness 宜人性：对方诉苦、求助、起冲突时他怎么回——安慰、迁就、让步，还是讲自己的事、怼回去、不让步
- neuroticism 神经质：情绪起伏——急、烦、炸、焦虑外露，还是稳得住

分数锚点：
- 1 = 记录里有明显且反复的反面行为
- 2 = 偏低，能看到倾向但不重
- 3 = 看不出，或两边的证据差不多
- 4 = 偏高，有倾向
- 5 = 明显且反复出现

只输出一个 JSON 对象，不要 markdown 代码块，不要解释：
{"openness":{"score":1,"evidence":["他说的原话"]},"conscientiousness":{"score":1,"evidence":[]},"extraversion":{"score":1,"evidence":[]},"agreeableness":{"score":1,"evidence":[]},"neuroticism":{"score":1,"evidence":[]}}

要求：
- evidence 每维最多 3 条，必须逐字摘自「${friendName}」自己的消息，只摘一条消息里的连续片段，不要拼接、不要改写
- 看不出的维度 score 给 3，evidence 留空数组，不要硬凑
- 不要从消息长短、标点、表情数量推断任何维度——那是说话习惯，不是人格。评分只看他怎么回应对方
- 1 分和 5 分都需要反复出现的证据，一句不算`
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

/**
 * Run the judge over every transcript and collect observations.
 * @param config - endpoint settings; the caller pins temperature to 0.
 * @param transcripts - one rendered transcript per chunk or batch.
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
  const call = options.complete ?? complete
  const observations: BigFiveObservation[] = []
  let failed = 0
  for (let index = 0; index < transcripts.length; index += 1) {
    options.onProgress?.(`评估第 ${index + 1}/${transcripts.length} 段... `)
    // Malformed JSON is worth one retry; a fallback parse would guess at data.
    let parsed = false
    for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
      try {
        const reply = await call(config, assessPrompt(transcripts[index], selfName, friendName))
        observations.push(toBigFive(extractJson(reply)))
        parsed = true
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
  return { observations, failed }
}
