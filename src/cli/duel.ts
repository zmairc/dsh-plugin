/**
 * `duel`: two personas, same context, one question — which line sounds more
 * like him?
 *
 * The blind quiz asks "is this real or generated?", and that framing invites a
 * hunt for flaws: an odd jump, an over-complete sentence. But real people
 * write odd sentences — one user marked the genuine line `你干啥去了` as AI
 * three separate times — so the absolute question carries a bias that no
 * amount of care removes.
 *
 * A forced comparison does not have that problem. `eval` measures how
 * convincing a persona is on its own; `duel` measures which of two is more
 * convincing, which is the actual question when you upgrade a persona.
 */

import { complete, LlmError, llmConfigFromEnv } from '../core/llm.ts'
import { buildSystemPrompt, loadPersona } from '../core/persona.ts'
import { dataPath, readJsonl, readText, writeText } from '../core/archive.ts'
import { buildPredictions, findLeaked, selectSpread } from '../core/evalkit.ts'
import { binomialP } from '../core/compare.ts'
import type { ChatMessage } from '../core/types.ts'
import { numberFlag, stringFlag, type Flags } from './args.ts'

/** Who sat in the left-hand slot for one item. */
type Slot = 'base' | 'challenger'

/** How a wait reads in a transcript: the delay is part of the reply. */
function formatGap(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return ''
  if (minutes < 60) return `（${minutes} 分钟后）`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `（${hours} 小时后）`
  return `（${Math.round(hours / 24)} 天后）`
}

/**
 * Flatten a generated reply to one line.
 *
 * Both sides must be laid out the same way: one version wrapping itself onto
 * three lines and the other staying on one is a tell, and the reader would be
 * guessing at formatting rather than at the voice.
 */
function tidy(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Read `A,B,A…` or `ABAB…` into a list of choices. */
function parseAnswers(raw: string): string[] {
  return raw.toUpperCase().match(/[AB]/g) ?? []
}

/**
 * Run the duel command.
 * @param flags - parsed CLI flags for this command.
 */
export async function runDuel(flags: Flags): Promise<void> {
  const base = stringFlag(flags, 'base')
  const challenger = stringFlag(flags, 'challenger')
  if (base === undefined || challenger === undefined) {
    throw new Error('用法：duel --base <新版本> --challenger <旧版本> [--n 20] ｜ --answers "A,B,A…" 评分')
  }

  const deckPath = dataPath(`duel-${base}-vs-${challenger}.md`)
  const keyPath = dataPath(`duel-${base}-vs-${challenger}.key.json`)

  const answersFlag = stringFlag(flags, 'answers')
  if (answersFlag !== undefined) {
    score(answersFlag, deckPath, keyPath, base, challenger)
    return
  }

  const holdout = readJsonl<ChatMessage>(dataPath(`${base}.holdout.jsonl`))
  if (holdout.length === 0) {
    throw new Error(`data/${base}.holdout.jsonl 是空的。用有留出集的那一版当 --base。`)
  }

  const config = llmConfigFromEnv()
  if (config.apiKey.length === 0) {
    throw new LlmError('缺少 API key：设置 PERSONAFORGE_API_KEY 或 DEEPSEEK_API_KEY')
  }

  const sides: Array<{ slot: Slot; name: string; system: string }> = [
    { slot: 'base', name: base, system: buildSystemPrompt(loadPersona(base), { disclose: false }) },
    { slot: 'challenger', name: challenger, system: buildSystemPrompt(loadPersona(challenger), { disclose: false }) },
  ]

  const predictions = buildPredictions(holdout, 500)
  const leaked = new Set(findLeaked(predictions, sides.map((side) => side.system)))
  const usable = predictions.filter((_, index) => !leaked.has(index))
  if (leaked.size > 0) console.log(`剔除 ${leaked.size} 道泄漏题（两版 persona 里出现过的原话都算）。`)

  const requested = numberFlag(flags, 'n', 20)
  const selected = selectSpread(usable, requested)
  if (selected.length === 0) throw new Error('凑不出互不重叠的题，留出集太小。')
  if (selected.length < requested) console.log(`只能选出 ${selected.length} 道互不重叠的题，本次 ${selected.length} 题。`)

  const duelConfig = { ...config, temperature: Number(process.env.PERSONAFORGE_EVAL_TEMPERATURE ?? '0.7') }
  const key: Record<string, Slot> = {}
  const deck: string[] = [
    `# 成对比较 — ${base}（新） vs ${challenger}（旧）`,
    '',
    `共 ${selected.length} 题。每题给同一段对话，A、B 两条回复里有一条来自「${base}」、另一条来自「${challenger}」，左右随机。`,
    '',
    '**问：哪一条更像他真的会这么说？** 不要找破绽——真人也会跳话题、也会答非所问。',
    '把选择记成一行：`A,B,B,A,…`，然后跑：',
    '',
    `    node src/cli/index.ts duel --base ${base} --challenger ${challenger} --answers "A,B,…"`,
    '',
  ]

  for (const [offset, prediction] of selected.entries()) {
    const number = offset + 1
    const shown = prediction.context.slice(-4)
    // Randomize the side, so a habitual A/B preference cannot leak in.
    const left: Slot = Math.random() < 0.5 ? 'base' : 'challenger'
    const right: Slot = left === 'base' ? 'challenger' : 'base'
    key[String(number)] = left

    const texts: Record<Slot, string> = { base: '', challenger: '' }
    for (const side of sides) {
      process.stdout.write(`第 ${number}/${selected.length} 题 · ${side.name} ... `)
      try {
        texts[side.slot] = tidy(
          await complete(duelConfig, [{ role: 'system', content: side.system }, ...prediction.context]),
        )
        console.log('ok')
      } catch (error) {
        console.log('失败')
        console.error(`  ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (texts.base.length === 0 || texts.challenger.length === 0) {
      delete key[String(number)]
      continue
    }

    deck.push(`## 题目 ${number}`, '')
    for (const wire of shown) deck.push(`> ${wire.role === 'user' ? '你' : '他'}：${wire.content}`)
    const gap = formatGap(prediction.gapMs)
    if (gap.length > 0) deck.push(`> ${gap}`)
    deck.push('', `**A**：${texts[left]}`, '', `**B**：${texts[right]}`, '', '你的选择：_', '')
  }

  const decided = Object.keys(key).length
  if (decided === 0) throw new Error('所有题都生成失败了，检查接口配置后重试。')

  writeText(deckPath, deck.join('\n') + '\n')
  writeText(keyPath, JSON.stringify(key, null, 2) + '\n')
  console.log(`\n已写出 ${decided} 题：${deckPath}`)
  console.log('打开它逐题记录 A 或 B，再用 --answers 评分（答案在 .key.json，先别打开）。')
}

/** Grade a duel from the reader's choices. */
function score(answers: string, deckPath: string, keyPath: string, base: string, challenger: string): void {
  const raw = readText(keyPath)
  if (raw === null) throw new Error(`还没有生成题目，先跑 duel --base ${base} --challenger ${challenger}`)
  const key = JSON.parse(raw) as Record<string, Slot>
  const picked = parseAnswers(answers)
  const numbers = Object.keys(key).sort((a, b) => Number(a) - Number(b))

  let baseWins = 0
  let challengerWins = 0
  numbers.forEach((number, index) => {
    const choice = picked[index]
    if (choice === undefined) return
    const left = key[number]
    const choseLeft = choice === 'A'
    const winner: Slot = choseLeft ? left : left === 'base' ? 'challenger' : 'base'
    if (winner === 'base') baseWins += 1
    else challengerWins += 1
  })

  const decided = baseWins + challengerWins
  if (decided === 0) throw new Error(`解析不出选择，收到 ${answers.length} 个字符；写成 A,B,B,A 这样`)
  if (decided < numbers.length) console.log(`注意：只解析出 ${decided}/${numbers.length} 个选择。`)

  const p = binomialP(baseWins, decided)
  const share = (wins: number): string => `${((wins / decided) * 100).toFixed(0)}%`
  console.log(`\n共 ${decided} 题`)
  console.log(`  ${base}（新）    ${baseWins} 题，${share(baseWins)}`)
  console.log(`  ${challenger}（旧） ${challengerWins} 题，${share(challengerWins)}`)
  console.log(`\n二项检验：p = ${p.toFixed(3)}`)
  if (p < 0.05) {
    const winner = baseWins > challengerWins ? base : challenger
    console.log(`显著（p < 0.05）：${winner} 更像他。`)
  } else {
    console.log('不显著：这个样本量分不出差别。20 题里要至少 15 题倾向一边才算 p < 0.05。')
  }
  console.log(`\n题目文件：${deckPath}`)
}
