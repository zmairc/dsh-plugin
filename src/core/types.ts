/**
 * Core data model shared by every importer, the distillation pipeline, and the
 * runtime.
 *
 * `ChatMessage` is the internal format. Platform exporters are normalized into
 * it once, at import; nothing downstream re-parses a platform layout.
 */

/** Which platform a message was copied from. */
export type Source = 'wechat' | 'qq' | 'douyin' | 'manual'

/**
 * Who sent a message, relative to the owner of the archive.
 *
 * `self` is the archive owner, `friend` is the person being distilled, and
 * `other` is anyone else present in a group conversation. Distillation ignores
 * `other` because their voice would contaminate the persona.
 */
export type Role = 'self' | 'friend' | 'other'

/** What a message carries. Non-text kinds still shape the persona. */
export type MessageKind =
  | 'text'
  | 'sticker'
  | 'image'
  | 'voice'
  | 'video'
  | 'link'
  | 'share'
  | 'redpacket'
  | 'call'
  | 'system'
  | 'recall'

/** One normalized message. */
export interface ChatMessage {
  /** Format version, so a later migration can recognize old archives. */
  v: 1
  /** `${source}:${nativeId}`; unique within an archive. */
  id: string
  /** Conversation the message belongs to. */
  convId: string
  source: Source
  role: Role
  /** Display name as it appeared in the transcript. */
  senderName: string
  /** Epoch milliseconds. */
  ts: number
  kind: MessageKind
  /** Message text, with media placeholders removed. Absent for media-only messages. */
  text?: string
  /** Content hash or path of the underlying media, used to cluster stickers. */
  mediaRef?: string
  /** Id of the message this one replies to, when the platform records it. */
  replyTo?: string
  /** Untouched platform record, so information is never lost at import. */
  platformRaw?: unknown
}

/** How a transcript turned out to be laid out. */
export type ParseStrategy = 'bracket' | 'block' | 'header-pair' | 'prefix' | 'blob'

/** Result of parsing one pasted transcript. */
export interface ParseResult {
  messages: ChatMessage[]
  /** Every speaker name seen, with message counts, for `--me` selection. */
  speakers: Array<{ name: string; role: Role; count: number }>
  /** Which layout matched; `blob` means nothing matched and all text became one voice. */
  strategy: ParseStrategy
  /** True when no timestamps were present and one-second spacing was synthesized. */
  syntheticTimestamps: boolean
}
