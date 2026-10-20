/**
 * `chat`: an interactive role-play session with one persona.
 *
 * The session holds no state on disk. Every reply is a fresh request built from
 * the persona files plus the last few turns, which keeps the prompt prefix
 * stable and the KV cache useful.
 */

import { createInterface } from 'node:readline/promises'
import { complete, llmConfigFromEnv, type WireMessage } from '../core/llm.ts'
import { buildSystemPrompt, loadPersona } from '../core/persona.ts'
import { boolFlag, stringFlag, type Flags } from './args.ts'

/** How many recent turns to resend. Older turns drop out rather than grow the prompt. */
const HISTORY_TURNS = 24

/**
 * Run the chat command.
 * @param flags - parsed CLI flags for this command.
 */
export async function runChat(flags: Flags): Promise<void> {
  const name = stringFlag(flags, 'persona')
  if (name === undefined) throw new Error('用法：chat --persona <名字> [--actions] [--disclose]')

  const persona = loadPersona(name)
  const disclose = boolFlag(flags, 'disclose')
  let actions = boolFlag(flags, 'actions')
  let system = buildSystemPrompt(persona, { disclose, actions })
  const config = llmConfigFromEnv()

  console.log(`正在和 ${persona.name} 对话（${config.model} @ ${config.baseUrl}）`)
  console.log(`动作/表情：${actions ? '开' : '关'}　输入 /actions 切换，/reset 清空上下文，/exit 退出。\n`)

  const readline = createInterface({ input: process.stdin, output: process.stdout })
  const history: WireMessage[] = []

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
      console.log('（已清空上下文）\n')
      continue
    }
    if (trimmed === '/actions') {
      actions = !actions
      system = buildSystemPrompt(persona, { disclose, actions })
      console.log(`（动作/表情：${actions ? '开' : '关'}）\n`)
      continue
    }
    if (trimmed === '/help') {
      console.log('/actions 切换动作表情  /reset 清空上下文  /exit 退出\n')
      continue
    }

    history.push({ role: 'user', content: trimmed })
    try {
      const reply = await complete(config, [{ role: 'system', content: system }, ...history.slice(-HISTORY_TURNS)])
      history.push({ role: 'assistant', content: reply })
      console.log(`\n${persona.name} > ${reply}\n`)
    } catch (error) {
      // Drop the unanswered turn so the next request is not built on it.
      history.pop()
      console.error(`\n调用失败：${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  readline.close()
}
