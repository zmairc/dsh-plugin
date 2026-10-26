import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSystemPrompt, hasStructuredLore, isSkip, mustAnswerHint, renderLoreTemplate, SKIP_MARKER, type Persona } from '../src/core/persona.ts'

/**
 * A persona is distilled from one relationship, so every line in it was said
 * to the archive owner. Handed to anybody else it keeps using the owner's name
 * and the owner's intimacy — that is a correctness bug, not a style preference.
 */

const persona = {
  name: '吴文哲',
  body: '# 吴文哲\n\n他说话很短。',
  lore: null,
  style: null,
} as unknown as Persona

test('without --as the prompt stays in the original relationship', () => {
  const prompt = buildSystemPrompt(persona, { disclose: false })
  assert.doesNotMatch(prompt, /现在跟谁说话/)
  assert.match(prompt, /他说话很短/)
})

test('--as names the listener and says the transcript partner was someone else', () => {
  const prompt = buildSystemPrompt(persona, { disclose: false, listener: '李雷' })
  assert.match(prompt, /现在跟谁说话/)
  assert.match(prompt, /「李雷」/)
  assert.match(prompt, /不是他/)
  // The persona body still follows, so the framing does not replace it.
  assert.match(prompt, /他说话很短/)
})

test('a blank --as is treated as absent', () => {
  const prompt = buildSystemPrompt(persona, { disclose: false, listener: '   ' })
  assert.doesNotMatch(prompt, /现在跟谁说话/)
})

/** A persona carrying only a lore file. */
function withLore(lore: string): Persona {
  return { name: '吴文哲', body: '# 吴文哲', lore, style: null } as unknown as Persona
}

test('free-form lore stays as-is, without the fact boundary', () => {
  // Existing personas use free-form lore; adding the boundary there would
  // change how they behave without anyone asking.
  const prompt = buildSystemPrompt(withLore('# 设定\n## 性格\n有些好色'), { disclose: false })
  assert.doesNotMatch(prompt, /事实边界/)
  assert.match(prompt, /有些好色/)
})

test('a structured fact list turns on the fact boundary', () => {
  // The model invented an evening that never happened; this is what stops it.
  const prompt = buildSystemPrompt(withLore('## 关系\n大学同学\n## 事实清单\n- 在同一栋楼住'), { disclose: false })
  assert.match(prompt, /事实边界/)
  assert.match(prompt, /不要编/)
  assert.match(prompt, /在同一栋楼住/)
})

test('any one of the three headings is enough', () => {
  assert.equal(hasStructuredLore('## 禁区\n- 别提他爸'), true)
  assert.equal(hasStructuredLore('## 关系\n同学'), true)
  assert.equal(hasStructuredLore('## 性格\n内向'), false)
})

test('the lore template lists the three headings', () => {
  const template = renderLoreTemplate('吴文哲')
  for (const title of ['## 关系', '## 事实清单', '## 禁区']) assert.match(template, new RegExp(title))
})

/**
 * A persona that answers every line reads as a bot. Real chat has turns where
 * nothing is worth saying — but a model told that will also use it to dodge
 * questions, so the two rules have to ship together.
 */

test('the role-play prompt offers silence and forbids using it to dodge', () => {
  const prompt = buildSystemPrompt(persona, { disclose: false })
  assert.match(prompt, /\[SKIP\]/)
  assert.match(prompt, /不需要回/)
  // Without this second half, "[SKIP] whenever it is hard" is the cheap strategy.
  assert.match(prompt, /不能拿来躲问题/)
})

test('a reply is a skip only when it is nothing but the marker', () => {
  assert.equal(isSkip('[SKIP]'), true)
  // Models pad it, wrap it, and lowercase it; all of that still means "no message".
  assert.equal(isSkip('  [skip]\n'), true)
  // A reply that talks about skipping is a reply.
  assert.equal(isSkip('[SKIP] 算了不说了'), false)
  assert.equal(isSkip('行'), false)
  assert.equal(isSkip(''), false)
})

test('the must-answer hint is one instruction, not a second persona', () => {
  const hint = mustAnswerHint()
  assert.match(hint, /必须回/)
  assert.ok(hint.length < 120, 'hint must stay short enough to not outweigh the persona')
  assert.ok(!hint.includes(SKIP_MARKER), 'the hint must not show the model the marker it is being denied')
})

