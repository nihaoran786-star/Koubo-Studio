import { describe, expect, it, vi } from 'vitest'
import { testModelProviderConnection } from './model-provider-test-service'
import type { StoredModelProvider } from './model-provider-types'

const baseProvider: StoredModelProvider = {
  id: 'openai',
  kind: 'openai',
  name: 'OpenAI API',
  enabled: true,
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4.1-mini',
  apiKey: 'secret',
  status: 'configured',
}

describe('model provider test service', () => {
  it('checks OpenAI-compatible models endpoint with bearer credentials', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }))

    await expect(
      testModelProviderConnection({
        provider: baseProvider,
        fetcher,
        now: () => new Date('2026-06-11T00:00:00.000Z'),
      }),
    ).resolves.toEqual({
      status: 'connected',
      source: 'model_provider_test',
      providerId: 'openai',
      testedAt: '2026-06-11T00:00:00.000Z',
    })
    expect(fetcher).toHaveBeenCalledWith(
      new URL('https://api.openai.com/v1/models'),
      expect.objectContaining({
        method: 'GET',
        signal: expect.any(AbortSignal),
        headers: {
          Authorization: 'Bearer secret',
        },
      }),
    )
  })

  it('normalizes auth failures', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: 'bad key' }), { status: 401 }))

    await expect(
      testModelProviderConnection({
        provider: baseProvider,
        fetcher,
      }),
    ).resolves.toMatchObject({
      status: 'auth_error',
      error: {
        code: 'auth_error',
      },
    })
  })

  it('reports missing credentials before network access', async () => {
    const fetcher = vi.fn()

    await expect(
      testModelProviderConnection({
        provider: {
          ...baseProvider,
          apiKey: '',
        },
        fetcher,
      }),
    ).resolves.toMatchObject({
      status: 'missing_credentials',
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('stops an unresponsive Provider probe after the configured short timeout', async () => {
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      }),
    ) as typeof fetch

    await expect(
      testModelProviderConnection({
        provider: baseProvider,
        fetcher,
        timeoutMs: 5,
      }),
    ).resolves.toMatchObject({
      status: 'network_error',
      error: {
        code: 'network_error',
        message: '连接 Provider 超时，请检查服务是否已启动。',
      },
    })
  })
})
