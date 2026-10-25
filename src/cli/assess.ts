/**
 * `assess`: score the Big Five personality of an ingested archive.
 *
 * The result is two files: `personas/<name>/bigfive.md` for reading, and
 * `data/<name>.bigfive.json` for `compare`, which turns two stored profiles
 * into a distance. Real calls need an API key, so like `distill` this runs in
 * the user's own terminal; `--dry-run` reports the chunk plan without calling.
 */

import { LlmError, llmConfigFromEnv } from '../core/llm.ts'
import {
  aggregateBigFive,
  assessTranscripts,
  countUnverified,
  DIMENSIONS,
  DIMENSION_LABELS,
  renderBigFiveReport,
  sumUnverified,
  verifyBigFiveEvidence,
  type BigFiveObservation,
} from '../core/bigfive.ts'
import { buildChunks, renderChunk } from '../core/distill.ts'
import { backupFile, sampleEvenly } from '../core/forge.ts'
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
 * Run the assess command.
 * @param flags - parsed CLI flags for this command.
 */
export async function runAssess(flags: Flags): Promise<void> {
  const name = stringFlag(flags, 'persona')
  if (name === undefined) {
    throw new Error('用法：assess --persona <名字> [--chunk 60] [--sample 40] [--friend 名字] [--dry-run]')
  }

  const messages = readJsonl<ChatMessage>(dataPath(`${name}.jsonl`))
  if (messages.length === 0) {
    throw new Error(`data/${name}.jsonl 是空的。先跑 ingest --file <原始文本> --persona ${name}`)
  }

  const selfName = nameOf(messages, 'self')
  const friendName = nameOf(messages, 'friend')
  // Same name resolution as distill: an explicit flag, then the hand-checked
  // persona heading, then the raw transcript label.
  const friendFlag = stringFlag(flags, 'friend')
  const existing = readText(personaPath(name, 'persona.md'))
  const heading = existing === null ? undefined : /^#\s+(.+)$/m.exec(existing)?.[1]?.trim()
  const displayName = friendFlag ?? heading ?? friendName

  const chunkSize = numberFlag(flags, 'chunk', 60)
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new Error(`--chunk 必须是正整数，收到 ${chunkSize}`)
  }
  const sample = numberFlag(flags, 'sample', 0)
  if (!Number.isInteger(sample) || sample < 0) {
    throw new Error(`--sample 需要是非负整数，收到 ${sample}`)
  }

  const chunks = buildChunks(messages, chunkSize)
  // Sampling picks whole chunks spread over the whole archive, the same trade
  // forge makes: cover every period cheaply, accept missing rare signals.
  const planned = sample > 0 ? sampleEvenly(chunks, sample) : chunks
  const totalChars = planned.reduce((sum, chunk) => sum + renderChunk(chunk, selfName, friendName).length, 0)
  console.log(
    `${messages.length} 条消息（${selfName} / ${friendName}），切成 ${chunks.length} 块，本次评估 ${planned.length} 块（约 ${totalChars} 字）`,
  )
  if (planned.length === 0) throw new Error('一块都没有，检查 --chunk / --sample。')

  if (boolFlag(flags, 'dry-run')) {
    console.log('\n[试运行] 不调用模型，不写文件。每块一次调用，共 ' + planned.length + ' 次。')
    for (let index = 0; index < planned.length; index += 1) {
      const chars = renderChunk(planned[index], selfName, friendName).length
      console.log(`  第 ${index + 1} 块：${planned[index].length} 条消息，约 ${chars} 字`)
    }
    console.log('\n确认分块没问题后，去掉 --dry-run 正式跑。')
    return
  }

  const config = llmConfigFromEnv()
  if (config.apiKey.length === 0) {
    throw new LlmError('缺少 API key：设置 PERSONAFORGE_API_KEY 或 DEEPSEEK_API_KEY')
  }
  // The judge must be deterministic: reproducibility is the point of the metric.
  const assessConfig = { ...config, temperature: 0 }
  console.log(`模型 ${config.model} @ ${config.baseUrl}（温度 0）\n`)

  const transcripts = planned.map((chunk) => renderChunk(chunk, selfName, friendName))
  const { observations, failed } = await assessTranscripts(assessConfig, transcripts, selfName, friendName, {
    onProgress: (message) => process.stdout.write(message),
  })
  if (observations.length === 0) throw new Error('所有块都失败了，没有可用的人格评估。检查接口配置后重试。')

  // Evidence is checked against every message he sent in the full archive —
  // sampled chunks are a subset, so nothing real gets rejected for that.
  const friendTexts = messages.filter((message) => message.role === 'friend').map((message) => message.text ?? '')
  const dropped: Array<Record<Dimension, number>> = []
  const verified: BigFiveObservation[] = observations.map((observation) => {
    const after = verifyBigFiveEvidence(observation, friendTexts)
    dropped.push(countUnverified(observation, after))
    return after
  })
  const summary = aggregateBigFive(verified, sumUnverified(dropped), failed)

  const corpus = `data/${name}.jsonl（${messages.length} 条消息）`
  const report = renderBigFiveReport(displayName, summary, corpus)
  const backup = backupFile(personaPath(name, 'bigfive.md'))
  writeText(personaPath(name, 'bigfive.md'), report)
  writeText(
    dataPath(`${name}.bigfive.json`),
    `${JSON.stringify({ persona: name, model: config.model, date: new Date().toISOString(), ...summary }, null, 2)}\n`,
  )

  const kept = DIMENSIONS.reduce((sum, dimension) => sum + (summary.evidence[dimension]?.length ?? 0), 0)
  const removed = DIMENSIONS.reduce((sum, dimension) => sum + summary.unverified[dimension], 0)
  console.log('')
  for (const dimension of DIMENSIONS) {
    const stat = summary.stats[dimension]
    const score = stat.n > 0 ? `${stat.mean.toFixed(1)}${stat.n > 1 ? ` ±${stat.std.toFixed(1)}` : ''}` : '—'
    console.log(`  ${DIMENSION_LABELS[dimension]}：${score}（${stat.n} 块给出分数）`)
  }
  console.log(`\n证据：${kept} 条核到原话，${removed} 条没找到、已剔除`)
  console.log(`已写入 personas/${name}/bigfive.md 和 data/${name}.bigfive.json`)
  if (backup !== null) console.log(`上一版报告已备份为 ${backup.split(/[\\/]/).pop()}`)
  console.log('\n下一步：')
  console.log(`  1. 打开 personas/${name}/bigfive.md，看五维分数和证据像不像他本人`)
  console.log('  2. compare 现在会同时报告人格距离（拿生成回复对比这里的真实档案）')
}
