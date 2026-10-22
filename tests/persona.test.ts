import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSystemPrompt, type Persona } from '../src/core/persona.ts'

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
