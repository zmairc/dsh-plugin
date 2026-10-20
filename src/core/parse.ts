/**
 * Lenient parser for pasted chat transcripts.
 *
 * No two export tools produce identical text, so this module tries every known
 * layout and keeps whichever yields the most messages, reporting the winner so
 * a surprise is visible instead of silent. Callers receive normalized
 * `ChatMessage` records; nothing downstream re-parses platform text.
 */

import type { ChatMessage, MessageKind, ParseResult, ParseStrategy, Role, Source } from './types.ts'

/**
 * Media placeholder tokens, longest first. WeChat and QQ render media as
 * bracketed text when copied.
 */
const PLACEHOLDER_KINDS: ReadonlyArray<readonly [string, MessageKind]> = [
  ['撤回了一条消息', 'recall'],
  ['语音通话', 'call'],
  ['聊天记录', 'link'],
  ['动画表情', 'sticker'],
  ['微信红包', 'redpacket'],
  ['位置信息', 'share'],
  ['系统消息', 'system'],
  ['图片', 'image'],
  ['照片', 'image'],
  ['Photo', 'image'],
  ['表情', 'sticker'],
  ['Sticker', 'sticker'],
  ['语音', 'voice'],
  ['Voice', 'voice'],
  ['视频', 'video'],
  ['Video', 'video'],
  ['链接', 'link'],
  ['文件', 'link'],
  ['File', 'link'],
  ['位置', 'share'],
  ['分享', 'share'],
  ['红包', 'redpacket'],
  ['转账', 'redpacket'],
  ['撤回', 'recall'],
]

/** Export tools leave the underlying filename beside a media placeholder. */
const MEDIA_FILE = /^(?:微信图片|微信视频|微信语音|微信文件|mmexport|wx_camera_|wxid_)[\w.-]*$|^\S+\.(?:dat|jpg|jpeg|png|gif|webp|mp4|mov|amr|silk)$/i

/** A placeholder's trailing token that carries no words: a duration or a bare digit. */
const MEDIA_TRIVIA = /^[\d\s."'秒]+$/

/** Whether the leftover text beside a media placeholder is export noise rather than content. */
function isMediaNoise(text: string, kind: MessageKind | null): boolean {
  if (kind === null) return false
  if (kind !== 'image' && kind !== 'video' && kind !== 'voice' && kind !== 'sticker' && kind !== 'call') return false
  const trimmed = text.trim()
  if (trimmed.length === 0) return true
  return MEDIA_FILE.test(trimmed) || MEDIA_TRIVIA.test(trimmed)
}

/** Platform notices that carry no conversational content. */
const SYSTEM_TEXT = /^(收到转账|如需收钱|请点此升级|你已添加|以上是打招呼|对方已|拍了拍|你撤回)/

/** Placeholder-safe body classifier: a body that is only placeholders keeps their kind. */
function classifyBody(raw: string): { kind: MessageKind; text?: string } {
  let rest = raw
  let mediaKind: MessageKind | null = null
  for (const [token, kind] of PLACEHOLDER_KINDS) {
    for (const form of [`[${token}]`, `【${token}】`]) {
      if (rest.includes(form)) {
        rest = rest.split(form).join('')
        mediaKind ??= kind
      }
    }
  }
  const trimmed = rest.trim()
  if (trimmed.length === 0) return mediaKind ? { kind: mediaKind } : { kind: 'text' }
  // A filename next to `[图片]` describes the export, not the conversation.
  if (isMediaNoise(trimmed, mediaKind)) return { kind: mediaKind as MessageKind }
  // Transfer notices are part of the platform, not something anyone said.
  if (SYSTEM_TEXT.test(trimmed)) return { kind: 'system' }
  return { kind: 'text', text: trimmed }
}

interface DateParts {
  y: number
  mo: number
  d: number
}

const FULL_STAMP = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?\s+(\d{1,2})\s*[:：]\s*(\d{2})(?:\s*[:：]\s*(\d{2}))?/
const TIME_ONLY = /(\d{1,2})\s*[:：]\s*(\d{2})(?:\s*[:：]\s*(\d{2}))?/

/** Locate a `YYYY-MM-DD HH:mm[:ss]` stamp on a line. */
function findFullStamp(line: string): { ts: number; date: DateParts; start: number; end: number } | null {
  const m = FULL_STAMP.exec(line)
  if (!m) return null
  const date: DateParts = { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) }
  const ts = new Date(date.y, date.mo - 1, date.d, Number(m[4]), Number(m[5]), m[6] ? Number(m[6]) : 0).getTime()
  return { ts, date, start: m.index, end: m.index + m[0].length }
}

/** Locate a bare `HH:mm[:ss]` on a line, using the carried date for the day. */
function findTimeOnly(line: string, carry: DateParts | null): { ts: number; start: number; end: number } | null {
  if (carry === null) return null
  const m = TIME_ONLY.exec(line)
  if (!m) return null
  const ts = new Date(carry.y, carry.mo - 1, carry.d, Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : 0).getTime()
  return { ts, start: m.index, end: m.index + m[0].length }
}

/** Whether the whole line is nothing but a timestamp, optionally bracketed. */
function isStampLine(line: string): boolean {
  const trimmed = line.trim()
  const stamp = findFullStamp(trimmed)
  if (stamp === null) return false
  const around = (trimmed.slice(0, stamp.start) + trimmed.slice(stamp.end)).replace(/[\s[\]()（）【】]/g, '')
  return around.length === 0
}

/** Strip wrapping brackets and whitespace from a would-be speaker name. */
function cleanName(candidate: string): string {
  return candidate.replace(/^[\s[(（【]+/, '').replace(/[\s\])）】:：,，]+$/, '').trim()
}

/** A name is plausible when short, non-empty, and free of sentence punctuation. */
function isPlausibleName(candidate: string): boolean {
  if (candidate.length === 0 || candidate.length > 24) return false
  if (/[。，！？、；]/.test(candidate)) return false
  if (/^\d+$/.test(candidate)) return false
  return true
}

interface RawEntry {
  name: string | null
  ts: number | null
  body: string
}

/**
 * Block layout: a header line carries the speaker and timestamp, and body
 * lines follow until the next header.
 *
 *    老王  2024-03-15 21:08:12
 *    在吗
 *
 * A timestamp with no name beside it is a date separator, not a speaker.
 */
function parseBlock(lines: string[]): RawEntry[] {
  const entries: RawEntry[] = []
  let current: RawEntry | null = null
  let carry: DateParts | null = null

  const flush = (): void => {
    if (current !== null) entries.push(current)
    current = null
  }

  for (const line of lines) {
    const full = findFullStamp(line)
    if (full) {
      const before = cleanName(line.slice(0, full.start))
      const after = cleanName(line.slice(full.end))
      // A header has exactly one side populated; two sides means the stamp is
      // part of the message body, not a header.
      const oneSided = before.length === 0 || after.length === 0
      const name = oneSided ? (after.length > 0 ? after : before) : ''
      if (oneSided && name.length > 0 && isPlausibleName(name)) {
        carry = full.date
        flush()
        current = { name, ts: full.ts, body: '' }
        continue
      }
      if (oneSided && name.length === 0) {
        // Bare date separator: it moves the clock and ends the message above.
        carry = full.date
        flush()
        continue
      }
    }
    if (current === null) {
      // Text before the first header is a title or export banner, not a
      // message; keeping it would create a phantom speaker.
      continue
    }
    current.body += (current.body.length > 0 ? '\n' : '') + line
  }
  flush()
  return entries
}

/**
 * Paired-header layout: the speaker sits on its own line and the timestamp on
 * the next one. WeChat's multi-select copy produces this.
 *
 *    dennis
 *    2026年08月24日  7:46
 *    我操，这么牛逼。
 */
function parseHeaderPair(lines: string[]): RawEntry[] {
  const nonEmpty = lines.map((line) => line.trim()).filter((line) => line.length > 0)
  const entries: RawEntry[] = []
  let index = 0
  while (index < nonEmpty.length) {
    const nameLine = nonEmpty[index]
    const stamp = index + 1 < nonEmpty.length && isStampLine(nonEmpty[index + 1])
      ? findFullStamp(nonEmpty[index + 1])
      : null
    if (stamp === null || isStampLine(nameLine) || !isPlausibleName(cleanName(nameLine))) {
      index += 1
      continue
    }
    const body: string[] = []
    let cursor = index + 2
    while (cursor < nonEmpty.length) {
      const candidate = nonEmpty[cursor]
      const nextIsHeader = cursor + 1 < nonEmpty.length && isStampLine(nonEmpty[cursor + 1])
      if (!isStampLine(candidate) && nextIsHeader) break
      body.push(candidate)
      cursor += 1
    }
    entries.push({ name: cleanName(nameLine), ts: stamp.ts, body: body.join('\n') })
    index = cursor
  }
  return entries
}

const PREFIX_LINE = /^(.{1,24}?)\s*[:：]\s*(.*)$/

/** `[HH:mm:ss] 名字:` header, body on the next indented line(s). */
const BRACKET_HEADER = /^\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]\s*(.{1,24}?)[:：]\s?(.*)$/

/** `---------- 2024-09-25 ----------` date separator. */
const DATE_SECTION = /^-{2,}\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s*-{2,}$/

/**
 * Bracket layout: a date separator, then `[HH:mm:ss] 名字:` with the body on
 * the following indented line. This is what a standalone exporter produces.
 *
 *     ---------- 2024-09-25 ----------
 *
 *     [22:32:24] 老王:
 *         在吗
 */
function parseBracket(lines: string[]): RawEntry[] {
  const entries: RawEntry[] = []
  let carry: DateParts | null = null
  let current: RawEntry | null = null

  const flush = (): void => {
    if (current !== null) entries.push(current)
    current = null
  }

  for (const line of lines) {
    const trimmed = line.trim()

    const section = DATE_SECTION.exec(trimmed)
    if (section !== null) {
      carry = { y: Number(section[1]), mo: Number(section[2]), d: Number(section[3]) }
      flush()
      continue
    }

    const header = BRACKET_HEADER.exec(trimmed)
    if (header !== null) {
      const name = cleanName(header[4])
      if (!isPlausibleName(name)) continue
      flush()
      const ts = carry === null
        ? null
        : new Date(carry.y, carry.mo - 1, carry.d, Number(header[1]), Number(header[2]), header[3] === undefined ? 0 : Number(header[3])).getTime()
      current = { name, ts, body: header[5] ?? '' }
      continue
    }

    // Header lines before the first message (title, export banner) are ignored.
    if (current === null || trimmed.length === 0) continue
    current.body += (current.body.length > 0 ? '\n' : '') + trimmed
  }

  flush()
  return entries
}

/**
 * Inline layout: every line is `name: body`.
 *
 *    老王: 在吗
 */
function parsePrefix(lines: string[]): RawEntry[] {
  const candidates = new Map<string, number>()
  for (const line of lines) {
    const m = PREFIX_LINE.exec(line.trim())
    if (!m) continue
    const name = cleanName(m[1])
    if (!isPlausibleName(name)) continue
    candidates.set(name, (candidates.get(name) ?? 0) + 1)
  }
  // A name seen once in a long file is more likely prose than a speaker.
  const threshold = lines.length >= 20 ? 2 : 1
  const known = new Set([...candidates].filter(([, count]) => count >= threshold).map(([name]) => name))
  if (known.size === 0) return []

  const entries: RawEntry[] = []
  let carry: DateParts | null = null
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const full = findFullStamp(trimmed)
    if (full) carry = full.date
    const rest = full ? trimmed.slice(0, full.start) + trimmed.slice(full.end) : trimmed
    const m = PREFIX_LINE.exec(rest.trim())
    if (m) {
      const name = cleanName(m[1])
      if (known.has(name)) {
        entries.push({ name, ts: full ? full.ts : null, body: m[2] })
        continue
      }
    }
    if (entries.length > 0) entries[entries.length - 1].body += '\n' + trimmed
  }
  return entries
}

/** Nothing matched: treat the whole paste as one undivided voice. */
function parseBlob(text: string, defaultName: string): RawEntry[] {
  const paragraphs = text.split(/\n\s*\n/).flatMap((block) => block.split('\n'))
  return paragraphs
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => ({ name: defaultName, ts: null, body: line }))
}

/** Options for one transcript import. */
export interface ParseOptions {
  source: Source
  convId: string
  /** Names that belong to the archive owner. */
  selfNames: string[]
  /** Name of the person being distilled; omitted means "the most frequent non-self speaker". */
  friendName?: string
  /** Name used when the layout does not record one. */
  defaultName?: string
}

const SELF_ALIASES = /^(我|自己|本人|me|myself|self)$/i

/**
 * Parse a pasted transcript into normalized messages.
 * @param text - raw pasted transcript.
 * @param options - source, conversation id, and speaker hints.
 * @returns normalized messages, detected speakers, the winning layout, and whether timestamps were synthesized.
 */
export function parseTranscript(text: string, options: ParseOptions): ParseResult {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const defaultName = options.defaultName ?? '他'

  const attempts: Array<{ strategy: ParseStrategy; entries: RawEntry[] }> = [
    { strategy: 'bracket', entries: parseBracket(lines) },
    { strategy: 'header-pair', entries: parseHeaderPair(lines) },
    { strategy: 'block', entries: parseBlock(lines) },
    { strategy: 'prefix', entries: parsePrefix(lines) },
  ]
  const scored = attempts
    .map((attempt) => ({ ...attempt, score: attempt.entries.filter((entry) => entry.body.trim().length > 0).length }))
    .sort((a, b) => b.score - a.score)

  let strategy: ParseStrategy = scored[0].strategy
  let entries = scored[0].entries
  if (scored[0].score === 0) {
    strategy = 'blob'
    entries = parseBlob(text, defaultName)
  }

  const hasTimestamps = entries.some((entry) => entry.ts !== null)
  const counts = new Map<string, number>()
  for (const entry of entries) {
    const name = entry.name ?? defaultName
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }

  const selfNames = new Set(options.selfNames.map((name) => name.trim()).filter((name) => name.length > 0))
  const isSelf = (name: string): boolean => selfNames.has(name) || SELF_ALIASES.test(name)

  const friendName = options.friendName ?? (() => {
    let best: string | null = null
    let bestCount = -1
    for (const [name, count] of counts) {
      if (isSelf(name)) continue
      if (count > bestCount) {
        best = name
        bestCount = count
      }
    }
    return best ?? defaultName
  })()

  const roleOf = (name: string): Role => {
    if (isSelf(name)) return 'self'
    if (name === friendName) return 'friend'
    return 'other'
  }

  const messages: ChatMessage[] = []
  const seen = new Set<string>()
  let previousKey = ''
  let syntheticTs = Date.UTC(2000, 0, 1)
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    const name = entry.name ?? defaultName
    const classified = classifyBody(entry.body)
    if (classified.kind === 'text' && (classified.text ?? '').length === 0) continue

    const ts = entry.ts ?? (syntheticTs += 1000)
    const role = roleOf(name)
    // Media messages carry no content to compare, so several in one minute are
    // distinct messages, not a paste overlap.
    const key = classified.text === undefined ? null : `${role}|${ts}|${classified.text}`
    if (key !== null) {
      // Overlapping paste repeats a block away from itself; two identical
      // messages in the same minute are a real burst and must survive.
      if (key !== previousKey && seen.has(key)) continue
      seen.add(key)
      previousKey = key
    }

    messages.push({
      v: 1,
      id: `${options.source}:${index}`,
      convId: options.convId,
      source: options.source,
      role,
      senderName: name,
      ts,
      kind: classified.kind,
      ...(classified.text === undefined ? {} : { text: classified.text }),
    })
  }

  messages.sort((a, b) => a.ts - b.ts)

  const speakers = [...counts]
    .map(([name, count]) => ({ name, role: roleOf(name), count }))
    .sort((a, b) => b.count - a.count)

  return { messages, speakers, strategy, syntheticTimestamps: !hasTimestamps }
}

/** Split a transcript into the portion used for distillation and the held-out portion. */
export function splitHoldout(
  messages: ChatMessage[],
  ratio: number,
): { train: ChatMessage[]; holdout: ChatMessage[] } {
  if (ratio <= 0 || messages.length === 0) return { train: messages, holdout: [] }
  const cut = Math.max(1, Math.floor(messages.length * (1 - ratio)))
  return { train: messages.slice(0, cut), holdout: messages.slice(cut) }
}
