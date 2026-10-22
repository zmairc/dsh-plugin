import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redact, redactCounted } from '../src/core/redact.ts'

/**
 * Student ids reached a persona before this rule existed: exports embed
 * `附件：202412345678-张三.docx`, `--redact` only knew phones, cards, emails
 * and links, so the id and the real name went through untouched.
 */
test('masks a 12 digit student id', () => {
  assert.equal(redact('附件：202412345678-张三.docx'), '附件：[学号]-张三.docx')
})

test('a phone number is still a phone number, not a student id', () => {
  assert.equal(redact('打 13812345678'), '打 [手机号]')
})

test('an 18 digit id keeps its own label', () => {
  assert.equal(redact('110101199003071234'), '[身份证]')
})

test('masks emails, links, and supplied names', () => {
  const masked = redact('发给赵明：zhao@example.com，看 https://example.com/a', ['赵明'])
  assert.equal(masked, '发给[姓名]：[邮箱]，看 [链接]')
})

test('reports how many substitutions happened', () => {
  const result = redactCounted('学号 202412345678，另一个 202412345679，手机 13812345678')
  assert.equal(result.hits, 3)
  assert.equal(result.text, '学号 [学号]，另一个 [学号]，手机 [手机号]')
})

test('leaves an id-free line alone', () => {
  assert.equal(redact('明天考试你复习到哪儿了'), '明天考试你复习到哪儿了')
})
