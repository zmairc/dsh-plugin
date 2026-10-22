/**
 * Statistical comparison of generated replies against the real ones they were
 * meant to replace.
 *
 * The blind quiz answers "can you spot the fake?" — useful, but twenty items
 * cannot separate two close candidates, and a reader who knows the person
 * brings their own biases (one user mistook the real line `你干啥去了` for AI
 * three times). This measures the other half: is the generated text shaped
 * like his?
 *
 * Neither number is enough alone. A persona can match every statistic and
 * still misread each situation; a persona can win a twenty-item quiz by luck.
 * Run both, and treat a disagreement as the interesting result.
 */

import type { WireMessage } from './llm.ts'

/**
 * Messages longer than this are pasted documents, not conversation.
 *
 * `stats.ts` already caps the mean at the same threshold: the archive holds a
 * 12914-character message and a handful of 1000+ ones, and a generated reply
 * is never that long. Left in, the reference mean swings between 11 and 45
 * characters depending on which slice the long messages land in, and every
 * candidate looks equally far from it.
 */
const LENGTH_CAP = 1000

/** How one set of messages is shaped. Rates are shares of messages, not of characters. */
export interface Morphology {
  /** Messages measured, so a small sample is not over-read. */
  count: number
  /** Messages dropped for exceeding {@link LENGTH_CAP}. */
  dropped: number
  meanLength: number
  medianLength: number
  /** Share of 1–2 character messages. */
  shortRate: number
  /** Share of messages of 8 characters or fewer. */
  briefRate: number
  questionRate: number
  commaRate: number
  periodRate: number
  exclamationRate: number
  emojiRate: number
}

/** Mean of a list, or 0 when empty. */
function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

/** Share of texts that match a pattern. */
function rate(texts: readonly string[], pattern: RegExp): number {
  return texts.length === 0 ? 0 : texts.filter((text) => pattern.test(text)).length / texts.length
}

/**
 * Measure how a set of messages is shaped.
 * @param texts - message bodies, as the person wrote them.
 * @returns length and punctuation profile.
 */
export function profileMorphology(texts: readonly string[]): Morphology {
  const kept = texts.filter((text) => text.length <= LENGTH_CAP)
  const dropped = texts.length - kept.length
  const lengths = kept.map((text) => text.length).sort((a, b) => a - b)
  const median = lengths.length === 0 ? 0 : lengths[Math.floor(lengths.length / 2)]
  return {
    count: kept.length,
    dropped,
    meanLength: mean(lengths),
    medianLength: median,
    shortRate: rate(kept, /^.{1,2}$/su),
    briefRate: rate(kept, /^.{1,8}$/su),
    questionRate: rate(kept, /[?？]/),
    commaRate: rate(kept, /[，,]/),
    periodRate: rate(kept, /[。]/),
    exclamationRate: rate(kept, /[!！]/),
    emojiRate: rate(kept, /\p{Extended_Pictographic}/u),
  }
}

/**
 * How far one profile is from a reference profile.
 *
 * Lengths are compared relatively (a 3-character gap matters more at a median
 * of 5 than of 20); rates are compared absolutely, since both live in 0–1.
 * @param candidate - the persona's generated profile.
 * @param reference - the real messages' profile.
 * @returns mean relative error across nine measures; 0 is identical.
 */
export function distance(candidate: Morphology, reference: Morphology): number {
  const relative = (a: number, b: number): number => Math.abs(a - b) / Math.max(Math.abs(b), 1)
  const absolute = (a: number, b: number): number => Math.abs(a - b)
  const parts = [
    relative(candidate.meanLength, reference.meanLength),
    relative(candidate.medianLength, reference.medianLength),
    absolute(candidate.shortRate, reference.shortRate),
    absolute(candidate.briefRate, reference.briefRate),
    absolute(candidate.questionRate, reference.questionRate),
    absolute(candidate.commaRate, reference.commaRate),
    absolute(candidate.periodRate, reference.periodRate),
    absolute(candidate.exclamationRate, reference.exclamationRate),
    absolute(candidate.emojiRate, reference.emojiRate),
  ]
  return parts.reduce((sum, value) => sum + value, 0) / parts.length
}

/** Parse the assistant text out of a wire message, for profiling generated replies. */
export function wireTexts(messages: readonly WireMessage[]): string[] {
  return messages.map((message) => message.content)
}

/**
 * Two-sided binomial p-value for `wins` out of `trials` against a fair coin.
 * Used to say whether a duel result is more than noise.
 * @param wins - number of trials the first side won.
 * @param trials - total decided trials.
 * @returns the two-sided probability of a result at least this extreme.
 */
export function binomialP(wins: number, trials: number): number {
  if (trials <= 0) return 1
  const choose = (n: number, k: number): number => {
    let result = 1
    for (let index = 1; index <= k; index += 1) result = (result * (n - k + index)) / index
    return result
  }
  const tail = Math.min(wins, trials - wins)
  let total = 0
  for (let index = 0; index <= tail; index += 1) total += choose(trials, index) * Math.pow(0.5, trials)
  return Math.min(1, 2 * total)
}
