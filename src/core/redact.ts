/**
 * Text redaction for sharing a transcript or persona pack.
 *
 * The rules are deliberately conservative and lossy: masking is cheaper than
 * leaking a friend's phone number into a public repository. Callers pass the
 * names they already know are sensitive.
 */

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b1[3-9]\d{9}\b/g, '[手机号]'],
  // Student/staff ids are 12 bare digits and show up in exported attachment
  // names (`202412345678-张三.docx`). They are not card numbers, which is why
  // this rule has to come before the 16–19 digit one to be readable.
  [/\b\d{12}\b/g, '[学号]'],
  [/\b\d{17}[\dXx]\b/g, '[身份证]'],
  [/\b\d{16,19}\b/g, '[卡号]'],
  [/[\w.+-]+@[\w-]+\.[\w.]+/g, '[邮箱]'],
  [/https?:\/\/\S+/g, '[链接]'],
]

/**
 * Mask phone numbers, student/staff ids, card numbers, emails, and links, plus
 * any supplied names, and report how many substitutions happened.
 * @param text - text to redact.
 * @param names - additional literal names to replace.
 * @returns redacted text plus the number of masked occurrences.
 */
export function redactCounted(text: string, names: readonly string[] = []): { text: string; hits: number } {
  let output = text
  let hits = 0
  for (const name of names) {
    if (name.trim().length === 0) continue
    const parts = output.split(name)
    if (parts.length > 1) {
      hits += parts.length - 1
      output = parts.join('[姓名]')
    }
  }
  for (const [pattern, replacement] of RULES) {
    output = output.replace(pattern, () => {
      hits += 1
      return replacement
    })
  }
  return { text: output, hits }
}

/**
 * Mask phone numbers, student/staff ids, card numbers, emails, and links, plus
 * any supplied names.
 * @param text - text to redact.
 * @param names - additional literal names to replace.
 * @returns redacted text.
 */
export function redact(text: string, names: readonly string[] = []): string {
  return redactCounted(text, names).text
}
