/**
 * Export a persona as a standard character card.
 *
 * `persona.md` is free Markdown, which is right for a human editor and useless
 * to every other client: SillyTavern, CharacterAI and friends all read their
 * own card formats. Without an export, a persona only works inside this
 * project, which defeats the point of making one portable.
 *
 * The card is assembled from what the draft already contains — measured speech
 * rules, observed traits, verbatim sample dialogue, and the hand-written fact
 * list — so nothing has to be written twice.
 */

import type { Persona } from './persona.ts'

/** One `##` section of a persona draft. */
export interface PersonaSection {
  /** Heading text without the leading `## `. */
  title: string
  /** Body lines, heading excluded. */
  lines: string[]
}

/** The `data` object of a SillyTavern character card V2. */
export interface CharacterCardData {
  name: string
  description: string
  personality: string
  scenario: string
  first_mes: string
  mes_example: string
  creator_notes: string
  system_prompt: string
  post_history_instructions: string
  alternate_greetings: string[]
  tags: string[]
  creator: string
  character_version: string
  extensions: Record<string, unknown>
}

/** A complete card file: SillyTavern wraps the payload in `spec` + `data`. */
export interface CharacterCard {
  spec: 'chara_card_v2'
  spec_version: '2.0'
  data: CharacterCardData
}

/**
 * Split a Markdown document into its `##` sections.
 *
 * Only `##` counts: the draft uses `###` for subsections (the stats block) and
 * `#` for the title, and mixing those in would scatter one section into many.
 * @param body - persona Markdown.
 * @returns the sections in document order, plus any text before the first one.
 */
export function splitSections(body: string): { preamble: string[]; sections: PersonaSection[] } {
  const preamble: string[] = []
  const sections: PersonaSection[] = []
  let current: PersonaSection | null = null
  for (const line of body.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading !== null) {
      if (current !== null) sections.push(current)
      current = { title: heading[1], lines: [] }
      continue
    }
    if (current === null) preamble.push(line)
    else current.lines.push(line)
  }
  if (current !== null) sections.push(current)
  return { preamble, sections }
}

/**
 * Find a section by a fragment of its heading.
 *
 * Headings carry parenthetical hints (`口头禅（他比你更常用）`), so matching
 * the full text would break on every wording tweak.
 * @param sections - sections to search.
 * @param fragment - substring of the heading.
 * @returns the section body, or an empty string.
 */
export function sectionText(sections: readonly PersonaSection[], fragment: string): string {
  const found = sections.find((section) => section.title.includes(fragment))
  return found === undefined ? '' : found.lines.join('\n').trim()
}

/** Strip list markers and empty lines from a section body. */
function bulletLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== '---' && !line.startsWith('>'))
    .map((line) => line.replace(/^[-*]\s*/, ''))
}

/**
 * Turn the draft's quoted dialogue into SillyTavern's example format.
 *
 * The draft writes `> 你：…` / `> 他：…`; the card format expects one block
 * separated by `<START>` with `{{user}}:` / `{{char}}:` prefixes.
 * @param text - the `真实对话` section body.
 * @param charName - who the card speaks as.
 * @returns the formatted example block.
 */
export function renderMesExample(text: string): string {
  const blocks: string[][] = []
  let current: string[] = []
  const flush = (): void => {
    if (current.length > 0) blocks.push(current)
    current = []
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    // A blank line separates exchanges in the draft.
    if (line.length === 0) {
      flush()
      continue
    }
    const turn = /^>\s*(你|他)[：:]\s*(.*)$/u.exec(line)
    if (turn === null) continue
    const speaker = turn[1] === '你' ? '{{user}}' : '{{char}}'
    current.push(`${speaker}: ${turn[2]}`)
  }
  flush()
  if (blocks.length === 0) return ''
  return blocks.map((block) => `<START>\n${block.join('\n')}`).join('\n')
}

/**
 * Build a SillyTavern V2 card from a loaded persona.
 * @param persona - the persona to export.
 * @param options - creator name and extra tags.
 * @returns a card object ready to serialise.
 */
export function buildCharacterCard(
  persona: Persona,
  options: { creator?: string; version?: string } = {},
): CharacterCard {
  const { preamble, sections } = splitSections(persona.body)
  const title = /^#\s+(.+)$/m.exec(preamble.join('\n'))?.[1]?.trim() ?? persona.name
  const speechRules = sectionText(sections, '说话规矩')
  const traits = bulletLines(sectionText(sections, '他的特征'))
  const avoid = bulletLines(sectionText(sections, '他从不做什么'))
  const catchphrases = sectionText(sections, '口头禅')
  const humor = bulletLines(sectionText(sections, '他的幽默和火气'))
  const samples = sectionText(sections, '真实对话')
  const loreRelation = persona.lore === null ? '' : sectionText(splitSections(persona.lore).sections, '关系')
  const loreFacts = persona.lore === null ? '' : sectionText(splitSections(persona.lore).sections, '事实清单')

  const descriptionParts: string[] = []
  if (speechRules.length > 0) descriptionParts.push(speechRules)
  if (traits.length > 0) descriptionParts.push(['**他会怎么做**', ...traits.map((line) => `- ${line}`)].join('\n'))
  if (avoid.length > 0) descriptionParts.push(['**他从不做的事**', ...avoid.map((line) => `- ${line}`)].join('\n'))
  if (loreFacts.length > 0) descriptionParts.push(['**你们之间真实发生过的事**', loreFacts].join('\n\n'))

  const personalityParts: string[] = []
  if (catchphrases.length > 0) personalityParts.push(`口头禅：${catchphrases}`)
  if (humor.length > 0) personalityParts.push(...humor)
  if (persona.style !== null && persona.style.trim().length > 0) personalityParts.push(persona.style.trim())

  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: title,
      description: descriptionParts.join('\n\n'),
      personality: personalityParts.join('\n\n'),
      scenario: loreRelation.length > 0 ? loreRelation : '',
      first_mes: '',
      mes_example: renderMesExample(samples),
      creator_notes: '由 persona-forge 从聊天记录蒸馏生成；说话方式来自统计，事实清单需要人工核对。',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: ['persona-forge', 'distilled'],
      creator: options.creator ?? 'persona-forge',
      character_version: options.version ?? '1.0',
      extensions: {},
    },
  }
}
