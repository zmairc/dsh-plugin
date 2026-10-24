/**
 * One-shot pipeline: a pasted transcript file in, a persona pack out.
 *
 * This is the path an open-source user takes — drop one txt in, call once, get
 * a persona — so it depends on nothing being prepared by hand. The CLI `forge`
 * command and the MCP server are both thin wrappers around `forgePersona`.
 */

import type { ChatMessage, Source } from './types.ts'
import { parseTranscript, splitHoldout } from './parse.ts'
import { redact } from './redact.ts'
import { computeStats, pickLongExample, renderSpeechRules, renderStyleBlock } from './stats.ts'
import { annotateCatchphrases, buildChunks, consolidateObservations, observeChunks, renderDraft, verifyEvidence, verifySamples } from './distill.ts'
import type { LlmConfig, LlmUsage } from './llm.ts'
import { readUsage, resetUsage } from './llm.ts'
import { dataPath, exists, personaPath, readText, writeJsonl, writeText } from './archive.ts'

/** Everything one forge run needs. */
export interface ForgeOptions {
  /** Path to the pasted transcript. */
  file: string
  /** Persona directory name, also the archive name. */
  persona: string
  /** Display names that count as the owner. */
  selfNames: string[]
  /** Display name of the person being distilled; defaults to the most frequent non-owner. */
  friendName?: string
  /** Name the generated persona should use; defaults to the transcript label. */
  display?: string
  source: Source
  holdoutRatio: number
  redact: boolean
  /** Messages per model call. */
  chunkSize: number
  /** Cap on processed chunks; 0 means every chunk. */
  maxChunks: number
  /** When set, evenly keep this many chunks instead of processing all of them. */
  sample?: number
  /** Keep only the last N months of the archive; 0 or absent means everything. */
  recentMonths?: number
  config: LlmConfig
  onProgress: (message: string) => void
}

/** What a forge run produced. */
export interface ForgeResult {
  persona: string
  friend: string
  self: string
  total: number
  train: number
  holdout: number
  chunks: number
  processed: number
  failed: number
  personaFile: string
  styleFile: string
  /** Files that already existed and were saved to `<name>.prev.<ext>`. */
  backups: string[]
  /** True when the run wrote `persona.sample.md` instead of `persona.md`. */
  sampled: boolean
  /** Tokens and calls this run spent, so a large pass has a visible bill. */
  usage: LlmUsage
  /** Set when the run only used the most recent months. */
  recentMonths?: number
  /** Messages left out by the recency window. */
  droppedByRecent: number
}

/** Days per month for the recency window; 30 is close enough and predictable. */
const DAYS_PER_MONTH = 30

/**
 * Keep only the most recent `months` of an archive.
 *
 * Style drifts. Over two years this project's own archive went from 16.5 to
 * 11.6 characters a message and from 7.7% to 4.4% full stops, while the median
 * stayed at 7. A persona forged from everything averages those two people
 * together, and the average of two people is nobody.
 * @param messages - archived messages, sorted by time.
 * @param months - how far back to keep; a non-positive value keeps everything.
 * @returns the kept messages.
 */
export function filterRecent(messages: readonly ChatMessage[], months: number): ChatMessage[] {
  if (messages.length === 0 || months <= 0) return [...messages]
  const last = messages[messages.length - 1].ts
  const cutoff = last - months * DAYS_PER_MONTH * 24 * 60 * 60 * 1000
  return messages.filter((message) => message.ts >= cutoff)
}

/**
 * Copy an existing output to `<name>.prev.<ext>` before it is overwritten.
 *
 * A forge run rewrites `persona.md`, `style.md`, and `transcript.txt` in the
 * persona directory. Only the first used to be backed up, so rerunning silently
 * destroyed a hand-written style block or the cleaned source transcript.
 * @param path - the file about to be written.
 * @returns the backup path, or null when there was nothing to back up.
 */
export function backupFile(path: string): string | null {
  const previous = readText(path)
  if (previous === null) return null
  const backup = path.replace(/(\.[a-z0-9]+)$/i, '.prev$1')
  writeText(backup, previous)
  return backup
}

/**
 * Evenly pick `count` items across a list, keeping the original order.
 * Sampling across the whole archive preserves different topics and moods,
 * unlike taking the first N chunks, which is one stretch of one month.
 * @param items - source list.
 * @param count - how many to keep; values >= the length keep everything.
 * @returns the sampled items.
 */
export function sampleEvenly<T>(items: readonly T[], count: number): T[] {
  if (count >= items.length || count < 1) return [...items]
  const picked: T[] = []
  const step = items.length / count
  for (let index = 0; index < count; index += 1) {
    picked.push(items[Math.min(items.length - 1, Math.floor(index * step))])
  }
  return picked
}

/** Validate a persona name before it becomes a directory. */
export function assertSafePersonaName(name: string): void {
  if (!/^[\w-]+$/.test(name)) {
    throw new Error(`人设名只能包含字母、数字、下划线、短横线，收到 ${name}`)
  }
}

/**
 * Run the whole pipeline for one transcript.
 * @param options - input file, naming, model settings, and sampling budget.
 * @returns a summary of what was written and how much of the archive was covered.
 */
export async function forgePersona(options: ForgeOptions): Promise<ForgeResult> {
  assertSafePersonaName(options.persona)
  // One forge run is one spending session; the caller reads the bill at the end.
  resetUsage()

  const raw = readText(options.file)
  if (raw === null) throw new Error(`读不到文件：${options.file}`)

  const parsed = parseTranscript(raw, {
    source: options.source,
    convId: options.persona,
    selfNames: options.selfNames,
    ...(options.friendName === undefined ? {} : { friendName: options.friendName }),
  })
  if (parsed.messages.length === 0) {
    throw new Error('没解析出任何消息。先跑 `speakers --file <同一个文件>` 看看识别到了谁。')
  }

  const friendSpeaker = parsed.speakers.find((speaker) => speaker.role === 'friend')
  const selfSpeaker = parsed.speakers.find((speaker) => speaker.role === 'self')
  if (friendSpeaker === undefined) {
    throw new Error('没认出要模仿的人。用 --friend 指定，或者先用 speakers 看识别到了谁。')
  }
  const friendDisplay = options.display ?? friendSpeaker.name
  const selfDisplay = selfSpeaker?.name ?? options.selfNames[0] ?? '我'

  let messages: ChatMessage[] = parsed.messages
  const recentMonths = options.recentMonths ?? 0
  let droppedByRecent = 0
  if (recentMonths > 0) {
    const kept = filterRecent(messages, recentMonths)
    droppedByRecent = messages.length - kept.length
    if (kept.length < 100) {
      throw new Error(`只保留最近 ${recentMonths} 个月后只剩 ${kept.length} 条，太少。换个小一点的月数，或者去掉 --recent。`)
    }
    const friendLeft = kept.filter((message) => message.role === 'friend').length
    const selfLeft = kept.filter((message) => message.role === 'self').length
    if (friendLeft === 0 || selfLeft === 0) {
      throw new Error('这个时间窗口里只有一个人在说话，没法蒸馏。换个大一点的月数。')
    }
    messages = kept
    options.onProgress(`只保留最近 ${recentMonths} 个月：${kept.length} 条（丢弃 ${droppedByRecent} 条更早的）\n`)
  }
  if (options.redact) {
    messages = messages.map((message) => ({
      ...message,
      ...(message.text === undefined ? {} : { text: redact(message.text, parsed.speakers.map((speaker) => speaker.name)) }),
    }))
  }

  const { train, holdout } = splitHoldout(messages, options.holdoutRatio)
  writeJsonl(dataPath(`${options.persona}.jsonl`), train)
  writeJsonl(dataPath(`${options.persona}.holdout.jsonl`), holdout)

  // Everything written below is overwritten in place on a rerun, so each file
  // gets a `.prev` copy first and the caller can report what was replaced.
  const backups: string[] = []
  const backup = (path: string): void => {
    const saved = backupFile(path)
    if (saved !== null) backups.push(saved)
  }

  // Use the person's own name rather than "you": inside one persona file "你"
  // means the person being played, and this block used to also mean the wisher.
  const stats = computeStats(train)
  const styleBlock = renderStyleBlock(stats, { self: selfDisplay, friend: friendDisplay })
  // Measured habits turned into rules, rendered at the top of the persona.
  const rules = renderSpeechRules(stats, pickLongExample(train, stats.length.p90))
  const styleFile = personaPath(options.persona, 'style.md')
  backup(styleFile)
  writeText(styleFile, styleBlock + '\n')
  // Keep the source next to the persona so a rerun needs no external file.
  const transcriptFile = personaPath(options.persona, 'transcript.txt')
  backup(transcriptFile)
  writeText(transcriptFile, raw)

  const allChunks = buildChunks(train, options.chunkSize)
  if (allChunks.length === 0) throw new Error('没有可用的对话块，记录可能全是媒体消息。')

  let selected = allChunks
  if (options.sample !== undefined && options.sample > 0) selected = sampleEvenly(selected, options.sample)
  if (options.maxChunks > 0 && selected.length > options.maxChunks) selected = selected.slice(0, options.maxChunks)

  let merged = await observeChunks(
    options.config,
    selected,
    { self: selfDisplay, friend: friendSpeaker.name, display: friendDisplay },
    {
      chunkSize: options.chunkSize,
      maxChunks: selected.length,
      onProgress: options.onProgress,
    },
  )
  // Unsampled chunks are unprocessed, not failed, but they still lower the
  // confidence of the result, so they count against coverage.
  merged.failedChunks += allChunks.length - selected.length
  merged.totalChunks = allChunks.length

  if (merged.failedChunks === merged.totalChunks) {
    throw new Error('所有块都失败了，没有可用的观察结果。检查接口配置和 key 后重试。')
  }

  merged = await consolidateObservations(options.config, merged, { onProgress: options.onProgress })
  merged.samples = verifySamples(merged.samples, train)
  // Trait evidence gets the same speaker check as the samples: a quote that
  // belongs to the other person means the trait describes the wrong person.
  merged.traits = verifyEvidence(merged.traits, train)
  merged.avoid = verifyEvidence(merged.avoid, train)
  merged.catchphrases = annotateCatchphrases(merged.catchphrases, train)

  const draft = renderDraft({ name: friendDisplay, styleBlock, merged, stats, rules })
  const personaFile = personaPath(options.persona, 'persona.md')
  // A sampled run is a speed test, not a persona. Writing it over the real file
  // would hand `chat_persona` a thin draft without anyone noticing, so an
  // existing persona keeps its name and the sample lands beside it.
  const sampled = options.sample !== undefined && options.sample > 0 && exists(personaFile)
  const draftFile = sampled ? personaPath(options.persona, 'persona.sample.md') : personaFile
  backup(draftFile)
  writeText(draftFile, draft)

  return {
    persona: options.persona,
    friend: friendDisplay,
    self: selfDisplay,
    total: messages.length,
    train: train.length,
    holdout: holdout.length,
    chunks: allChunks.length,
    processed: selected.length,
    failed: merged.failedChunks,
    personaFile: draftFile,
    styleFile,
    backups,
    sampled,
    usage: readUsage(),
    ...(recentMonths > 0 ? { recentMonths } : {}),
    droppedByRecent,
  }
}
