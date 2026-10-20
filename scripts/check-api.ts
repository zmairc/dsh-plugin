/**
 * Connectivity self-check for the model endpoint.
 *
 * `node scripts/check-api.ts`
 *
 * Separates the three failure classes that all look like "it doesn't work":
 * a missing key, an account or key the provider rejects, and a reachable
 * endpoint that cannot complete a request.
 */

import { llmConfigFromEnv } from '../src/core/llm.ts'

const config = llmConfigFromEnv()

console.log(`BASE_URL  ${config.baseUrl}`)
console.log(`MODEL     ${config.model}`)

if (config.apiKey.length === 0) {
  console.error('\n✗ 没有找到 API key。设置 PERSONAFORGE_API_KEY 或 DEEPSEEK_API_KEY。')
  process.exit(1)
}

const clean = /^sk-[0-9a-f]{32}$/.test(config.apiKey)
const odd = [...config.apiKey].filter((char) => char.codePointAt(0)! < 0x21 || char.codePointAt(0)! > 0x7e)
console.log(`API KEY   长度 ${config.apiKey.length}，尾号 ${config.apiKey.slice(-4)}，格式${clean ? '正常' : '异常'}${odd.length > 0 ? `，含 ${odd.length} 个不可见字符` : ''}`)

/** Report a response line and its parsed error, when there is one. */
async function probe(label: string, url: string, init: RequestInit): Promise<number> {
  console.log(`\n[${label}] ${url}`)
  try {
    const response = await fetch(url, init)
    const body = await response.text()
    console.log(`  HTTP ${response.status}`)
    console.log(`  ${body.slice(0, 400)}`)
    return response.status
  } catch (error) {
    console.log(`  网络错误：${error instanceof Error ? error.message : String(error)}`)
    return 0
  }
}

const auth = { Authorization: `Bearer ${config.apiKey}` }

// The balance endpoint proves the credential without spending tokens. It is
// DeepSeek-specific, so a 404 here is not a failure.
const balanceStatus = await probe('余额', `${config.baseUrl}/user/balance`, { headers: auth })

const chatStatus = await probe('对话', `${config.baseUrl}/chat/completions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...auth },
  body: JSON.stringify({
    model: config.model,
    messages: [{ role: 'user', content: '回复两个字：收到' }],
    max_tokens: 10,
  }),
})

console.log('\n──────── 结论 ────────')
if (balanceStatus === 200 || chatStatus === 200) {
  console.log('✓ 接口可用。继续跑：node src/cli/index.ts chat --persona dennis')
} else if (chatStatus === 401 || balanceStatus === 401) {
  console.log('✗ 服务端不认这把 key。到 platform.deepseek.com/api_keys 确认它是')
  console.log('  列表里当前存在的那一把——创建后只完整显示一次，之后只能看到首尾。')
  console.log('  如果列表里的 key 已经是别的尾号，说明这把已经被删了，重新建一把。')
} else if (chatStatus === 402) {
  console.log('✗ 余额不足。去 platform.deepseek.com/top_up 充值。')
} else if (chatStatus === 404) {
  console.log('✗ 端点或模型名不存在。检查 PERSONAFORGE_BASE_URL 和 PERSONAFORGE_MODEL。')
} else if (chatStatus === 0) {
  console.log('✗ 网络不通。可能是代理、防火墙，或需要换个网络环境。')
} else {
  console.log('✗ 请求被拒，把上面的响应原文发出来。')
}
