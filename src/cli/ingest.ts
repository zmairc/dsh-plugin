/**
 * `ingest`: parse a pasted transcript into a normalized archive.
 *
 * The command also writes the style fingerprint and, when no persona file
 * exists yet, a skeleton `persona.md` with the fingerprint already embedded, so
 * the user starts editing prose instead of starting from an empty buffer.
 */

import { parseTranscript, splitHoldout } from '../core/parse.ts'
import type { ChatMessage, Source } from '../core/types.ts'
import { redact } from '../core/redact.ts'
import { computeStats, renderStyleBlock } from '../core/stats.ts'
import { dataPath, exists, personaPath, readText, writeJsonl, writeText } from '../core/archive.ts'
import { boolFlag, listFlag, numberFlag, stringFlag, type Flags } from './args.ts'

const SOURCES: readonly Source[] = ['wechat', 'qq', 'douyin', 'manual']

/** Build the editable persona skeleton around the measured fingerprint. */
function personaSkeleton(name: string, friend: string, styleBlock: string): string {
  return `# ${friend}

> 由 \`ingest\` 生成的骨架。把括号里的提示换成你真实的判断，写不对的行直接删。
> 写完执行 \`node src/cli/index.ts chat --persona ${name}\` 试效果。

## 你是谁

（一句话定位：他做什么工作、多大、和我什么关系）

## 你和我

（怎么认识的、现在什么状态、他叫我什么、谁更主动、多久见一次）

## 说话方式

（下面这份是统计出来的，改成人话，删掉和直觉不符的。写具体的约束，别写"他很幽默"这种评价。）

${styleBlock}

## 你常聊的

-

## 你的观点

（对工作、感情、钱的看法。写立场，不写话题名。）

-

## 绝对不要

- 不要写成段落或分点，像发微信一样短
- 不要解释你在模仿谁，也不要说自己是 AI
- 不要用书面语，不要用"哈哈"敷衍
- 不要替对方把话说完

## 不知道的事

（他会承认不知道，还是硬编？被问到敏感话题时他怎么岔开？）
`
}

/**
 * Run the ingest command.
 * @param flags - parsed CLI flags for this command.
 */
export function runIngest(flags: Flags): void {
  const file = stringFlag(flags, 'file')
  const name = stringFlag(flags, 'persona')
  if (file === undefined || name === undefined) {
    throw new Error('用法：ingest --file <原始文本> --persona <名字> [--me 我] [--friend 他]')
  }
  const raw = readText(file)
  if (raw === null) throw new Error(`读不到文件：${file}`)

  const sourceFlag = stringFlag(flags, 'source') ?? 'manual'
  if (!SOURCES.includes(sourceFlag as Source)) {
    throw new Error(`--source 只能是 ${SOURCES.join(' / ')}`)
  }
  const source = sourceFlag as Source

  const selfNames = listFlag(flags, 'me', ['我'])
  const friendName = stringFlag(flags, 'friend')
  const holdoutRatio = numberFlag(flags, 'holdout', 0.1)
  const doRedact = boolFlag(flags, 'redact')

  const parsed = parseTranscript(raw, {
    source,
    convId: name,
    selfNames,
    ...(friendName === undefined ? {} : { friendName }),
  })
  if (parsed.messages.length === 0) {
    throw new Error('没解析出任何消息。先跑 `speakers --file <同一个文件>` 看看识别到了谁。')
  }

  const friendSpeaker = parsed.speakers.find((speaker) => speaker.role === 'friend')
  const friendDisplay = friendSpeaker?.name ?? friendName ?? name
  const selfDisplay = parsed.speakers.find((speaker) => speaker.role === 'self')?.name ?? selfNames[0] ?? '我'

  let messages: ChatMessage[] = parsed.messages
  if (doRedact) {
    messages = messages.map((message) => ({
      ...message,
      ...(message.text === undefined ? {} : { text: redact(message.text, parsed.speakers.map((speaker) => speaker.name)) }),
    }))
  }

  const { train, holdout } = splitHoldout(messages, holdoutRatio)
  writeJsonl(dataPath(`${name}.jsonl`), train)
  writeJsonl(dataPath(`${name}.holdout.jsonl`), holdout)

  const transcriptPath = personaPath(name, 'transcript.txt')
  if (!exists(transcriptPath)) writeText(transcriptPath, raw)

  const stats = computeStats(train)
  const styleBlock = renderStyleBlock(stats, { self: selfDisplay, friend: friendDisplay })
  writeText(personaPath(name, 'style.md'), styleBlock + '\n')

  const personaFile = personaPath(name, 'persona.md')
  const createdPersona = !exists(personaFile)
  if (createdPersona) writeText(personaFile, personaSkeleton(name, friendDisplay, styleBlock))

  console.log(`解析布局：${parsed.strategy}${parsed.syntheticTimestamps ? '（没有时间戳，已按顺序合成）' : ''}`)
  console.log('说话人：')
  for (const speaker of parsed.speakers) {
    console.log(`  ${speaker.name}  ${speaker.count} 条  → ${speaker.role}`)
  }
  console.log(`\n纳入 ${messages.length} 条（他 ${stats.counts.friend} / 你 ${stats.counts.self}）`)
  console.log(`留出 ${holdout.length} 条用于评测，不参与人设构建`)
  console.log(`\n写出：`)
  console.log(`  data/${name}.jsonl`)
  console.log(`  data/${name}.holdout.jsonl`)
  console.log(`  personas/${name}/style.md`)
  console.log(`  personas/${name}/persona.md${createdPersona ? '（新建骨架，去填内容）' : '（已存在，未覆盖）'}`)

  const others = parsed.speakers.filter((speaker) => speaker.role === 'other')
  if (others.length > 0) {
    console.log(`\n警告：${others.length} 个说话人被标为 other，不会参与人设。如果那是他，用 --friend 指定。`)
  }
  if (createdPersona) {
    console.log(`\n下一步：编辑 personas/${name}/persona.md，然后 chat --persona ${name}`)
  }
}

/**
 * Run the `speakers` command: report detected speakers without writing anything.
 * @param flags - parsed CLI flags for this command.
 */
export function runSpeakers(flags: Flags): void {
  const file = stringFlag(flags, 'file')
  if (file === undefined) throw new Error('用法：speakers --file <原始文本>')
  const raw = readText(file)
  if (raw === null) throw new Error(`读不到文件：${file}`)

  const parsed = parseTranscript(raw, {
    source: 'manual',
    convId: 'inspect',
    selfNames: listFlag(flags, 'me', ['我']),
  })
  console.log(`布局：${parsed.strategy}`)
  console.log(`消息：${parsed.messages.length}`)
  console.log('说话人：')
  for (const speaker of parsed.speakers) {
    console.log(`  ${speaker.name}  ${speaker.count} 条  → ${speaker.role}`)
  }
  console.log('\n用 --me <名字> 指定你自己，用 --friend <名字> 指定要模仿的人。')
}
