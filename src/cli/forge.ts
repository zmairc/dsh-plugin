/**
 * `forge`: one command from a transcript file to a usable persona pack.
 *
 * This is the entry point for someone who downloaded the project and just has
 * a txt: no manual ingest, no manual stats, no separate distill call.
 */

import { LlmError, llmConfigFromEnv } from '../core/llm.ts'
import { assertSafePersonaName, forgePersona } from '../core/forge.ts'
import type { Source } from '../core/types.ts'
import { boolFlag, listFlag, numberFlag, stringFlag, type Flags } from './args.ts'

const SOURCES: readonly Source[] = ['wechat', 'qq', 'douyin', 'manual']

/**
 * Run the forge command.
 * @param flags - parsed CLI flags for this command.
 */
export async function runForge(flags: Flags): Promise<void> {
  const file = stringFlag(flags, 'file')
  const persona = stringFlag(flags, 'persona')
  if (file === undefined || persona === undefined) {
    throw new Error('用法：forge --file <聊天记录.txt> --persona <名字> [--me 我] [--friend 他] [--sample 40] [--redact]')
  }
  assertSafePersonaName(persona)

  const config = llmConfigFromEnv()
  if (config.apiKey.length === 0) {
    throw new LlmError('缺少 API key：设置 PERSONAFORGE_API_KEY 或 DEEPSEEK_API_KEY')
  }

  const sourceFlag = stringFlag(flags, 'source') ?? 'manual'
  if (!SOURCES.includes(sourceFlag as Source)) {
    throw new Error(`--source 只能是 ${SOURCES.join(' / ')}`)
  }

  const chunkSize = numberFlag(flags, 'chunk', 60)
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new Error(`--chunk 必须是正整数，收到 ${chunkSize}`)
  }
  const maxChunks = numberFlag(flags, 'max-chunks', 0)
  if (maxChunks < 0 || !Number.isInteger(maxChunks)) {
    throw new Error(`--max-chunks 必须是非负整数，收到 ${maxChunks}`)
  }
  const sample = numberFlag(flags, 'sample', 0)
  if (sample < 0 || !Number.isInteger(sample)) {
    throw new Error(`--sample 必须是非负整数，收到 ${sample}`)
  }
  const holdoutRatio = numberFlag(flags, 'holdout', 0.1)
  if (holdoutRatio < 0 || holdoutRatio >= 1) {
    throw new Error(`--holdout 必须在 0 到 1 之间，收到 ${holdoutRatio}`)
  }
  const recentMonths = numberFlag(flags, 'recent', 0)
  if (recentMonths < 0 || !Number.isInteger(recentMonths)) {
    throw new Error(`--recent 必须是非负整数（月），收到 ${recentMonths}`)
  }

  const friendName = stringFlag(flags, 'friend')
  const display = stringFlag(flags, 'display')
  console.log(`读取 ${file}`)
  console.log(`模型 ${config.model} @ ${config.baseUrl}\n`)

  const result = await forgePersona({
    file,
    persona,
    selfNames: listFlag(flags, 'me', ['我']),
    ...(friendName === undefined ? {} : { friendName }),
    ...(display === undefined ? {} : { display }),
    source: sourceFlag as Source,
    holdoutRatio,
    redact: boolFlag(flags, 'redact'),
    chunkSize,
    maxChunks,
    ...(sample > 0 ? { sample } : {}),
    ...(recentMonths > 0 ? { recentMonths } : {}),
    config,
    onProgress: (message) => process.stdout.write(message),
  })

  console.log(`\n\n解析 ${result.total} 条（${result.self} / ${result.friend}）`)
  if (result.recentMonths !== undefined) {
    console.log(`只用了最近 ${result.recentMonths} 个月，丢弃 ${result.droppedByRecent} 条更早的消息`)
  }
  console.log(`训练 ${result.train} 条，留出 ${result.holdout} 条用于日后盲测`)
  console.log(`切成 ${result.chunks} 块，处理 ${result.processed} 块`)
  console.log(`累计 ${result.usage.calls} 次模型调用，输入 ${result.usage.promptTokens} / 输出 ${result.usage.completionTokens} token`)
  console.log(`\n已生成：${result.personaFile}`)
  console.log(`风格指纹：${result.styleFile}`)
  if (result.sampled) {
    console.log(`\n注意：这是抽样试跑，结果写在 persona.sample.md，没有覆盖你的人设。`)
  }
  if (result.backups.length > 0) {
    console.log(`\n覆盖前的旧文件已备份：`)
    for (const backup of result.backups) console.log(`  ${backup}`)
  }
  if (result.processed < result.chunks) {
    console.log(`\n注意：只处理了 ${result.processed}/${result.chunks} 块，没覆盖到的对话不会影响统计，但会降低观察的完整度。`)
  }
  console.log('\n这份人设是自动生成的：统计精确，模型读出来的特征需要你核对。')
  console.log(`下一步：node src/cli/index.ts chat --persona ${result.persona}`)
  console.log(`盲测：  node src/cli/index.ts eval --persona ${result.persona} --n 10`)
}
