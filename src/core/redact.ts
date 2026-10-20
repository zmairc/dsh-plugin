/**
 * Text redaction for sharing a transcript or persona pack.
 *
 * The rules are deliberately conservative and lossy: masking is cheaper than
 * leaking a friend's phone number into a public repository. Callers pass the
 * names they already know are sensitive.
 */

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b1[3-9]\d{9}\b/g, '[手机号]'],
  [/\b\d{17}[\dXx]\b/g, '[身份证]'],
  [/\b\d{16,19}\b/g, '[卡号]'],
  [/[\w.+-]+@[\w-]+\.[\w.]+/g, '[邮箱]'],
  [/https?:\/\/\S+/g, '[链接]'],
]

/**
 * Mask phone numbers, ids, card numbers, emails, and links, plus any supplied names.
 * @param text - text to redact.
 * @param names - additional literal names to replace.
 * @returns redacted text.
 */
export function redact(text: string, names: readonly string[] = []): string {
  let output = text
  for (const name of names) {
    if (name.trim().length === 0) continue
    output = output.split(name).join('[姓名]')
  }
  for (const [pattern, replacement] of RULES) output = output.replace(pattern, replacement)
  return output
}
