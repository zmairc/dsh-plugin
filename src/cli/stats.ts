/**
 * `stats`: measure a normalized archive and render the style fingerprint.
 *
 * Accepts either a persona (`--persona`, reads `data/<name>.jsonl`) or a raw
 * transcript (`--file`, parses in memory), so the fingerprint is available
 * before anything is written to disk.
 */

import { parseTranscript } from '../core/parse.ts'
import type { ChatMessage } from '../core/types.ts'
import { computeStats, renderStyleBlock, type StyleStats } from '../core/stats.ts'
import { dataPath, personaPath, readJsonl, readText, writeText } from '../core/archive.ts'
import { boolFlag, listFlag, stringFlag, type Flags } from './args.ts'

/** Human-readable detail that the pasteable Markdown block leaves out. */
function detail(stats: StyleStats): string {
  const kinds = Object.entries(stats.kinds)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${kind}=${count}`)
    .join(' ')
  const hours = stats.hourHistogram
    .map((count, hour) => ({ hour, count }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 4)
    .map((entry) => `${String(entry.hour).padStart(2, '0')}:00(${entry.count})`)
    .join(' ')
  return [
    `消息类型：${kinds}`,
    `他的峰值时段：${hours}`,
    `他的消息长度：最短 ${stats.length.min} / 中位 ${stats.length.median} / 90 分位 ${stats.length.p90} / 最长 ${stats.length.max} 字`,
  ].join('\n')
}

/**
 * Run the stats command.
 * @param flags - parsed CLI flags for this command.
 */
export function runStats(flags: Flags): void {
  const name = stringFlag(flags, 'persona')
  const file = stringFlag(flags, 'file')
  const asMarkdown = boolFlag(flags, 'markdown')

  let messages: ChatMessage[]
  let selfDisplay = listFlag(flags, 'me', ['我'])[0]
  let friendDisplay: string

  if (file !== undefined) {
    const raw = readText(file)
    if (raw === null) throw new Error(`读不到文件：${file}`)
    const parsed = parseTranscript(raw, {
      source: 'manual',
      convId: 'inline',
      selfNames: [selfDisplay],
      ...(stringFlag(flags, 'friend') === undefined ? {} : { friendName: stringFlag(flags, 'friend') }),
    })
    if (parsed.messages.length === 0) throw new Error('没解析出任何消息，先跑 `speakers --file` 看看。')
    messages = parsed.messages
    selfDisplay = parsed.speakers.find((speaker) => speaker.role === 'self')?.name ?? selfDisplay
    friendDisplay = parsed.speakers.find((speaker) => speaker.role === 'friend')?.name ?? '他'
  } else if (name !== undefined) {
    messages = readJsonl<ChatMessage>(dataPath(`${name}.jsonl`))
    if (messages.length === 0) throw new Error(`data/${name}.jsonl 是空的。先跑 ingest --file <原始文本> --persona ${name}`)
    const speakers = new Map<string, { role: string; count: number }>()
    for (const message of messages) {
      const entry = speakers.get(message.senderName) ?? { role: message.role, count: 0 }
      entry.count += 1
      speakers.set(message.senderName, entry)
    }
    selfDisplay = [...speakers].find(([, info]) => info.role === 'self')?.[0] ?? selfDisplay
    friendDisplay = [...speakers].find(([, info]) => info.role === 'friend')?.[0] ?? '他'
  } else {
    throw new Error('用法：stats --persona <名字> 或 stats --file <原始文本>')
  }

  const stats = computeStats(messages)
  const block = renderStyleBlock(stats, { self: selfDisplay, friend: friendDisplay })

  if (asMarkdown && name !== undefined) {
    writeText(personaPath(name, 'style.md'), block + '\n')
    console.log(`已写入 personas/${name}/style.md`)
  }
  console.log(block)
  console.log('\n--- 详细 ---')
  console.log(detail(stats))
}
