/**
 * DSH plugin entry.
 *
 * Exposes persona-forge to the harness as two model-facing tools:
 *   - `forge_persona` turns a transcript file into a persona pack;
 *   - `chat_persona` replies in that persona's voice.
 *
 * The plugin is intentionally thin: everything it calls lives in `src/core`, so
 * the same logic backs the CLI, the MCP server, and this plugin.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { appendFileSync, readFileSync } from 'node:fs'
import { LlmError, complete, llmConfigFromEnv } from '../core/llm.ts'
import { forgePersona, assertSafePersonaName } from '../core/forge.ts'
import { buildSystemPrompt, isSkip, loadPersona, mustAnswerHint, SKIP_MARKER } from '../core/persona.ts'
import { loadDotEnv } from '../core/env.ts'
import { dataPath, readJsonl, rootDir, setRoot } from '../core/archive.ts'
import { computeStats } from '../core/stats.ts'
import { lengthPlanFromStats, longHint, shouldAskForLong } from '../core/reply-length.ts'
import type { ChatMessage, Source } from '../core/types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'persona-forge'

/** Services required by this plugin. */
export const inject = ['tools']

const SOURCES: readonly Source[] = ['wechat', 'qq', 'douyin', 'manual']

/**
 * Which build of this plugin is answering, and where it reads personas from.
 *
 * The installed plugin runs the compiled `dist/` from npm, so editing `src/`
 * changes nothing until a release and an update — and the failure mode is
 * silent. Printing both facts in the result makes that visible in one line.
 * @returns a short diagnostic line.
 */
function buildInfo(): string {
  let version = 'unknown'
  try {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown }
    if (typeof manifest.version === 'string') version = manifest.version
  } catch {
    // A missing manifest must not fail a tool call; the line still says where.
  }
  return `persona-forge ${version} · ROOT ${rootDir()}`
}

/**
 * Point persona storage at the session's own workspace.
 *
 * The harness process is not started from the user's project — its `cwd` is
 * wherever the launcher ran — so `process.cwd()` is the wrong guess for where
 * `personas/` and `.env` live. The session header carries the directory the
 * user actually opened, the same anchor the harness's own file tools use.
 * Retargeting per call keeps one plugin instance correct across sessions with
 * different workspaces.
 * @param exec - the tool execution context handed to `execute`.
 */
function retargetToSession(exec: unknown): void {
  const header = (exec as { agent?: { session?: { header?: { cwd?: unknown } } } } | undefined)?.agent?.session?.header
  const cwd = header?.cwd
  if (typeof cwd === 'string' && cwd.trim().length > 0) setRoot(cwd)
}

/** Run `forge_persona` and return the summary text. */
async function callForge(args: Record<string, unknown>): Promise<string> {
  const file = typeof args.file === 'string' ? args.file : ''
  const persona = typeof args.persona === 'string' ? args.persona : ''
  if (file.length === 0 || persona.length === 0) throw new Error('file 和 persona 是必填参数')
  assertSafePersonaName(persona)

  const config = llmConfigFromEnv()
  if (config.apiKey.length === 0) {
    throw new LlmError('缺少 API key：设置 PERSONAFORGE_API_KEY，或者在项目根目录建一个 .env')
  }

  const sourceFlag = typeof args.source === 'string' ? args.source : 'manual'
  if (!SOURCES.includes(sourceFlag as Source)) {
    throw new Error(`source 只能是 ${SOURCES.join(' / ')}`)
  }
  const me = typeof args.me === 'string' ? args.me.split(',').map((item) => item.trim()).filter((item) => item.length > 0) : []
  const friendName = typeof args.friend === 'string' && args.friend.length > 0 ? args.friend : undefined
  const display = typeof args.display === 'string' && args.display.length > 0 ? args.display : undefined
  const chunkSize = typeof args.chunkSize === 'number' && Number.isInteger(args.chunkSize) && args.chunkSize > 0 ? args.chunkSize : 60
  const sample = typeof args.sample === 'number' && Number.isInteger(args.sample) && args.sample > 0 ? args.sample : undefined
  const holdoutRatio = typeof args.sampleHoldout === 'number' && args.sampleHoldout >= 0 && args.sampleHoldout < 1 ? args.sampleHoldout : 0.1
  const recentMonths = typeof args.recent === 'number' && Number.isInteger(args.recent) && args.recent > 0 ? args.recent : undefined
  const redact = args.redact === true

  // A 142-chunk run shows nothing until it ends, so progress goes to a file the
  // user can tail from another window. Failing to write the log must never
  // abort the run itself.
  const progressLog = dataPath(`${persona}.progress.log`)
  const noteProgress = (message: string): void => {
    try {
      appendFileSync(progressLog, message)
    } catch {
      // Read-only data directory, or a path that vanished mid-run: ignore.
    }
  }
  noteProgress(`开始 ${new Date().toISOString()}\n源文件 ${file}\n`)

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
    ...(recentMonths === undefined ? {} : { recentMonths }),
    config,
    onProgress: noteProgress,
  })
  noteProgress(`完成 ${new Date().toISOString()}\n`)

  return [
    `已生成人设：${result.personaFile}`,
    `风格指纹：${result.styleFile}`,
    `解析 ${result.total} 条（${result.self} / ${result.friend}），训练 ${result.train}，留出 ${result.holdout}`,
    `切成 ${result.chunks} 块，处理 ${result.processed} 块`,
    `覆盖 ${result.chunks - result.failed}/${result.chunks} 块对话`,
    `累计 ${result.usage.calls} 次模型调用，输入 ${result.usage.promptTokens} / 输出 ${result.usage.completionTokens} token`,
    `进度日志：${progressLog}`,
    ...(result.recentMonths === undefined ? [] : [`只用了最近 ${result.recentMonths} 个月，丢弃 ${result.droppedByRecent} 条更早的消息`]),
    ...(result.sampled ? ['', '注意：这是抽样试跑，写在 persona.sample.md，正式人设没有被覆盖。'] : []),
    ...(result.backups.length > 0 ? ['', `覆盖前的旧文件已备份：${result.backups.join('、')}`] : []),
    '',
    '这份人设是自动生成的：统计精确，模型读出来的特征需要人工核对。',
    buildInfo(),
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
    throw new LlmError('缺少 API key：设置 PERSONAFORGE_API_KEY，或者在项目根目录建一个 .env')
  }

  const loaded = loadPersona(persona)
  let system = buildSystemPrompt(loaded, { disclose: false })

  const history = Array.isArray(args.history) ? args.history : []
  const turns = history.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return []
    const record = item as Record<string, unknown>
    const role = record.role === 'user' ? 'user' as const : record.role === 'assistant' ? 'assistant' as const : null
    const content = typeof record.content === 'string' ? record.content : ''
    return role !== null && content.length > 0 ? [{ role, content }] : []
  })

  // Two skips in a row is not a person ignoring you, it is a broken bot, so a
  // turn that follows silence has to answer. That wins over length balancing.
  const lastTurn = turns.at(-1)
  const lastWasSkip = lastTurn !== undefined && lastTurn.role === 'assistant' && isSkip(lastTurn.content)
  if (lastWasSkip) {
    system += `\n\n${mustAnswerHint()}`
  } else {
    // Balance reply length over the caller's history. This tool is stateless, so
    // without a few past turns there is nothing to balance and the persona's own
    // length rules stand alone.
    const archive = readJsonl<ChatMessage>(dataPath(`${persona}.jsonl`))
    if (archive.length > 0) {
      const plan = lengthPlanFromStats(computeStats(archive))
      const lengths = turns.filter((turn) => turn.role === 'assistant').map((turn) => turn.content.length)
      if (shouldAskForLong(lengths, plan)) system += `\n\n${longHint(plan.threshold)}`
    }
  }

  const reply = await complete(config, [
    { role: 'system', content: system },
    ...turns,
    { role: 'user', content: message },
  ])
  // Silence is an outcome, not an error. It travels back as the marker so the
  // caller can decide to send nothing, and so a later turn can forbid a repeat.
  return isSkip(reply) ? SKIP_MARKER : reply
}

/**
 * Register the persona-forge tools on the harness.
 * @param ctx - registrant context carrying the tool registry.
 */
export function apply(ctx: { tools: { register: (tool: unknown) => void } }): void {
  // `.env` is read per call, after the session workspace is known: loading it
  // here would pin the lookup to the harness process's own directory.

  ctx.tools.register(defineTool({
    name: 'forge_persona',
    description:
      '从一份聊天记录 txt 生成可以扮演的人设。自动解析说话人、统计说话风格、让模型逐块读对话，写出 persona.md 和 style.md。适合用户把导出的聊天记录存成一个 txt 后直接调用。',
    parameters: {
      file: { type: 'string', required: true, description: '聊天记录 txt 的绝对路径' },
      persona: { type: 'string', required: true, description: '人设目录名，只能字母数字下划线短横线' },
      me: { type: 'string', description: '你自己的显示名，多个用逗号分隔，默认「我」' },
      friend: { type: 'string', description: '要模仿的人的显示名；不填则取出现最多的另一方' },
      display: { type: 'string', description: '人设标题用的名字，比如真名；默认用记录里的昵称' },
      source: { type: 'string', enum: [...SOURCES], description: '记录来源，默认 manual' },
      chunkSize: { type: 'integer', description: '每次模型调用读多少条消息，默认 60' },
      sample: { type: 'integer', description: '只均匀抽样这么多块来控制花费；不填表示处理全部' },
      recent: { type: 'integer', description: '只用最近 N 个月的记录（风格会漂移，全量蒸馏等于把两个时期的他平均掉）' },
      sampleHoldout: { type: 'number', description: '留出比例，默认 0.1，用于日后盲测' },
      redact: { type: 'boolean', description: '打码手机号、学号、身份证、邮箱、链接' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_args: unknown, value: { text: string }) => [{ type: 'text' as const, text: value.text }],
    },
    execute: async (args: Record<string, unknown>, exec?: unknown) => {
      retargetToSession(exec)
      loadDotEnv()
      return { text: await callForge(args) }
    },
    presentCall: () => ({ card: 'generic' as const, title: '生成人设', kind: 'other' as const }),
  }))

  ctx.tools.register(defineTool({
    name: 'chat_persona',
    description:
      '用指定人设回复一句话。读取 personas/<名字>/ 下的 persona.md、lore.md、style.md，按这个人的说话方式回一句。返回回复文本本身，没有任何解释。如果返回 [SKIP]，表示这个人看了一眼但没打算接这句话——不要发消息，也不要换个说法追问。',
    parameters: {
      persona: { type: 'string', required: true, description: '已存在的人设目录名，例如 dennis' },
      message: { type: 'string', required: true, description: '对方这次说的话' },
      history: {
        type: 'array',
        description: '可选，之前的几轮对话，按时间顺序',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            role: { type: 'string', required: true, enum: ['user', 'assistant'] },
            content: { type: 'string', required: true },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_args: unknown, value: { text: string }) => [{ type: 'text' as const, text: value.text }],
    },
    execute: async (args: Record<string, unknown>, exec?: unknown) => {
      retargetToSession(exec)
      loadDotEnv()
      return { text: await callChat(args) }
    },
    presentCall: () => ({ card: 'generic' as const, title: '按人设回复', kind: 'other' as const }),
  }))
}
