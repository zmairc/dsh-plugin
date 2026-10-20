/**
 * MCP 客户端冒烟测试：像 Claude Desktop / Claude Code 那样，用标准 JSON-RPC
 * 跟 `src/mcp/server.ts` 通信，真实调用一次 `forge_persona`。
 *
 * 用法（需要 API key）：
 *
 *   $env:PERSONAFORGE_API_KEY = "sk-..."
 *   node scripts/mcp-smoke.ts
 *
 * 默认用公开示例，只跑 2 块，几十秒。想换文件：
 *
 *   node scripts/mcp-smoke.ts --file "E:\path\chat.txt" --persona myname --display 某人 --sample 40
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { ROOT } from '../src/core/archive.ts'

/** 读取 `--name value` 形式的参数。 */
function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}

const serverPath = fileURLToPath(new URL('../src/mcp/server.ts', import.meta.url))
const server = spawn(process.execPath, [serverPath], {
  cwd: ROOT,
  stdio: ['pipe', 'pipe', 'inherit'],
})

const reader = createInterface({ input: server.stdout })
let nextId = 1
const pending = new Map<number, (message: unknown) => void>()

reader.on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return
  let message: { id?: number }
  try {
    message = JSON.parse(trimmed) as { id?: number }
  } catch {
    return
  }
  if (message.id !== undefined) pending.get(message.id)?.(message)
})

/** 发送一条 JSON-RPC 请求并等待响应。 */
function request(method: string, params: unknown, timeoutMs = 300_000): Promise<Record<string, unknown>> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`等待 ${method} 超时`))
    }, timeoutMs)
    pending.set(id, (message) => {
      clearTimeout(timer)
      resolve(message as Record<string, unknown>)
    })
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

/** 发送一条不需要响应的通知。 */
function notify(method: string, params?: unknown): void {
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
}

try {
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'persona-forge-smoke', version: '0.1.0' },
  })
  console.log('initialize:', JSON.stringify(init, null, 2))
  notify('notifications/initialized')

  const tools = await request('tools/list', {})
  const list = (tools.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []
  console.log(`\ntools/list: ${list.length} 个工具 -> ${list.map((tool) => tool.name).join(', ')}`)

  const file = flag('file', 'examples/public/transcript.txt')
  const persona = flag('persona', 'mcp-demo')
  const display = flag('display', '阿凯')
  const me = flag('me', '我')
  const sample = flag('sample', '')

  console.log(`\ntools/call: forge_persona(${file} -> personas/${persona})`)
  const call = await request('tools/call', {
    name: 'forge_persona',
    arguments: {
      file,
      persona,
      me,
      display,
      ...(sample.length > 0 ? { sample: Number(sample) } : {}),
    },
  })

  if (call.error !== undefined) {
    console.error('\n调用失败：', JSON.stringify(call.error, null, 2))
    process.exitCode = 1
  } else {
    const content = (call.result as { content?: Array<{ type: string; text?: string }> } | undefined)?.content ?? []
    for (const item of content) console.log(`\n${item.text ?? JSON.stringify(item)}`)
  }
} catch (error) {
  console.error('冒烟测试失败：', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  server.kill()
}
