/**
 * `eval`: a blind quiz built from the held-out slice.
 *
 * The held-out messages never reach the persona files, so the only way the
 * system can produce them is by actually being right. Twenty replies are shown
 * in random order, half real and half generated, and the reader marks the ones
 * that look made up.
 *
 * Two things that quietly invalidated earlier runs, both handled here:
 *   - a hand-written persona quotes real lines, so some "test" answers are
 *     literally in the system prompt (see `findLeaked`);
 *   - consecutive predictions overlap each other's context, so one answer shows
 *     up in the next question (see `selectSpread`).
 */

import { complete, LlmError, llmConfigFromEnv, type WireMessage } from '../core/llm.ts'
import { buildSystemPrompt, loadPersona } from '../core/persona.ts'
import { dataPath, readJsonl, readText, writeText } from '../core/archive.ts'
import type { ChatMessage } from '../core/types.ts'
import { numberFlag, stringFlag, type Flags } from './args.ts'

/** How many preceding messages form the context for one prediction. */
const CONTEXT_WINDOW = 8
/** How much of the context the quiz shows; the model still gets the full window. */
const QUIZ_CONTEXT = 2

/** One prediction task: the conversation so far, and the reply that actually happened. */
export interface Prediction {
  context: WireMessage[]
  truth: string
  /** Position in the holdout, used to keep quiz items from overlapping. */
  index: number
}

/** One item in the blind quiz: a reply, what led to it, and whether it is real. */
export interface QuizItem {
  /** Pairs the real reply with the generated one made from the same context. */
  pair: number
  context: WireMessage[]
  text: string
  real: boolean
}

/**
 * Turn a held-out slice into prediction tasks: each one ends where the friend
 * was about to speak, so the real reply is a genuine next turn.
 * @param holdout - held-out messages, sorted by time.
 * @param limit - maximum number of tasks to produce.
 * @returns the constructed tasks.
 */
export function buildPredictions(holdout: readonly ChatMessage[], limit: number): Prediction[] {
  const predictions: Prediction[] = []
  for (let index = 1; index < holdout.length && predictions.length < limit; index += 1) {
    const message = holdout[index]
    if (message.role !== 'friend' || message.kind !== 'text' || (message.text ?? '').length === 0) continue
    if (holdout[index - 1].role !== 'self') continue

    const context: WireMessage[] = []
    for (const previous of holdout.slice(Math.max(0, index - CONTEXT_WINDOW), index)) {
      const wire = toWire(previous)
      if (wire !== null) context.push(wire)
    }
    if (context.length === 0) continue
    predictions.push({ context, truth: message.text as string, index })
  }
  return predictions
}

/**
 * Pick predictions far enough apart that one item's answer is not another
 * item's context. Spacing shrinks only when the slice cannot supply enough
 * items otherwise.
 * @param predictions - candidate tasks, in time order.
 * @param count - desired number of items.
 * @returns the selected tasks, possibly fewer than requested.
 */
export function selectSpread(predictions: readonly Prediction[], count: number): Prediction[] {
  let best: Prediction[] = []
  for (const gap of [5, 4, 3, 2]) {
    const picked: Prediction[] = []
    let last = Number.NEGATIVE_INFINITY
    for (const prediction of predictions) {
      if (prediction.index - last < gap) continue
      picked.push(prediction)
      last = prediction.index
      if (picked.length === count) return picked
    }
    // The slice may be too short for the requested count; keep the widest set.
    if (picked.length > best.length) best = picked
  }
  return best
}

/** Map an archived message to a wire message, or null when it cannot be used. */
function toWire(message: ChatMessage): WireMessage | null {
  if (message.kind !== 'text' || (message.text ?? '').length === 0) return null
  if (message.role === 'self') return { role: 'user', content: message.text as string }
  if (message.role === 'friend') return { role: 'assistant', content: message.text as string }
  return null
}

/** Fisher-Yates shuffle, so real and generated replies are mixed. */
function shuffle<T>(items: T[]): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1))
    const temporary = items[index]
    items[index] = items[swap]
    items[swap] = temporary
  }
  return items
}

/** Whether two strings agree on the presence of a question mark. */
function sameQuestion(a: string, b: string): boolean {
  return /[?？]/.test(a) === /[?？]/.test(b)
}

/** Whether two strings agree on the presence of an emoji. */
function sameEmoji(a: string, b: string): boolean {
  const pattern = /\p{Extended_Pictographic}/u
  return pattern.test(a) === pattern.test(b)
}

/**
 * Normalize a line for containment checks: punctuation and whitespace would
 * only hide a verbatim quote that is already in the persona.
 */
function normalizeForLeak(text: string): string {
  return text.replace(/[\s。，、！？：；""''「」『』《》…—～·.,!?:;"'()\-]/g, '')
}

/**
 * Find predictions the persona prompt already answers.
 *
 * A hand-written persona quotes real conversations, and the held-out slice is
 * cut from the same archive, so some "test" answers are literally sitting in
 * the system prompt. A model that sees them just repeats them, which scores as
 * a perfect imitation while proving nothing.
 * @param predictions - candidate prediction tasks.
 * @param system - the full system prompt the model will receive.
 * @returns indexes of predictions whose answer, or whose quoted stretch, the prompt already contains.
 */
export function findLeaked(predictions: readonly Prediction[], system: string): number[] {
  const haystack = normalizeForLeak(system)
  const leaked: number[] = []
  predictions.forEach((prediction, index) => {
    const truth = normalizeForLeak(prediction.truth)
    // Very short answers match by accident; a quote long enough to be unique does not.
    if (truth.length >= 4 && haystack.includes(truth)) {
      leaked.push(index)
      return
    }
    const contextHits = prediction.context.filter((wire) => {
      const text = normalizeForLeak(wire.content)
      return text.length >= 4 && haystack.includes(text)
    }).length
    // Two or more lines from the same window means the whole exchange was quoted.
    if (contextHits >= 2) leaked.push(index)
  })
  return leaked
}

/**
 * Run the eval command.
 * @param flags - parsed CLI flags for this command.
 */
export async function runEval(flags: Flags): Promise<void> {
  const name = stringFlag(flags, 'persona')
  if (name === undefined) throw new Error('用法：eval --persona <名字> [--n 10]（每边 10 条，共 20 题）')

  const holdout = readJsonl<ChatMessage>(dataPath(`${name}.holdout.jsonl`))
  if (holdout.length === 0) {
    throw new Error(`data/${name}.holdout.jsonl 是空的。重新跑 ingest 并设置 --holdout 0.1`)
  }

  const persona = loadPersona(name)
  const system = buildSystemPrompt(persona, { disclose: false })
  const config = llmConfigFromEnv()
  if (config.apiKey.length === 0) {
    throw new LlmError('缺少 API key：设置 PERSONAFORGE_API_KEY 或 DEEPSEEK_API_KEY')
  }
  const perSide = numberFlag(flags, 'n', 10)

  const predictions = buildPredictions(holdout, 500)
  if (predictions.length === 0) {
    throw new Error('没有构造出任何用例。留出集太小，把 --holdout 调大或导入更多记录。')
  }

  const leaked = new Set(findLeaked(predictions, system))
  const usable = predictions.filter((_, index) => !leaked.has(index))
  if (leaked.size > 0) {
    console.log(`剔除 ${leaked.size} 道泄漏题：真人原话或这段对话已经写进 persona/lore，模型会直接背出来。`)
  }
  if (usable.length === 0) {
    throw new Error('剩下全是泄漏题。persona.md 引用的原话太多，改用没引用过的记录段落做留出集。')
  }

  const selected = selectSpread(usable, perSide)
  if (selected.length === 0) {
    throw new Error(`凑不出 ${perSide} 道互不重叠的题。留出集太小，把 --holdout 调大。`)
  }
  if (selected.length < perSide) {
    console.log(`只能选出 ${selected.length} 道互不重叠的题，本次每边 ${selected.length} 条。`)
  }

  // A lower temperature than chat: the quiz measures whether the persona is
  // right, not how creative the sampler is. A wild line is obviously fake and
  // teaches nothing.
  const evalConfig = {
    ...config,
    temperature: Number(process.env.PERSONAFORGE_EVAL_TEMPERATURE ?? '0.7'),
  }

  const items: QuizItem[] = []
  for (const [offset, prediction] of selected.entries()) {
    const pair = offset + 1
    const shown = prediction.context.slice(-QUIZ_CONTEXT)
    items.push({ pair, context: shown, text: prediction.truth, real: true })

    process.stdout.write(`生成假回复 ${pair}/${selected.length} ... `)
    try {
      const generated = await complete(evalConfig, [{ role: 'system', content: system }, ...prediction.context])
      // A verbatim repeat is the model reciting a quoted line, not imitating it.
      if (normalizeForLeak(generated) === normalizeForLeak(prediction.truth)) {
        items.pop()
        console.log('与真话相同，跳过')
        continue
      }
      items.push({ pair, context: shown, text: generated, real: false })
      console.log('ok')
    } catch (error) {
      items.pop()
      console.log('失败')
      console.error(`  ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (items.length < 2) throw new Error('生成的假回复太少，检查接口配置后重试。')
  shuffle(items)

  const deck: string[] = [
    `# 盲测卷 — ${persona.name}`,
    '',
    `下面 ${items.length} 条，${items.filter((item) => item.real).length} 条是真人原话，${items.filter((item) => !item.real).length} 条是 AI 编的，顺序打乱。`,
    '逐条判断哪句是 AI 编的，记下题号，再运行 `node src/cli/index.ts reveal --persona ' + name + '` 对答案。',
    '',
    '提示：别找「哪句更像真人」，找「AI 会怎么写」——太完整、太有条理、解释太多、答非所问，都是破绽。',
    '',
  ]
  const key: Record<string, string> = {}

  for (const [offset, item] of items.entries()) {
    const index = offset + 1
    key[String(index)] = item.real ? 'real' : 'ai'
    deck.push(`## 题目 ${index}`, '')
    for (const wire of item.context) {
      deck.push(`> ${wire.role === 'user' ? '你' : persona.name}：${wire.content}`)
    }
    deck.push('', `**这句话**：${item.text}`, '')
  }

  const realLengths = items.filter((item) => item.real).map((item) => item.text.length)
  const fakeLengths = items.filter((item) => !item.real).map((item) => item.text.length)
  const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)

  const pairs = new Map<number, { real?: QuizItem; fake?: QuizItem }>()
  for (const item of items) {
    const entry = pairs.get(item.pair) ?? {}
    if (item.real) entry.real = item
    else entry.fake = item
    pairs.set(item.pair, entry)
  }
  const matched = [...pairs.values()].filter((entry) => entry.real !== undefined && entry.fake !== undefined)
  const questionAgreement = matched.filter((entry) => sameQuestion(entry.fake?.text ?? '', entry.real?.text ?? '')).length / Math.max(1, matched.length)
  const emojiAgreement = matched.filter((entry) => sameEmoji(entry.fake?.text ?? '', entry.real?.text ?? '')).length / Math.max(1, matched.length)

  const deckPath = dataPath(`eval-${name}.md`)
  const keyPath = dataPath(`eval-${name}.key.json`)
  writeText(deckPath, deck.join('\n') + '\n')
  writeText(keyPath, JSON.stringify(key, null, 2) + '\n')

  console.log(`\n已生成 ${items.length} 条：data/eval-${name}.md`)
  console.log(`答案在 data/eval-${name}.key.json，先别打开\n`)
  console.log('客观参考（只说明风格是否接近，不说明像不像）：')
  console.log(`  真人平均 ${mean(realLengths).toFixed(1)} 字 / AI 平均 ${mean(fakeLengths).toFixed(1)} 字`)
  console.log(`  问句判断一致率：${(questionAgreement * 100).toFixed(0)}%`)
  console.log(`  表情使用一致率：${(emojiAgreement * 100).toFixed(0)}%`)
  console.log('\n真正的指标是盲测：如果你能轻松圈出 AI 那句，说明还不够像。')
}

/**
 * Run `reveal`: print the answer key for the most recent eval.
 * @param flags - parsed CLI flags for this command.
 */
export function revealEval(flags: Flags): void {
  const name = stringFlag(flags, 'persona')
  if (name === undefined) throw new Error('用法：reveal --persona <名字>')
  const raw = readText(dataPath(`eval-${name}.key.json`))
  if (raw === null) throw new Error(`还没有生成盲测卷，先跑 eval --persona ${name}`)
  const key = JSON.parse(raw) as Record<string, string>
  const entries = Object.entries(key)
  for (const [index, verdict] of entries) {
    console.log(`题目 ${index}：${verdict === 'ai' ? 'AI 编的' : '真人原话'}`)
  }
  const aiCount = entries.filter(([, verdict]) => verdict === 'ai').length
  console.log(`\n共 ${entries.length} 条，其中 AI 编的 ${aiCount} 条。`)
}
