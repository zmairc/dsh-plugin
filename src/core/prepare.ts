/**
 * Transcript preparation: turn a raw chat export into the file `forge` can read
 * without hand editing.
 *
 * Each edit here used to be a one-off PowerShell step, and forgetting one of
 * them silently corrupted the persona:
 *
 * - the export labels the owner `我`, which `forge` then has to treat as a
 *   display name (`--me 吴文哲 --friend 赵明` plus a `我：…` transcript reads
 *   backwards inside the draft);
 * - standalone exporters put `media/00001_xxx.jpg` on its own line, which the
 *   phrase statistics turn into `medi(115) ia(116)`;
 * - attachment names carry a real student id and a real name.
 */

import { MEDIA_LINE, mediaPathKind } from './parse.ts'
import { redactCounted } from './redact.ts'

/** What one prepare run changed. */
export interface PrepareResult {
  /** The cleaned transcript, ready to write or feed straight to `forge`. */
  text: string
  /** Speaker headers rewritten from the export label to the display name. */
  renamedHeaders: number
  /** Media path lines replaced with `[图片]` / `[视频]` / `[语音]` / `[文件]`. */
  mediaLines: number
  /** Phone numbers, ids, emails, and links masked. */
  redacted: number
  /** Speaker labels seen in the export, in order of appearance. */
  speakers: string[]
}

/** Options for {@link prepareTranscript}. */
export interface PrepareOptions {
  /** Label the export uses for the owner, usually `我`. */
  selfLabel: string
  /** Name to write instead; same as `selfLabel` disables renaming. */
  selfName: string
  /** Mask phone numbers, ids, student ids, emails, and links. */
  redact: boolean
}

/** Placeholder per media kind, matching what the parser already understands. */
const PLACEHOLDER: Record<string, string> = {
  image: '[图片]',
  video: '[视频]',
  voice: '[语音]',
  sticker: '[表情]',
  call: '[通话]',
  link: '[文件]',
}

/**
 * A speaker header at the start of a line: `[22:32:24] 我:` or
 * `[22:32:24] 我: 内容`. Group 2 is the name, group 3 the colon.
 */
const BRACKET_HEADER = /^(\s*\[[^\]]*\]\s*)([^：:\n]{1,40})([：:])/

/** A line that could be the timestamp half of a `name` / `timestamp` pair. */
const TIME_LINE = /^\s*(?:\d{4}[-/年]\d{1,2}[-/月]\d{1,2}.*|\d{1,2}:\d{2}(?::\d{2})?)\s*$/

/** Compute the default output path, `<name>.prepared.txt` beside the input. */
export function preparedPath(file: string): string {
  return `${file.replace(/\.(?:txt|text)$/i, '')}.prepared.txt`
}

/**
 * Clean a raw export.
 * @param raw - the export file contents.
 * @param options - owner label, display name, and whether to mask ids.
 * @returns the cleaned text plus what changed.
 */
export function prepareTranscript(raw: string, options: PrepareOptions): PrepareResult {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const lines = raw.split(eol)
  const speakers: string[] = []
  let renamedHeaders = 0
  let mediaLines = 0

  const renamed = options.selfName.trim().length > 0 && options.selfName !== options.selfLabel

  const output = lines.map((line, index) => {
    const trimmed = line.trim()
    // A whole line of export media metadata never reaches the conversation:
    // replacing it keeps the message slot (so counts and bursts stay right)
    // while dropping the filename, which is where ids and names hide.
    if (MEDIA_LINE.test(trimmed)) {
      mediaLines += 1
      return `${line.slice(0, line.length - line.trimStart().length)}${PLACEHOLDER[mediaPathKind([trimmed])] ?? '[文件]'}`
    }

    const bracket = BRACKET_HEADER.exec(line)
    if (bracket !== null) {
      const name = bracket[2].trim()
      if (name.length > 0 && !speakers.includes(name)) speakers.push(name)
      if (renamed && name === options.selfLabel) {
        renamedHeaders += 1
        return `${bracket[1]}${options.selfName}${bracket[3]}${line.slice(bracket[0].length)}`
      }
      return line
    }

    // The header-pair layout puts the name alone on a line, followed by a
    // timestamp. Requiring the timestamp keeps a one-word message `我` intact.
    if (renamed && trimmed === options.selfLabel) {
      const next = lines[index + 1]
      if (next !== undefined && TIME_LINE.test(next)) {
        renamedHeaders += 1
        return line.replace(options.selfLabel, options.selfName)
      }
    }
    return line
  }).join(eol)

  // Speaker names are not masked: `forge` still needs them to tell the two
  // sides apart, and the persona keeps working with names.
  const masked = options.redact ? redactCounted(output) : { text: output, hits: 0 }
  return {
    text: masked.text,
    renamedHeaders,
    mediaLines,
    redacted: masked.hits,
    speakers,
  }
}
