/**
 * Keep replies from flattening into one-word answers.
 *
 * Measured on this project's own archive: the real person writes in two peaks
 * — half the messages are 1–2 characters, and the other half land at 9–18.
 * Generated replies, even with explicit length rules and a verbatim long
 * sentence in the prompt, stayed at 1–11: the model's own habit outranks any
 * instruction. So length is balanced over the conversation instead of demanded
 * per reply — short answers stay short (they are correct), and when long ones
 * fall behind their measured share, the next turn asks for one.
 */

import type { StyleStats } from './stats.ts'

/** How long replies are supposed to be, taken from the archive. */
export interface LengthPlan {
  /** Share of messages that are long; 0 disables the whole mechanism. */
  longShare: number
  /** Character count that counts as "long" for this person. */
  threshold: number
}

/** Below this share of long messages, the person simply writes in fragments. */
const FRAGMENTARY_SHARE = 0.15

/** How many recent bot replies the balance is judged over. */
const DEFAULT_WINDOW = 6

/**
 * Derive a length plan from measured statistics.
 * @param stats - fingerprint of the training archive.
 * @returns the plan to balance against.
 */
export function lengthPlanFromStats(stats: StyleStats): LengthPlan {
  return {
    longShare: 1 - stats.length.briefRate,
    // 60% of p90: long enough to count, not as long as the extreme.
    threshold: Math.max(10, Math.floor(stats.length.p90 * 0.6)),
  }
}

/**
 * Whether this turn should ask for a long reply.
 *
 * The check is "are long replies behind their measured share", not "is the
 * last reply short". A short reply is usually the right answer — asking for
 * length after every short one would turn a fragmentary speaker into a
 * lecturer. Only a sustained absence of long replies triggers the request.
 * @param recentLengths - character counts of the most recent bot replies.
 * @param plan - target share and threshold from the archive.
 * @param window - how many recent replies to judge over.
 * @returns true when a long reply is owed.
 */
export function shouldAskForLong(
  recentLengths: readonly number[],
  plan: LengthPlan,
  window: number = DEFAULT_WINDOW,
): boolean {
  if (plan.longShare < FRAGMENTARY_SHARE) return false
  const recent = recentLengths.slice(-window)
  // With one or two replies there is no shape to fix yet.
  if (recent.length < 3) return false
  const longs = recent.filter((length) => length >= plan.threshold).length
  return longs < recent.length * plan.longShare
}

/**
 * The nudge added to the system prompt for one turn.
 *
 * Deliberately concrete — a length, a shape, and the permission to use a comma
 * — because "be more natural" changes nothing.
 * @param threshold - how long the reply should be.
 * @returns the instruction block.
 */
export function longHint(threshold: number): string {
  return `【这一句说完整】
你刚才连着几条都太短了。这一条一口气说完，像平时在微信里那样一整句：${threshold} 个字以上，中间可以停顿，可以有逗号。不要分成几条，也不要说完就收。`
}
