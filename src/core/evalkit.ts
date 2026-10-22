/**
 * Shared plumbing for the blind tests.
 *
 * `eval` asks "can you spot the generated line?" and `duel` asks "which of two
 * personas sounds more like him?" — different questions, identical machinery:
 * turn a held-out slice into prediction tasks, keep them from overlapping, and
 * drop the ones the persona prompt already answers.
 */

import type { WireMessage } from './llm.ts'
import type { ChatMessage } from './types.ts'

/** How many preceding messages form the context for one prediction. */
export const CONTEXT_WINDOW = 8

/** One prediction task: the conversation so far, and the reply that actually happened. */
export interface Prediction {
  context: WireMessage[]
  truth: string
  /** Position in the holdout, used to keep items from overlapping. */
  index: number
  /** How long the friend waited before replying; part of how a reply reads. */
  gapMs: number
}

/**
 * Turn a held-out slice into prediction tasks: each one ends where the friend
 * was about to speak, so the real reply is a genuine next turn.
 * @param holdout - held-out messages, sorted by time.
 * @param limit - maximum number of tasks to produce.
 * @returns the constructed tasks.
 */
export function buildPredictions(holdout: readonly ChatMessage[], limit: number): Prediction[] {
  const predictions: Prediction[] = []
  for (let index = 1; index < holdout.length && predictions.length < limit; index += 1) {
    const message = holdout[index]
    if (message.role !== 'friend' || message.kind !== 'text' || (message.text ?? '').length === 0) continue
    if (holdout[index - 1].role !== 'self') continue

    const context: WireMessage[] = []
    for (const previous of holdout.slice(Math.max(0, index - CONTEXT_WINDOW), index)) {
      const wire = toWire(previous)
      if (wire !== null) context.push(wire)
    }
    if (context.length === 0) continue
    predictions.push({ context, truth: message.text as string, index, gapMs: message.ts - holdout[index - 1].ts })
  }
  return predictions
}

/**
 * Pick predictions far enough apart that one item's answer is not another
 * item's context. Spacing shrinks only when the slice cannot supply enough
 * items otherwise.
 * @param predictions - candidate tasks, in time order.
 * @param count - desired number of items.
 * @returns the selected tasks, possibly fewer than requested.
 */
export function selectSpread(predictions: readonly Prediction[], count: number): Prediction[] {
  let best: Prediction[] = []
  for (const gap of [5, 4, 3, 2]) {
    const picked: Prediction[] = []
    let last = Number.NEGATIVE_INFINITY
    for (const prediction of predictions) {
      if (prediction.index - last < gap) continue
      picked.push(prediction)
      last = prediction.index
      if (picked.length === count) return picked
    }
    // The slice may be too short for the requested count; keep the widest set.
    if (picked.length > best.length) best = picked
  }
  return best
}

/** Map an archived message to a wire message, or null when it cannot be used. */
export function toWire(message: ChatMessage): WireMessage | null {
  if (message.kind !== 'text' || (message.text ?? '').length === 0) return null
  if (message.role === 'self') return { role: 'user', content: message.text as string }
  if (message.role === 'friend') return { role: 'assistant', content: message.text as string }
  return null
}

/** Fisher-Yates shuffle, so real and generated replies are mixed. */
export function shuffle<T>(items: T[]): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1))
    const temporary = items[index]
    items[index] = items[swap]
    items[swap] = temporary
  }
  return items
}

/**
 * Normalize a line for containment checks: punctuation and whitespace would
 * only hide a verbatim quote that is already in the persona.
 */
export function normalizeForLeak(text: string): string {
  return text.replace(/[\s。，、！？：；""''「」『』《》…—～·.,!?:;"'()\-]/g, '')
}

/**
 * Find predictions a persona prompt already answers.
 *
 * A hand-written persona quotes real conversations, and the held-out slice is
 * cut from the same archive, so some "test" answers are literally sitting in
 * the system prompt. A model that sees them just repeats them, which scores as
 * a perfect imitation while proving nothing.
 *
 * With two personas this matters twice as much: the item must be new to
 * *both* prompts, or one side is scored on recitation and the other on
 * imitation.
 * @param predictions - candidate prediction tasks.
 * @param systems - one or more full system prompts the models will receive.
 * @returns indexes of predictions whose answer, or whose quoted stretch, a prompt already contains.
 */
export function findLeaked(predictions: readonly Prediction[], systems: readonly string[]): number[] {
  const haystacks = systems.map((system) => normalizeForLeak(system))
  const leaked: number[] = []
  predictions.forEach((prediction, index) => {
    const truth = normalizeForLeak(prediction.truth)
    // Very short answers match by accident; a quote long enough to be unique does not.
    const answerLeaks = truth.length >= 4 && haystacks.some((haystack) => haystack.includes(truth))
    if (answerLeaks) {
      leaked.push(index)
      return
    }
    // Two or more lines from the same window means the whole exchange was quoted.
    const contextHits = prediction.context.filter((wire) => {
      const text = normalizeForLeak(wire.content)
      return text.length >= 4 && haystacks.some((haystack) => haystack.includes(text))
    }).length
    if (contextHits >= 2) leaked.push(index)
  })
  return leaked
}
