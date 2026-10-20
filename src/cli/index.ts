#!/usr/bin/env node
/**
 * persona-forge command line.
 *
 * Every subcommand is a thin wrapper over `src/core`: parsing and statistics
 * never touch the network, and only `distill`, `chat`, and `eval` need a model
 * endpoint.
 */

import { parseFlags } from './args.ts'
import { runChat } from './chat.ts'
import { runDistill } from './distill.ts'
import { runEval, revealEval } from './eval.ts'
import { runForge } from './forge.ts'
import { runIngest, runSpeakers } from './ingest.ts'
import { runStats } from './stats.ts'

const USAGE = `persona-forge — 从聊天记录蒸馏一个人的说话方式

  forge    --file <聊天记录.txt> --persona <名字>
                                        一条命令跑完解析、统计、蒸馏，直接产出人设
                                         --me 我 --friend 他
                                         --display 真名    人设标题用什么名字
                                         --sample 40       只均匀抽 40 块（控制花费）
                                         --chunk 60        每块多少条消息
                                         --redact          打码手机号、身份证、邮箱、链接
  mcp                                   启动 MCP stdio server，供 AI 客户端当插件调用

  speakers --file <原始文本>            看识别到了哪些说话人
  ingest   --file <原始文本> --persona <名字>
                                        解析并生成 data/ 与 personas/<名字>/
  distill  --persona <名字>              自动生成人设初稿 persona.draft.md
                                         --chunk 60        每块多少条消息
                                         --max-chunks 12   最多处理几块（控制花费）
                                         --friend <名字>   草稿里叫他什么（默认取 persona.md 标题）
                                         --dry-run         只报分块和开销，不调模型
                                         --overwrite       直接覆盖 persona.md
  stats    --persona <名字> | --file <原始文本>
                                        输出风格指纹（--markdown 写入 style.md）
  chat     --persona <名字>             进入扮演对话
                                         --actions  允许括号动作表情（默认关）
                                         --disclose 声明这是 AI
  eval     --persona <名字> [--n 10]    从留出集出 2n 条，一半真一半假
                                         让你挑出哪些是 AI 编的
  reveal   --persona <名字>             看盲测答案

ingest / forge 参数：
  --me <名字,...>   哪一边是你（默认 我）
  --friend <名字>   哪一边要模仿（默认 出现最多的一方）
  --holdout <0-1>   留出比例（默认 0.1）
  --source <name>   wechat / qq / douyin / manual
  --redact          打码手机号、身份证、邮箱、链接

环境变量：
  PERSONAFORGE_API_KEY / DEEPSEEK_API_KEY
  PERSONAFORGE_BASE_URL   默认 https://api.deepseek.com/v1
  PERSONAFORGE_MODEL      默认 deepseek-chat
`

async function main(argv: string[]): Promise<void> {
  const command = argv[0]
  const flags = parseFlags(argv.slice(1))
  switch (command) {
    case 'forge':
      await runForge(flags)
      return
    case 'mcp':
      // Long-running stdio server; the module starts itself on import.
      await import('../mcp/server.ts')
      return
    case 'ingest':
      runIngest(flags)
      return
    case 'speakers':
      runSpeakers(flags)
      return
    case 'stats':
      runStats(flags)
      return
    case 'distill':
      await runDistill(flags)
      return
    case 'chat':
      await runChat(flags)
      return
    case 'eval':
      await runEval(flags)
      return
    case 'reveal':
      revealEval(flags)
      return
    case undefined:
    case 'help':
    case '--help':
      console.log(USAGE)
      return
    default:
      console.error(`未知命令：${command}\n`)
      console.log(USAGE)
      process.exitCode = 1
  }
}

try {
  await main(process.argv.slice(2))
} catch (error) {
  // Every thrown error carries a user-facing message already; a stack trace
  // would only bury it.
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
