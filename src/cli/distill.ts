/**
 * `distill`: generate a persona draft from an already-ingested archive.
 *
 * Writes `persona.draft.md` rather than `persona.md`: a model's reading of a
 * conversation is a starting point for editing, never a silent replacement of
 * a hand-checked persona.
 */

import { LlmError, llmConfigFromEnv } from '../core/llm.ts'
import { annotateCatchphrases, buildChunks, consolidateObservations, observeChunks, renderChunk, renderDraft, verifySamples } from '../core/distill.ts'
import { computeStats, renderStyleBlock } from '../core/stats.ts'
import { dataPath, personaPath, readJsonl, readText, writeText } from '../core/archive.ts'
import type { ChatMessage } from '../core/types.ts'
import { boolFlag, numberFlag, stringFlag, type Flags } from './args.ts'

/** Most frequent sender name for one role, used for display only. */
function nameOf(messages: readonly ChatMessage[], role: 'self' | 'friend'): string {
  const counts = new Map<string, number>()
  for (const message of messages) {
    if (message.role !== role) continue
    counts.set(message.senderName, (counts.get(message.senderName) ?? 0) + 1)
  }
  let best = role === 'self' ? '你' : '他'
  let bestCount = -1
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name
      bestCount = count
    }
  }
  return best
}

/**
 * Report what a real run would send, without calling the model or writing files.
 * @param chunks - every chunk the archive splits into.
 * @param names - display names for the two speakers.
 * @param maxChunks - how many chunks the real run would process.
 * @param limit - messages to show in the preview.
 */
function printDryRun(
  chunks: readonly ChatMessage[][],
  names: { self: string; friend: string },
  maxChunks: number,
  limit: number,
): void {
  console.log('\n[试运行] 不调用模型，不写文件。')
  const planned = Math.min(chunks.length, maxChunks)
  for (let index = 0; index < planned; index += 1) {
    const chars = renderChunk(chunks[index], names.self, names.friend).length
    console.log(`  第 ${index + 1} 块：${chunks[index].length} 条消息，约 ${chars} 字`)
  }
  const skipped = chunks.length - planned
  if (skipped > 0) {
    console.log(`  另有 ${skipped} 块本次不会处理（--max-chunks ${maxChunks} 会丢掉它们）`)
  }
  if (planned > 0) {
    console.log(`\n预览第 1 块前 ${Math.min(limit, chunks[0].length)} 条：`)
    console.log(renderChunk(chunks[0].slice(0, limit), names.self, names.friend))
  }
  console.log('\n确认分块和名字没问题后，去掉 --dry-run 正式跑。')
}

/**
 * Run the distill command.
 * @param flags - parsed CLI flags for this command.
 */
export async function runDistill(flags: Flags): Promise<void> {
  const name = stringFlag(flags, 'persona')
  if (name === undefined) {
    throw new Error('用法：distill --persona <名字> [--chunk 60] [--max-chunks 12] [--friend 名字] [--dry-run] [--overwrite]')
  }

  const messages = readJsonl<ChatMessage>(dataPath(`${name}.jsonl`))
  if (messages.length === 0) {
    throw new Error(`data/${name}.jsonl 是空的。先跑 ingest --file <原始文本> --persona ${name}`)
  }

  const selfName = nameOf(messages, 'self')
  const friendName = nameOf(messages, 'friend')
  // The transcript label is usually a WeChat nickname. Prefer an explicit
  // `--friend`, then the name the user already gave in persona.md, so the
  // draft heading matches the hand-checked persona instead of `dennis`.
  const friendFlag = stringFlag(flags, 'friend')
  const existing = readText(personaPath(name, 'persona.md'))
  const heading = existing === null ? undefined : /^#\s+(.+)$/m.exec(existing)?.[1]?.trim()
  const friendDisplay = friendFlag ?? heading ?? friendName
  const chunkSize = numberFlag(flags, 'chunk', 60)
  const maxChunks = numberFlag(flags, 'max-chunks', 12)
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new Error(`--chunk 必须是正整数，收到 ${chunkSize}`)
  }
  if (!Number.isInteger(maxChunks) || maxChunks < 1) {
    throw new Error(`--max-chunks 必须是正整数，收到 ${maxChunks}`)
  }

  const chunks = buildChunks(messages, chunkSize)
  const planned = Math.min(chunks.length, maxChunks)
  console.log(`${messages.length} 条消息（${selfName} / ${friendName}），切成 ${chunks.length} 块，本次处理 ${planned} 块`)
  // The dry run needs no credentials and touches nothing on disk.
  if (boolFlag(flags, 'dry-run')) {
    printDryRun(chunks, { self: selfName, friend: friendName }, maxChunks, 12)
    return
  }

  const config = llmConfigFromEnv()
  if (config.apiKey.length === 0) {
    throw new LlmError('缺少 API key：设置 PERSONAFORGE_API_KEY 或 DEEPSEEK_API_KEY')
  }
  console.log(`模型 ${config.model} @ ${config.baseUrl}\n`)

  let merged = await observeChunks(
    config,
    chunks,
    { self: selfName, friend: friendName, display: friendDisplay },
    { chunkSize, maxChunks, onProgress: (message) => process.stdout.write(message) },
  )

  if (merged.totalChunks > 0 && merged.failedChunks === merged.totalChunks) {
    throw new Error('所有块都失败了，没有可用的观察结果。检查接口配置后重试。')
  }

  merged = await consolidateObservations(config, merged, { onProgress: (message) => process.stdout.write(message) })

  // A quote attributed to the wrong speaker is worse than no quote: the archive
  // is the authority on who said what, so labels are checked against it.
  merged.samples = verifySamples(merged.samples, messages)
  merged.catchphrases = annotateCatchphrases(merged.catchphrases, messages)

  // The owner is always "你" in a draft: the transcript label is a nickname
  // and means nothing to whoever reads the persona later.
  const styleBlock = renderStyleBlock(computeStats(messages), { self: '你', friend: friendDisplay })
  const draft = renderDraft({ name: friendDisplay, styleBlock, merged })

  const overwrite = boolFlag(flags, 'overwrite')
  const target = personaPath(name, overwrite ? 'persona.md' : 'persona.draft.md')
  // Rerunning must not silently destroy the previous draft (or, with
  // --overwrite, the hand-checked persona). One generation of backup is enough
  // to compare against without accumulating files.
  const backup = target.replace(/\.md$/, '.prev.md')
  const previous = readText(target)
  if (previous !== null) writeText(backup, previous)
  writeText(target, draft)

  console.log(`\n已写入 personas/${name}/${overwrite ? 'persona.md' : 'persona.draft.md'}`)
  if (previous !== null) console.log(`上一版已备份为 personas/${name}/${backup.split(/[\\/]/).pop()}`)
  console.log(`覆盖 ${merged.totalChunks - merged.failedChunks}/${merged.totalChunks} 块对话`)
  console.log('\n下一步：')
  console.log(`  1. 打开它，把「需核对」的部分逐条改掉`)
  console.log(`  2. 补上「他是谁（需要你补）」的几项`)
  if (!overwrite) console.log(`  3. 确认后改名成 persona.md，或者重跑时加 --overwrite`)
  console.log(`  4. node src/cli/index.ts chat --persona ${name}`)
}
