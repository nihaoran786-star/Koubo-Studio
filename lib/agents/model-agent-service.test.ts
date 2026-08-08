import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runModelAgent } from './model-agent-service'

const projectId = 'test-model-agent-service'
const workspaceRoot = path.join(process.cwd(), 'data', 'workspaces', projectId)

afterEach(async () => fs.rm(workspaceRoot, { recursive: true, force: true }))

describe('runModelAgent', () => {
  it('returns provider configuration errors before model invocation', async () => {
    await expect(runModelAgent({
      projectId,
      featureType: 'digital-human',
      message: '生成文案',
      resolveProvider: async () => ({
        status: 'missing_credentials',
        source: 'model_provider_resolution',
        error: { code: 'missing_credentials', message: 'Provider 需要 API Key。' },
      }),
      requestChat: vi.fn(),
    })).resolves.toMatchObject({ status: 'needs_configuration', source: 'model_agent', error: { code: 'missing_credentials' } })
  })

  it('loads feature prompts and calls the adapter without persistent Pi sessions', async () => {
    const requestChat = vi.fn(async () => '模型回复')
    const result = await runModelAgent({
      projectId,
      featureType: 'digital-human',
      message: ' 生成一条口播 ',
      resolveProvider: async () => ({
        status: 'ok',
        source: 'model_provider_resolution',
        provider: { providerId: 'local', providerKind: 'local_openai_compatible', modelId: 'qwen2.5', baseUrl: 'http://127.0.0.1:11434/v1', authHeader: false },
      }),
      requestChat,
    })
    expect(result).toMatchObject({ status: 'ok', source: 'model_agent', sessionId: 'model-agent-digital-human', reply: '模型回复' })
    expect(requestChat).toHaveBeenCalledWith(expect.objectContaining({
      system: expect.stringContaining('数字人'),
      user: expect.stringContaining('用户输入：\n生成一条口播'),
    }))
  })
})
