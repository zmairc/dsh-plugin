/**
 * `compare`: which persona is shaped more like the real messages?
 *
 * Both personas answer the same held-out contexts, and the result is compared
 * with the replies that really happened. Nothing is rated by a human, so the
 * sample can be large — a hundred replies per side instead of twenty quiz
 * items — which makes it the cheap first half of "is the new version better?".
 */

import { complete, llmConfigFromEnv, LlmError, type WireMessage } from '../core/llm.ts'
import { buildSystemPrompt, loadPersona } from '../core/persona.ts'
import { dataPath, readJsonl } from '../core/archive.ts'
import { buildPredictions, findLeaked, selectSpread } from '../core/evalkit.ts'
import { distance, profileMorphology } from '../core/compare.ts'
import {
  aggregateBigFive,
  assessSegments,
  DIMENSIONS,
  DIMENSION_LABELS,
  meanScores,
  personalityDistance,
  renderReplyItems,
  sumUnverified,
  type BigFiveSummary,
  type Dimension,
} from '../core/bigfive.ts'
import type { ChatMessage } from '../core/types.ts'
import { numberFlag, stringFlag, type Flags } from './args.ts'

/** Display width, so a Chinese label and an ASCII label line up. */
function width(text: string): number {
  let total = 0
  for (const character of text) total += /[\u4e00-\u9fff\uff00-\uffef]/.test(character) ? 2 : 1
  return total
}

/** Right-pad to a display width. */
function pad(text: string, size: number): string {
  return text + ' '.repeat(Math.max(1, size - width(text)))
}

/** Format one row of the comparison table. */
function row(label: string, cells: readonly string[]): string {
  return [pad(label, 20), ...cells.map((cell) => pad(cell, 12))].join('')
}

/**
 * Run the compare command.
 * @param flags - parsed CLI flags for this command.
 */
export async function runCompare(flags: Flags): Promise<void> {
  const base = stringFlag(flags, 'base')
  const challenger = stringFlag(flags, 'challenger')
  if (base === undefined || challenger === undefined) {
    throw new Error('用法：compare --base <新版本> --challenger <旧版本> [--n 100] [--holdout <名字>]')
  }

  const holdoutName = stringFlag(flags, 'holdout') ?? base
  const holdout = readJsonl<ChatMessage>(dataPath(`${holdoutName}.holdout.jsonl`))
  if (holdout.length === 0) {
    throw new Error(`data/${holdoutName}.holdout.jsonl 是空的。用 --holdout 指定一个有留出集的人设。`)
  }

  const config = llmConfigFromEnv()
  if (config.apiKey.length === 0) {
    throw new LlmError('缺少 API key：设置 PERSONAFORGE_API_KEY 或 DEEPSEEK_API_KEY')
  }

  const sides = [base, challenger].map((name) => {
    const persona = loadPersona(name)
    return { name, system: buildSystemPrompt(persona, { disclose: false }) }
  })

  const predictions = buildPredictions(holdout, 500)
  if (predictions.length === 0) throw new Error('没有构造出任何用例，留出集太小。')

  // An item must be new to BOTH prompts, or one side is scored on reciting a
  // line its own body already quotes.
  const leaked = new Set(findLeaked(predictions, sides.map((side) => side.system)))
  const usable = predictions.filter((_, index) => !leaked.has(index))
  if (leaked.size > 0) console.log(`剔除 ${leaked.size} 道泄漏题（两版 persona 里出现过的原话都算）。`)

  const requested = numberFlag(flags, 'n', 100)
  const selected = selectSpread(usable, requested)
  if (selected.length === 0) throw new Error('凑不出互不重叠的题，留出集太小。')
  if (selected.length < requested) console.log(`只能选出 ${selected.length} 道互不重叠的题，本次每边 ${selected.length} 条。`)

  const compareConfig = { ...config, temperature: Number(process.env.PERSONAFORGE_EVAL_TEMPERATURE ?? '0.7') }
  // Index-aligned replies: a failed call leaves null, and every reply stays
  // attached to its prediction for the personality pass below.
  const replies: Array<Array<string | null>> = sides.map(() => selected.map(() => null))
  let failures = 0

  for (const [offset, prediction] of selected.entries()) {
    for (const [sideIndex, side] of sides.entries()) {
      process.stdout.write(`第 ${offset + 1}/${selected.length} 题 · ${side.name} ... `)
      try {
        const text = await complete(compareConfig, [{ role: 'system', content: side.system }, ...prediction.context])
        replies[sideIndex][offset] = text
        console.log('ok')
      } catch (error) {
        failures += 1
        console.log('失败')
        console.error(`  ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  if (replies.every((list) => list.every((text) => text === null))) {
    throw new Error('两个版本都没生成出内容，检查接口配置后重试。')
  }

  const sideTexts = (sideIndex: number): string[] =>
    replies[sideIndex].filter((text): text is string => text !== null)
  const truth = profileMorphology(selected.map((prediction) => prediction.truth))
  const profiles = sides.map((side, index) => ({ name: side.name, profile: profileMorphology(sideTexts(index)) }))
  const percent = (value: number): string => `${(value * 100).toFixed(1)}%`

  console.log(`\n\n留出集：data/${holdoutName}.holdout.jsonl（${holdout.length} 条）`)
  const attempts = selected.length * sides.length
  console.log(`每题两版各一条：${attempts - failures}/${attempts} 次调用成功（${selected.length} 题）`)
  if (truth.dropped > 0) console.log(`真实样本剔除 ${truth.dropped} 条千字长文（生成的回复不会那么长，留在里面会让两边都显得太短）`)
  console.log(row('指标', ['真实', ...profiles.map((entry) => entry.name)]))
  console.log(row('样本', [String(truth.count), ...profiles.map((entry) => String(entry.profile.count))]))
  console.log(row('平均长度（字）', [truth.meanLength.toFixed(1), ...profiles.map((entry) => entry.profile.meanLength.toFixed(1))]))
  console.log(row('中位长度', [String(truth.medianLength), ...profiles.map((entry) => String(entry.profile.medianLength))]))
  console.log(row('1–2 字占比', [percent(truth.shortRate), ...profiles.map((entry) => percent(entry.profile.shortRate))]))
  console.log(row('8 字以内', [percent(truth.briefRate), ...profiles.map((entry) => percent(entry.profile.briefRate))]))
  console.log(row('含问号', [percent(truth.questionRate), ...profiles.map((entry) => percent(entry.profile.questionRate))]))
  console.log(row('含逗号', [percent(truth.commaRate), ...profiles.map((entry) => percent(entry.profile.commaRate))]))
  console.log(row('含句号', [percent(truth.periodRate), ...profiles.map((entry) => percent(entry.profile.periodRate))]))
  console.log(row('含感叹号', [percent(truth.exclamationRate), ...profiles.map((entry) => percent(entry.profile.exclamationRate))]))
  console.log(row('含表情', [percent(truth.emojiRate), ...profiles.map((entry) => percent(entry.profile.emojiRate))]))

  const scored = profiles.map((entry) => ({ name: entry.name, distance: distance(entry.profile, truth) }))
  scored.sort((a, b) => a.distance - b.distance)

  // Personality pass: the same Big Five rubric over (context, reply) pairs.
  // An isolated one-word reply carries no personality; the same word after the
  // friend's complaint does, so the judge sees every reply in its situation.
  // v1 scored one integer per 20-reply batch, so each side aggregated three
  // integers and the distance differed by exactly one batch — noise. v2 scores
  // every segment separately: same call cost, N samples per side instead of
  // three. The judge must be deterministic; reproducibility is the point.
  const assessConfig = { ...config, temperature: 0 }
  const assessBatchSize = 20
  let assessCalls = 0
  const assessSide = async (
    label: string,
    items: ReadonlyArray<{ context: readonly WireMessage[]; reply: string }>,
  ): Promise<BigFiveSummary | null> => {
    if (items.length === 0) return null
    const batches: Array<typeof items> = []
    for (let index = 0; index < items.length; index += assessBatchSize) batches.push(items.slice(index, index + assessBatchSize))
    const transcripts = batches.map((batch) => renderReplyItems(batch))
    assessCalls += transcripts.length
    process.stdout.write(`\n人格评估（${label}，${items.length} 段 / ${transcripts.length} 批，逐段打分，温度 0）... `)
    const { observations, failed } = await assessSegments(assessConfig, transcripts, batches.map((batch) => batch.length), {})
    if (observations.length === 0) {
      console.log(`失败（${failed} 批都没解析出结果）`)
      return null
    }
    console.log(`ok（${observations.length} 段评分${failed > 0 ? `，${failed} 批失败` : ''}）`)
    return aggregateBigFive(observations, sumUnverified([]), failed)
  }

  const truthBigFive = await assessSide(
    '真实',
    selected.map((prediction) => ({ context: prediction.context, reply: prediction.truth })),
  )
  const sideBigFive: Array<BigFiveSummary | null> = []
  for (const [sideIndex, side] of sides.entries()) {
    const items = selected
      .map((prediction, offset) => ({ context: prediction.context, reply: replies[sideIndex][offset] }))
      .filter((item): item is { context: readonly WireMessage[]; reply: string } => item.reply !== null)
    sideBigFive.push(await assessSide(side.name, items))
  }

  if (truthBigFive !== null) {
    const cell = (summary: BigFiveSummary | null, dimension: Dimension): string => {
      const stat = summary?.stats[dimension]
      return stat !== undefined && stat.n > 0 ? stat.mean.toFixed(1) : '—'
    }
    console.log(`\n\n大五人格（1–5 分，另花 ${assessCalls} 次温度 0 调用）`)
    console.log(row('维度', ['真实', ...sides.map((side) => side.name)]))
    for (const dimension of DIMENSIONS) {
      console.log(row(DIMENSION_LABELS[dimension], [
        cell(truthBigFive, dimension),
        ...sideBigFive.map((summary) => cell(summary, dimension)),
      ]))
    }
  } else {
    console.log('\n真实侧的人格评估全失败，本轮只有统计距离。')
  }

  console.log('\n与真实的距离（越小越像）')
  for (const entry of scored) console.log(`  ${pad(`统计 · ${entry.name}`, 24)}${entry.distance.toFixed(3)}`)
  const personalityScored =
    truthBigFive === null
      ? []
      : sides
        .map((side, index) => ({
          name: side.name,
          distance: sideBigFive[index] === null ? undefined : personalityDistance(meanScores(sideBigFive[index] as BigFiveSummary), meanScores(truthBigFive)),
        }))
        .filter((entry): entry is { name: string; distance: number } => entry.distance !== undefined)
  for (const entry of personalityScored) console.log(`  ${pad(`人格 · ${entry.name}`, 24)}${entry.distance.toFixed(3)}`)

  const [winner, runnerUp] = scored
  if (runnerUp === undefined) return
  const personalityWinner = personalityScored.length === 2
    ? personalityScored.reduce((best, entry) => (entry.distance < best.distance ? entry : best))
    : undefined
  if (personalityWinner === undefined) {
    console.log(`\n结论：${winner.name} 更接近真实分布（统计距离 ${winner.distance.toFixed(3)}；人格距离本轮没测成）。`)
  } else if (personalityWinner.name === winner.name) {
    const other = personalityScored.find((entry) => entry.name !== personalityWinner.name) as { name: string; distance: number }
    console.log(
      `\n结论：${winner.name} 两项都更近——统计距离 ${winner.distance.toFixed(3)} vs ${runnerUp.distance.toFixed(3)}，` +
        `人格距离 ${personalityWinner.distance.toFixed(3)} vs ${other.distance.toFixed(3)}。`,
    )
  } else {
    console.log(
      `\n结论：两项指标指向不同版本——形状上 ${winner.name} 更像（${winner.distance.toFixed(3)} vs ${runnerUp.distance.toFixed(3)}），` +
        `人格上 ${personalityWinner.name} 更像。分歧本身就是结果：一个长得像，一个性格像。`,
    )
  }
  console.log('距离只说明「像」，不说明接得上上下文——那一半要靠 duel 里你亲自读。')
}