import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareTranscript, preparedPath } from '../src/core/prepare.ts'

/**
 * These three edits were hand-run PowerShell before: renaming the export's
 * owner label, replacing exported media paths, and masking ids. Each one
 * silently corrupts the persona when skipped.
 */

const EXPORT = [
  '---------- 2024-09-25 ----------',
  '[22:32:24] 吴文哲:',
  '你在哪',
  '[22:32:31] 我:',
  '图书馆',
  'media/00001_64c03476W.jpg',
  '附件：202412345678-张三.docx -> media/00011_高数.docx',
  '[22:33:02] 我:',
  '等会儿我发给你',
].join('\n')

test('renames only the owner speaker header, never the body', () => {
  const result = prepareTranscript(EXPORT, { selfLabel: '我', selfName: '赵明', redact: true })
  assert.match(result.text, /\[22:32:31\] 赵明:/)
  assert.match(result.text, /\[22:33:02\] 赵明:/)
  assert.equal(result.renamedHeaders, 2)
  // The other speaker is untouched.
  assert.match(result.text, /\[22:32:24\] 吴文哲:/)
})

test('does not touch a one-word message that happens to be the label', () => {
  const raw = ['[22:00:00] 吴文哲:', '我', '[22:00:05] 我:', '嗯'].join('\n')
  const result = prepareTranscript(raw, { selfLabel: '我', selfName: '赵明', redact: false })
  assert.match(result.text, /\n我\n/)
  assert.equal(result.renamedHeaders, 1)
})

test('replaces exported media paths with placeholders and drops the filename', () => {
  const result = prepareTranscript(EXPORT, { selfLabel: '我', selfName: '赵明', redact: true })
  assert.match(result.text, /^\[图片\]$/m)
  assert.match(result.text, /^\[文件\]$/m)
  assert.equal(result.mediaLines, 2)
  assert.doesNotMatch(result.text, /media\//)
  assert.doesNotMatch(result.text, /202412345678/)
  assert.doesNotMatch(result.text, /张三/)
})

test('reports speakers in order of appearance', () => {
  const result = prepareTranscript(EXPORT, { selfLabel: '我', selfName: '赵明', redact: true })
  assert.deepEqual(result.speakers, ['吴文哲', '我'])
})

test('renaming is skipped when the name is left alone', () => {
  const result = prepareTranscript(EXPORT, { selfLabel: '我', selfName: '我', redact: false })
  assert.match(result.text, /\[22:32:31\] 我:/)
  assert.equal(result.renamedHeaders, 0)
})

test('a path without .txt still gets a prepared name beside it', () => {
  assert.equal(preparedPath('E:\\wx\\chat.txt'), 'E:\\wx\\chat.prepared.txt')
})
