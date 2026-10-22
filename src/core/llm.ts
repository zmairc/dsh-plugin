/**
 * Minimal OpenAI-compatible chat client.
 *
 * Plain `fetch` and no SDK: the target is any endpoint that speaks
 * `/chat/completions`, so the project carries no provider dependency and works
 * against DeepSeek, OpenAI, a local llama.cpp server, or an internal gateway.
 */

import { loadDotEnv } from './env.ts'

/** Resolved connection settings for one run. */
export interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
}

/** A message in the wire format. */
export interface WireMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * Read connection settings from the environment.
 *
 * Re-reads `.env` on every call because a host process (an MCP client, an IDE)
 * may have spawned this process before the user filled the file in. A key set
 * by the shell still wins over the file.
 */
export function llmConfigFromEnv(): LlmConfig {
  loadDotEnv()
  const apiKey = process.env.PERSONAFORGE_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? ''
  return {
    baseUrl: (process.env.PERSONAFORGE_BASE_URL ?? 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    apiKey,
    model: process.env.PERSONAFORGE_MODEL ?? 'deepseek-chat',
    temperature: Number(process.env.PERSONAFORGE_TEMPERATURE ?? '1.1'),
  }
}

/** Thrown when the endpoint rejects a call or returns no content. */
export class LlmError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LlmError'
  }
}

/** Tokens and calls spent since the last {@link resetUsage}. */
export interface LlmUsage {
  promptTokens: number
  completionTokens: number
  calls: number
}

let usage: LlmUsage = { promptTokens: 0, completionTokens: 0, calls: 0 }

/**
 * Clear the accumulated usage.
 *
 * A forge run is one spending session: it resets here at the start and reports
 * at the end, so "140 calls, 1.2M in / 300k out" is the run's own bill rather
 * than the process's lifetime total.
 */
export function resetUsage(): void {
  usage = { promptTokens: 0, completionTokens: 0, calls: 0 }
}

/** What this process spent since the last reset. */
export function readUsage(): LlmUsage {
  return { ...usage }
}

/** Add one response's usage; endpoints that omit it still count the call. */
function recordUsage(reported: { prompt_tokens?: number; completion_tokens?: number } | undefined): void {
  usage.calls += 1
  if (reported === undefined) return
  usage.promptTokens += reported.prompt_tokens ?? 0
  usage.completionTokens += reported.completion_tokens ?? 0
}

/**
 * Run one chat completion.
 * @param config - endpoint, credentials, and sampling settings.
 * @param messages - the full conversation to send.
 * @returns the assistant's text.
 */
export async function complete(config: LlmConfig, messages: readonly WireMessage[]): Promise<string> {
  if (config.apiKey.length === 0) {
    throw new LlmError('缺少 API key：设置 PERSONAFORGE_API_KEY 或 DEEPSEEK_API_KEY')
  }
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: config.temperature,
      stream: false,
    }),
  })
  const body = await response.text()
  if (!response.ok) {
    throw new LlmError(`${response.status} ${response.statusText}: ${body.slice(0, 500)}`)
  }
  const parsed = JSON.parse(body) as {
    choices?: Array<{ message?: { content?: string } }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  recordUsage(parsed.usage)
  const content = parsed.choices?.[0]?.message?.content
  if (typeof content !== 'string' || content.length === 0) {
    throw new LlmError(`接口返回了空内容：${body.slice(0, 500)}`)
  }
  return content
}
