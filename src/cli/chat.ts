/**
 * `chat`: an interactive role-play session with one persona.
 *
 * The session holds no state on disk. Every reply is a fresh request built from
 * the persona files plus the last few turns, which keeps the prompt prefix
 * stable and the KV cache useful.
 */

import { createInterface } from 'node:readline/promises'
import { complete, llmConfigFromEnv, type WireMessage } from '../core/llm.ts'
import { buildSystemPrompt, isSkip, loadPersona, mustAnswerHint, SKIP_MARKER } from '../core/persona.ts'
import { dataPath, readJsonl } from '../core/archive.ts'
import { computeStats } from '../core/stats.ts'
import { lengthPlanFromStats, longHint, shouldAskForLong, type LengthPlan } from '../core/reply-length.ts'
import type { ChatMessage } from '../core/types.ts'
import { boolFlag, stringFlag, type Flags } from './args.ts'

/** How many recent turns to resend. Older turns drop out rather than grow the prompt. */
const HISTORY_TURNS = 24

/**
 * Read the stored length plan for a persona, when its archive is still around.
 * @param name - persona directory name.
 * @returns the plan, or undefined when there is no archive to measure.
 */
function loadLengthPlan(name: string): LengthPlan | undefined {
  const archive = readJsonl<ChatMessage>(dataPath(`${name}.jsonl`))
  return archive.length === 0 ? undefined : lengthPlanFromStats(computeStats(archive))
}

/**
 * Run the chat command.
 * @param flags - parsed CLI flags for this command.
 */
export async function runChat(flags: Flags): Promise<void> {
  const name = stringFlag(flags, 'persona')
  if (name === undefined) throw new Error('用法：chat --persona <名字> [--as 对方名字] [--actions] [--disclose]')

  const persona = loadPersona(name)
  const disclose = boolFlag(flags, 'disclose')
  let actions = boolFlag(flags, 'actions')
  // Who is on the other side. Without it the persona keeps addressing the
  // archive owner, which is only correct for exactly one caller.
  const listener = stringFlag(flags, 'as')
  let system = buildSystemPrompt(persona, { disclose, actions, ...(listener === undefined ? {} : { listener }) })
  const config = llmConfigFromEnv()
  // Length is balanced across the session: short replies stay short, and a
  // long one is requested when the measured share falls behind.
  const plan = loadLengthPlan(name)
  const replyLengths: number[] = []

  console.log(`正在和 ${persona.name} 对话（${config.model} @ ${config.baseUrl}）`)
  if (listener !== undefined) console.log(`对方身份：${listener}`)
  console.log(`动作/表情：${actions ? '开' : '关'}　输入 /actions 切换，/reset 清空上下文，/exit 退出。\n`)

  const readline = createInterface({ input: process.stdin, output: process.stdout })
  const history: WireMessage[] = []
  // Silence is allowed once; the turn after it has to answer.
  let lastWasSkip = false

  for (;;) {
    let line: string
    try {
      line = await readline.question('你 > ')
    } catch {
      // The stream closed (Ctrl+C or EOF); ending the session is the only exit.
      break
    }

    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    if (trimmed === '/exit' || trimmed === '/quit') break
    if (trimmed === '/reset') {
      history.length = 0
      lastWasSkip = false
      console.log('（已清空上下文）\n')
      continue
    }
    if (trimmed === '/actions') {
      actions = !actions
      system = buildSystemPrompt(persona, { disclose, actions, ...(listener === undefined ? {} : { listener }) })
      console.log(`（动作/表情：${actions ? '开' : '关'}）\n`)
      continue
    }
    if (trimmed === '/help') {
      console.log('/actions 切换动作表情  /reset 清空上下文  /exit 退出\n')
      continue
    }

    history.push({ role: 'user', content: trimmed })
    try {
      // After a silent turn the next one must answer, and that outweighs the
      // length nudge: forcing a long reply right after ignoring you reads as a
      // bot, not as a person changing his mind.
      // Ask for a long reply only when long ones are behind their measured
      // share; a short reply is usually exactly right.
      const askLong = !lastWasSkip && plan !== undefined && shouldAskForLong(replyLengths, plan)
      const hint = lastWasSkip ? mustAnswerHint() : askLong && plan !== undefined ? longHint(plan.threshold) : undefined
      const turnSystem = hint === undefined ? system : `${system}\n\n${hint}`
      const reply = await complete(config, [{ role: 'system', content: turnSystem }, ...history.slice(-HISTORY_TURNS)])
      lastWasSkip = isSkip(reply)
      // Silence is kept as the marker so the next request knows this turn was
      // skipped, and it never enters the length distribution.
      history.push({ role: 'assistant', content: lastWasSkip ? SKIP_MARKER : reply })
      if (lastWasSkip) {
        console.log(`\n（${persona.name} 没回）\n`)
      } else {
        replyLengths.push(reply.length)
        console.log(`\n${persona.name} > ${reply}\n`)
      }
    } catch (error) {
      // Drop the unanswered turn so the next request is not built on it.
      history.pop()
      console.error(`\n调用失败：${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  readline.close()
}
