/**
 * `export`: turn a persona into a standard character card other clients read.
 *
 * The draft stays free Markdown for a person to edit; this is the portable
 * form. Written under `data/` by default because a card contains the persona's
 * real quoted dialogue and must not land in the repository.
 */

import { buildCharacterCard } from '../core/card.ts'
import { loadPersona } from '../core/persona.ts'
import { dataPath, writeText } from '../core/archive.ts'
import { stringFlag, type Flags } from './args.ts'

/**
 * Run the export command.
 * @param flags - parsed CLI flags for this command.
 */
export function runExport(flags: Flags): void {
  const name = stringFlag(flags, 'persona')
  if (name === undefined) throw new Error('用法：export --persona <名字> [--out 文件.json] [--creator 名字]')

  const persona = loadPersona(name)
  const card = buildCharacterCard(persona, {
    ...(stringFlag(flags, 'creator') === undefined ? {} : { creator: stringFlag(flags, 'creator') as string }),
  })
  // `data/` is gitignored; a card carries real quoted dialogue.
  const out = stringFlag(flags, 'out') ?? dataPath(`${name}.card.json`)
  writeText(out, JSON.stringify(card, null, 2) + '\n')

  const sections = [
    ['name', card.data.name],
    ['description', `${card.data.description.length} 字`],
    ['personality', `${card.data.personality.length} 字`],
    ['scenario', card.data.scenario.length > 0 ? `${card.data.scenario.length} 字` : '（空，lore 里补「关系」才有）'],
    ['mes_example', card.data.mes_example.length > 0 ? `${card.data.mes_example.split('<START>').length - 1} 段对话` : '（空）'],
  ] as const

  console.log(`已导出：${out}`)
  console.log('SillyTavern / 兼容 V2 卡片的客户端可以直接导入这个文件。\n')
  for (const [field, summary] of sections) console.log(`  ${field.padEnd(12)} ${summary}`)
  console.log('\n提示：description 里已经带上「说话规矩」（从统计生成）和「他会怎么做」；')
  console.log('      scenario 来自 lore.md 的「关系」节，没写就留空。')
}
