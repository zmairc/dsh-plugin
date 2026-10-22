/**
 * `prepare`: raw chat export in, a transcript `forge` can read out.
 *
 * Renaming the owner's label, turning exported media paths into placeholders,
 * and masking ids used to be three hand-run PowerShell steps that nothing
 * recorded. This is the one command that does them.
 */

import { readText, writeText } from '../core/archive.ts'
import { prepareTranscript, preparedPath } from '../core/prepare.ts'
import { boolFlag, stringFlag, type Flags } from './args.ts'

/**
 * Run the prepare command.
 * @param flags - parsed CLI flags for this command.
 */
export function runPrepare(flags: Flags): void {
  const file = stringFlag(flags, 'file')
  if (file === undefined) {
    throw new Error('用法：prepare --file <原始导出.txt> [--self 我] [--as 赵明] [--out 输出.txt] [--no-redact]')
  }

  const raw = readText(file)
  if (raw === null) throw new Error(`读不到文件：${file}`)

  const selfLabel = stringFlag(flags, 'self') ?? '我'
  const selfName = stringFlag(flags, 'as') ?? selfLabel
  const output = stringFlag(flags, 'out') ?? preparedPath(file)

  console.log(`读取 ${file}`)
  const result = prepareTranscript(raw, { selfLabel, selfName, redact: !boolFlag(flags, 'no-redact') })
  writeText(output, result.text)

  console.log(`识别到说话人：${result.speakers.length > 0 ? result.speakers.join(' / ') : '（没识别出，检查文件格式）'}`)
  if (selfName !== selfLabel) {
    console.log(`说话人改名：「${selfLabel}」→「${selfName}」${result.renamedHeaders} 处`)
  } else if (result.renamedHeaders === 0) {
    console.log(`说话人改名：跳过（--as 没给，或者记录里没有「${selfLabel}」这个标签）`)
  }
  console.log(`媒体行换成占位：${result.mediaLines} 条`)
  console.log(`打码：${result.redacted} 处（手机号 / 学号 / 身份证 / 卡号 / 邮箱 / 链接）`)
  console.log(`\n已写出：${output}`)
  console.log('\n下一步：')
  console.log(`  node src/cli/index.ts speakers --file "${output}"`)
  console.log(`  node src/cli/index.ts forge --file "${output}" --persona <名字> --me <记录主人> --friend "${selfName}" --display "${selfName}"`)
}
