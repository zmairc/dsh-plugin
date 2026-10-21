import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * The DSH plugin imports `@deepseek-ai/dsh-tools`, which only exists when the
 * harness (or our local node_modules) is present. A clean checkout runs the
 * offline tests only, so this one skips instead of failing.
 */
test('the DSH plugin registers both tools without throwing', async (t) => {
  try {
    await import('@deepseek-ai/dsh-tools')
  } catch {
    t.skip('dsh-tools 未安装，跳过插件装配测试')
    return
  }

  const plugin = await import('../src/dsh/plugin.ts')
  const names: string[] = []
  plugin.apply({
    tools: {
      register: (tool: { name?: string }) => {
        names.push(tool.name ?? '')
      },
    },
  })

  assert.deepEqual(names, ['forge_persona', 'chat_persona'])
})
