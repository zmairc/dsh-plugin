/**
 * `compare`: which persona is shaped more like the real messages?
 *
 * Both personas answer the same held-out contexts, and the result is compared
 * with the replies that really happened. Nothing is rated by a human, so the
 * sample can be large — a hundred replies per side instead of twenty quiz
 * items — which makes it the cheap first half of "is the new version better?".
 */

import { complete, LlmError, llmConfigFromEnv } from '../core/llm.ts'
import { buildSystemPrompt, loadPersona } from '../core/persona.ts'
import { dataPath, readJsonl } from '../core/archive.ts'
import { buildPredictions, findLeaked, selectSpread } from '../core/evalkit.ts'
import { distance, profileMorphology, type Morphology } from '../core/compare.ts'
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
  const generated: string[][] = sides.map(() => [])
  let failures = 0

  for (const [offset, prediction] of selected.entries()) {
    for (const [sideIndex, side] of sides.entries()) {
      process.stdout.write(`第 ${offset + 1}/${selected.length} 题 · ${side.name} ... `)
      try {
        const text = await complete(compareConfig, [{ role: 'system', content: side.system }, ...prediction.context])
        generated[sideIndex].push(text)
        console.log('ok')
      } catch (error) {
        failures += 1
        console.log('失败')
        console.error(`  ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  if (generated.every((texts) => texts.length === 0)) throw new Error('两个版本都没生成出内容，检查接口配置后重试。')

  const truth = profileMorphology(selected.map((prediction) => prediction.truth))
  const profiles = sides.map((side, index) => ({ name: side.name, profile: profileMorphology(generated[index]) }))
  const percent = (value: number): string => `${(value * 100).toFixed(1)}%`

  console.log(`\n\n留出集：data/${holdoutName}.holdout.jsonl（${holdout.length} 条）`)
  console.log(`每题两版各一条，成功 ${selected.length - failures}/${selected.length * sides.length} 次调用\n`)
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
  console.log('\n与真实分布的距离（越小越像）')
  for (const entry of scored) console.log(`  ${pad(entry.name, 24)}${entry.distance.toFixed(3)}`)

  const [winner, runnerUp] = scored
  if (runnerUp === undefined) return
  const gap = runnerUp.distance - winner.distance
  console.log(`\n结论：${winner.name} 更接近真实分布（差距 ${gap.toFixed(3)}）。`)
  console.log('这只是「形状像」，不说明接得上上下文——那一半要靠 duel 里你亲自读。')
}