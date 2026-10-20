#!/usr/bin/env node
/**
 * persona-forge MCP server (stdio).
 *
 * The "plugin" entry point: an MCP-capable client lists tools and calls them.
 * Two tools are exposed:
 *   - `forge_persona` turns a transcript file into a persona pack;
 *   - `chat_persona` replies in that persona's voice.
 *
 * Protocol notes: stdio transport is newline-delimited JSON-RPC, and stdout
 * carries protocol messages only. Progress goes to stderr.
 */

import { createInterface } from 'node:readline'
import { LlmError, complete, llmConfigFromEnv } from '../core/llm.ts'
import { forgePersona, assertSafePersonaName } from '../core/forge.ts'
import { buildSystemPrompt, loadPersona } from '../core/persona.ts'
import { loadDotEnv } from '../core/env.ts'
import type { Source } from '../core/types.ts'

// The server is often spawned by a desktop client whose environment we cannot
// edit, so the project's gitignored `.env` is the convenient key source.
loadDotEnv()

const SERVER_INFO = { name: 'persona-forge', version: '0.2.0' }
const PROTOCOL_VERSION = '2024-11-05'
const SOURCES: readonly Source[] = ['wechat', 'qq', 'douyin', 'manual']

const FORGE_TOOL = {
  name: 'forge_persona',
  description:
    '从一份聊天记录 txt 生成可以扮演的人设。自动解析说话人、统计说话风格、让模型逐块读对话，写出 persona.md 和 style.md，返回摘要和路径。适合用户把导出的聊天记录存成一个 txt 后直接调用。',
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: '聊天记录 txt 的绝对路径' },
      persona: { type: 'string', description: '人设目录名，只能字母数字下划线短横线' },
      me: { type: 'string', description: '你自己的显示名，多个用逗号分隔，默认「我」' },
      friend: { type: 'string', description: '要模仿的人的显示名；不填则取出现最多的另一方' },
      display: { type: 'string', description: '人设标题用的名字，比如真名；默认用记录里的昵称' },
      source: { type: 'string', enum: [...SOURCES], description: '记录来源，默认 manual' },
      chunkSize: { type: 'number', description: '每次模型调用读多少条消息，默认 60' },
      sample: { type: 'number', description: '只均匀抽样这么多块来控制花费；不填表示处理全部' },
      sampleHoldout: { type: 'number', description: '留出比例，默认 0.1，用于日后盲测' },
      redact: { type: 'boolean', description: '打码手机号、身份证、邮箱、链接' },
    },
    required: ['file', 'persona'],
  },
} as const

const CHAT_TOOL = {
  name: 'chat_persona',
  description:
    '用指定人设回复一句话。读取 personas/<名字>/ 下的 persona.md、lore.md、style.md，按这个人的说话方式回一句。返回回复文本本身，没有任何解释。',
  inputSchema: {
    type: 'object',
    properties: {
      persona: { type: 'string', description: '已存在的人设目录名，例如 dennis' },
      message: { type: 'string', description: '对方这次说的话' },
      history: {
        type: 'array',
        description: '可选，之前的几轮对话，按时间顺序',
        items: {
          type: 'object',
          properties: {
            role: { type: 'string', enum: ['user', 'assistant'] },
            content: { type: 'string' },
          },
          required: ['role', 'content'],
        },
      },
    },
    required: ['persona', 'message'],
  },
} as const

const TOOLS = [FORGE_TOOL, CHAT_TOOL]

interface RpcRequest {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: unknown
}

/** Write one protocol message; the client reads stdout line by line. */
function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

/** Report progress without corrupting the protocol stream. */
function log(message: string): void {
  process.stderr.write(message.endsWith('\n') ? message : `${message}\n`)
}

/** Run `forge_persona` and return the text the client should show. */
async function callForge(args: Record<string, unknown>): Promise<string> {
  const file = typeof args.file === 'string' ? args.file : ''
  const persona = typeof args.persona === 'string' ? args.persona : ''
  if (file.length === 0 || persona.length === 0) throw new Error('file 和 persona 是必填参数')
  assertSafePersonaName(persona)

  const config = llmConfigFromEnv()
  if (config.apiKey.length === 0) {
    throw new LlmError('缺少 API key：先设置 PERSONAFORGE_API_KEY，或者在项目根目录建一个 .env')
  }

  const sourceFlag = typeof args.source === 'string' ? args.source : 'manual'
  if (!SOURCES.includes(sourceFlag as Source)) {
    throw new Error(`source 只能是 ${SOURCES.join(' / ')}`)
  }
  const me = typeof args.me === 'string' ? args.me.split(',').map((name) => name.trim()).filter((name) => name.length > 0) : []
  const friendName = typeof args.friend === 'string' && args.friend.length > 0 ? args.friend : undefined
  const display = typeof args.display === 'string' && args.display.length > 0 ? args.display : undefined
  const chunkSize = typeof args.chunkSize === 'number' && Number.isInteger(args.chunkSize) && args.chunkSize > 0 ? args.chunkSize : 60
  const sample = typeof args.sample === 'number' && Number.isInteger(args.sample) && args.sample > 0 ? args.sample : undefined
  const holdoutRatio = typeof args.sampleHoldout === 'number' && args.sampleHoldout >= 0 && args.sampleHoldout < 1 ? args.sampleHoldout : 0.1
  const redact = args.redact === true

  const result = await forgePersona({
    file,
    persona,
    selfNames: me.length > 0 ? me : ['我'],
    ...(friendName === undefined ? {} : { friendName }),
    ...(display === undefined ? {} : { display }),
    source: sourceFlag as Source,
    holdoutRatio,
    redact,
    chunkSize,
    maxChunks: 0,
    ...(sample === undefined ? {} : { sample }),
    config,
    onProgress: (message) => log(message),
  })

  return [
    `已生成人设：${result.personaFile}`,
    `风格指纹：${result.styleFile}`,
    `解析 ${result.total} 条（${result.self} / ${result.friend}），训练 ${result.train}，留出 ${result.holdout}`,
    `切成 ${result.chunks} 块，处理 ${result.processed} 块`,
    '',
    '这份人设是自动生成的：统计精确，模型读出来的特征需要人工核对。',
    `下一步可以跑 chat --persona ${result.persona}，或者 eval --persona ${result.persona} --n 10 做盲测。`,
  ].join('\n')
}

/** Run `chat_persona` and return the reply. */
async function callChat(args: Record<string, unknown>): Promise<string> {
  const persona = typeof args.persona === 'string' ? args.persona : ''
  const message = typeof args.message === 'string' ? args.message : ''
  if (persona.length === 0 || message.length === 0) throw new Error('persona 和 message 是必填参数')
  assertSafePersonaName(persona)

  const config = llmConfigFromEnv()
  if (config.apiKey.length === 0) {
    throw new LlmError('缺少 API key：先设置 PERSONAFORGE_API_KEY，或者在项目根目录建一个 .env')
  }

  const loaded = loadPersona(persona)
  const system = buildSystemPrompt(loaded, { disclose: false })

  const history = Array.isArray(args.history) ? args.history : []
  const turns = history.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return []
    const record = item as Record<string, unknown>
    const role = record.role === 'user' ? 'user' as const : record.role === 'assistant' ? 'assistant' as const : null
    const content = typeof record.content === 'string' ? record.content : ''
    return role !== null && content.length > 0 ? [{ role, content }] : []
  })

  return await complete(config, [
    { role: 'system', content: system },
    ...turns,
    { role: 'user', content: message },
  ])
}

/** Handle one JSON-RPC message and return the result object, if any. */
async function dispatch(request: RpcRequest): Promise<unknown> {
  switch (request.method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      }
    case 'notifications/initialized':
      return undefined
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: TOOLS }
    case 'tools/call': {
      const params = (request.params ?? {}) as { name?: string; arguments?: Record<string, unknown> }
      const args = params.arguments ?? {}
      log(`调用 ${String(params.name)}`)
      if (params.name === FORGE_TOOL.name) return { content: [{ type: 'text', text: await callForge(args) }] }
      if (params.name === CHAT_TOOL.name) return { content: [{ type: 'text', text: await callChat(args) }] }
      throw new Error(`未知工具：${String(params.name)}`)
    }
    default:
      throw new Error(`未知方法：${String(request.method)}`)
  }
}

const readline = createInterface({ input: process.stdin })
let queue: Promise<void> = Promise.resolve()

readline.on('line', (line) => {
  // Process messages one at a time; a forge run is long and stateful.
  queue = queue.then(async () => {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    let request: RpcRequest
    try {
      request = JSON.parse(trimmed) as RpcRequest
    } catch {
      return
    }
    try {
      const result = await dispatch(request)
      if (request.id !== undefined && result !== undefined) {
        send({ jsonrpc: '2.0', id: request.id, result })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Notifications have no id and must not be answered.
      if (request.id !== undefined) {
        send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message } })
      }
    }
  })
})

readline.on('close', () => {
  log('stdin closed, exiting')
})
