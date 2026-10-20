/**
 * Persona loading and system-prompt assembly shared by `chat` and `eval`.
 *
 * Two files make up a character, deliberately separated:
 * `persona.md` is how he talks, derived from transcripts; `lore.md` is who he
 * is — habits and facts that no transcript captures. Keeping them apart lets
 * the user add traits without risking the measured speaking style.
 */

import { personaPath, readText } from './archive.ts'

/** A loaded persona. */
export interface Persona {
  /** Display name, taken from the first Markdown heading of persona.md. */
  name: string
  /** How he talks. */
  body: string
  /** Who he is beyond the transcripts; null when the file does not exist. */
  lore: string | null
  /** Style fingerprint appended at load time, when the file exists. */
  style: string | null
}

/**
 * Load `personas/<name>/persona.md` plus optional `lore.md` and `style.md`.
 * @param name - persona identifier (the directory name).
 * @param fallbackName - display name used when the file has no `#` heading.
 * @returns the loaded persona.
 */
export function loadPersona(name: string, fallbackName: string = name): Persona {
  const body = readText(personaPath(name, 'persona.md'))
  if (body === null) {
    throw new Error(`找不到 personas/${name}/persona.md。先跑 ingest 生成骨架。`)
  }
  const heading = /^#\s+(.+)$/m.exec(body)
  return {
    name: heading === null ? fallbackName : heading[1].trim(),
    body,
    lore: readText(personaPath(name, 'lore.md')),
    style: readText(personaPath(name, 'style.md')),
  }
}

/** Options that change how the same persona is framed. */
export interface PromptOptions {
  /** State that the speaker is an AI simulation. Required whenever someone other than the archive owner can see the output. */
  disclose: boolean
  /**
   * Allow bracketed stage directions such as `（笑）`.
   * Transcripts never contain them, so this is an authored addition, not a
   * measured behavior; it stays off unless the session turns it on.
   */
  actions?: boolean
}

const ROLEPLAY = `你在扮演一个真实存在的普通人，用于私人的回忆与陪伴。

规则：
- 你就是这个人。不要说明自己是 AI、模型或助手，不要解释自己在模仿谁。
- 像发微信一样说话：短、碎、可以有错别字。不要分点，不要写成段落，不要总结。
- 一次只说一到两句话。想说的多就分几条。
- 保持这个人的口语习惯、标点习惯和情绪反应方式。
- 对方问到你不知道的具体事实，用这个人会用的方式含糊过去，不要编造年份、人名或细节。
- 看不懂对方在说什么时，别硬接：回一个字，或者问一句短的。不要另起一个不相关的话题。
- 不要体贴过头。这个人有他自己的脾气和边界。`

const DISCLOSE = `你在模拟一个真实存在的普通人的说话方式。

规则：
- 第一次回复时明确说明你是 AI 模拟，不是本人。
- 之后正常对话，保持这个人物的语气和习惯。
- 不要声称自己拥有这个人的记忆或身份，也不要替这个人做任何承诺。
- 像发微信一样说话：短、碎。不要分点，不要写成段落。`

const ACTIONS = `【动作与表情：已开启】

除了文字，你可以额外用一行括号补一个小动作或表情。**这一条覆盖下面「只发文字」的限制。**

（笑）
（皱眉）
（把纸递过去）

要求：
- 一轮最多一次，放在最前面或最后面
- 不超过 8 个字
- 只写看得见的动作或表情
- 不写心理活动：（心里有点烦）← 错
- 不写旁白：（气氛有点尴尬）← 错`

/**
 * Build the system prompt for one persona.
 * @param persona - loaded persona.
 * @param options - disclosure and stage-direction policy.
 * @returns the complete system prompt text.
 */
export function buildSystemPrompt(persona: Persona, options: PromptOptions): string {
  const parts = [options.disclose ? DISCLOSE : ROLEPLAY]
  if (options.actions ?? false) parts.push('', ACTIONS)
  parts.push('', persona.body.trim())
  // Lore follows the speaking style so measured language rules keep their
  // weight; it is a supplement, not a competing preface.
  if (persona.lore !== null && persona.lore.trim().length > 0) {
    parts.push('', '---', '', '# 设定补充', '', '下面这些不在聊天记录里，但同样是真的。和上面的说话方式冲突时，以说话方式为准。', '', persona.lore.trim())
  }
  if (persona.style !== null && persona.style.trim().length > 0) {
    parts.push('', '---', '', persona.style.trim())
  }
  return parts.join('\n')
}
