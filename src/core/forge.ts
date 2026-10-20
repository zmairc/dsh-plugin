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
import { computeStats, renderStyleBlock } from './stats.ts'
import { annotateCatchphrases, buildChunks, consolidateObservations, observeChunks, renderDraft, verifySamples } from './distill.ts'
import type { LlmConfig } from './llm.ts'
import { dataPath, personaPath, readText, writeJsonl, writeText } from './archive.ts'

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
  if (options.redact) {
    messages = messages.map((message) => ({
      ...message,
      ...(message.text === undefined ? {} : { text: redact(message.text, parsed.speakers.map((speaker) => speaker.name)) }),
    }))
  }

  const { train, holdout } = splitHoldout(messages, options.holdoutRatio)
  writeJsonl(dataPath(`${options.persona}.jsonl`), train)
  writeJsonl(dataPath(`${options.persona}.holdout.jsonl`), holdout)

  const styleBlock = renderStyleBlock(computeStats(train), { self: '你', friend: friendDisplay })
  writeText(personaPath(options.persona, 'style.md'), styleBlock + '\n')
  // Keep the source next to the persona so a rerun needs no external file.
  writeText(personaPath(options.persona, 'transcript.txt'), raw)

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
  merged.catchphrases = annotateCatchphrases(merged.catchphrases, train)

  const draft = renderDraft({ name: friendDisplay, styleBlock, merged })
  const personaFile = personaPath(options.persona, 'persona.md')
  const previous = readText(personaFile)
  if (previous !== null) writeText(personaPath(options.persona, 'persona.prev.md'), previous)
  writeText(personaFile, draft)

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
    personaFile,
    styleFile: personaPath(options.persona, 'style.md'),
  }
}
