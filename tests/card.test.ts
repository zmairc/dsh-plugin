import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCharacterCard, renderMesExample, sectionText, splitSections } from '../src/core/card.ts'
import type { Persona } from '../src/core/persona.ts'

/**
 * A persona only works inside this project until it can be exported. The draft
 * is free Markdown; every other client reads a structured card. These tests
 * pin the mapping so a wording change in the draft cannot silently produce an
 * empty card.
 */

const DRAFT = `# 赵明

> 由 distill 自动生成的初稿。

## 说话规矩（从统计直接生成，优先遵守）

- 长度：56% 的消息在 8 字以内；但不要只会发短句。
- 问号：少用（3.5% 的消息里有），疑问大多靠语气词。

## 说话方式（统计）

### 风格指纹（自动统计，可直接引用）

- 消息量：吴文哲 4397 条 / 赵明 2951 条

## 他的特征（模型观察，需核对）

- 被问成绩只报数字 ← \`81分\`
- 发消息拆成多条短句连发

## 他从不做什么（模型观察，最有用，也最容易编）

- 不道歉

## 口头禅（他比你更常用，括号里是出现条数）

\`咋\`(他 49 / 你 3)　\`行\`(他 118 / 你 96)

## 真实对话（原话，最有用）

> 你：在忙吗
> 他：不忙

> 你：晚上出来不
> 他：行

## 他是谁（需要你补）

- 年龄、做什么工作、和你什么关系
`

const LORE = `# 赵明 · 设定补充

## 关系

同班同学，同一栋楼。

## 事实清单

- 他在准备考研。
`

const persona = { name: 'zhaoming', body: DRAFT, lore: LORE, style: '## 风格指纹\n- 平均 17 字' } as unknown as Persona

test('sections split on level-2 headings only', () => {
  // `###` belongs to the stats block; splitting there would scatter it.
  const { preamble, sections } = splitSections(DRAFT)
  assert.match(preamble.join('\n'), /# 赵明/)
  assert.equal(sections[0].title, '说话规矩（从统计直接生成，优先遵守）')
  assert.ok(sections.some((section) => section.title.includes('说话方式')))
})

test('a section is found by a fragment of its heading', () => {
  // Headings carry parenthetical hints that change as the draft evolves.
  const { sections } = splitSections(DRAFT)
  assert.match(sectionText(sections, '口头禅'), /咋/)
  assert.equal(sectionText(sections, '不存在的节'), '')
})

test('quoted dialogue becomes the card example format', () => {
  const example = renderMesExample('> 你：在忙吗\n> 他：不忙\n\n> 你：走不\n> 他：行')
  assert.match(example, /^\<START\>/)
  assert.match(example, /\{\{user\}\}: 在忙吗/)
  assert.match(example, /\{\{char\}\}: 不忙/)
  // Two exchanges, two markers.
  assert.equal(example.split('<START>').length - 1, 2)
})

test('the card carries speech rules, traits, and sample dialogue', () => {
  const card = buildCharacterCard(persona)
  assert.equal(card.spec, 'chara_card_v2')
  assert.equal(card.data.name, '赵明')
  assert.match(card.data.description, /不要只会发短句/)
  assert.match(card.data.description, /被问成绩只报数字/)
  assert.match(card.data.description, /不道歉/)
  // Catchphrases belong in the always-injected description, not the brief
  // personality summary.
  assert.match(card.data.description, /咋/)
  assert.match(card.data.mes_example, /\{\{char\}\}: 不忙/)
  // The opener is the most influential slot: the model copies its length and
  // punctuation from it, so it must be a real line, not empty.
  assert.equal(card.data.first_mes, '不忙')
  assert.match(card.data.extensions.persona_forge.generator, /persona-forge/)
  // scenario comes from lore, not from the draft.
  assert.match(card.data.scenario, /同一栋楼/)
})

test('a persona without lore still produces a usable card', () => {
  const bare = { name: 'bare', body: DRAFT, lore: null, style: null } as unknown as Persona
  const card = buildCharacterCard(bare)
  assert.equal(card.data.scenario, '')
  assert.match(card.data.description, /不要只会发短句/)
})
