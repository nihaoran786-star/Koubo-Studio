import { describe, expect, it, vi } from 'vitest'
import { requestOpenAICompatibleChat } from './openai-compatible-chat-adapter'
import type { ResolvedModelProvider } from './model-provider-resolution'

const provider: ResolvedModelProvider = {
  providerId: 'local',
  providerKind: 'local_openai_compatible',
  modelId: 'qwen2.5',
  baseUrl: 'http://127.0.0.1:11434/v1/',
  authHeader: false,
}

describe('requestOpenAICompatibleChat', () => {
  it('posts system and user messages and reads text content', async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = []
    const fetcher: typeof fetch = async (url, init) => {
      calls.push([url, init])
      return Response.json({ choices: [{ message: { content: '  完成  ' } }] })
    }
    await expect(requestOpenAICompatibleChat({ provider, system: '系统', user: '用户', fetcher })).resolves.toBe('完成')
    const [url, init] = calls[0]
    expect(String(url)).toBe('http://127.0.0.1:11434/v1/chat/completions')
    expect(init?.headers).not.toHaveProperty('authorization')
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'qwen2.5',
      messages: [{ role: 'system', content: '系统' }, { role: 'user', content: '用户' }],
      stream: false,
    })
  })

  it('adds bearer auth and reads content parts', async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = []
    const fetcher: typeof fetch = async (url, init) => {
      calls.push([url, init])
      return Response.json({ choices: [{ message: { content: [{ text: '第一段' }, { text: '第二段' }] } }] })
    }
    await expect(requestOpenAICompatibleChat({ provider: { ...provider, apiKey: 'secret' }, system: '', user: '', fetcher })).resolves.toBe('第一段第二段')
    expect(calls[0][1]?.headers).toMatchObject({ authorization: 'Bearer secret' })
  })

  it('sends bounded generation options only when requested', async () => {
    let body: Record<string, unknown> | undefined
    const usages: unknown[] = []
    await requestOpenAICompatibleChat({
      provider,
      system: '系统',
      user: '用户',
      maxOutputTokens: 220,
      temperature: 0.1,
      onUsage: (usage) => usages.push(usage),
      fetcher: async (_url, init) => {
        body = JSON.parse(String(init?.body))
        return Response.json({
          choices: [{ message: { content: '完成' } }],
          usage: { prompt_tokens: 123, completion_tokens: 18, total_tokens: 141 },
        })
      },
    })
    expect(body).toMatchObject({ max_tokens: 220, temperature: 0.1 })
    expect(usages).toEqual([{ inputTokens: 123, outputTokens: 18, totalTokens: 141 }])
  })

  it('supports reasoning-aware completion limits for compatible models', async () => {
    let body: Record<string, unknown> | undefined
    await requestOpenAICompatibleChat({
      provider,
      system: '系统',
      user: '用户',
      maxCompletionTokens: 220,
      reasoningEffort: 'low',
      fetcher: async (_url, init) => {
        body = JSON.parse(String(init?.body))
        return Response.json({ choices: [{ message: { content: '完成' } }] })
      },
    })
    expect(body).toMatchObject({
      max_completion_tokens: 220,
      reasoning_effort: 'low',
    })
    expect(body).not.toHaveProperty('max_tokens')
  })

  it('can explicitly disable provider thinking without exposing reasoning content', async () => {
    let body: Record<string, unknown> | undefined
    const result = await requestOpenAICompatibleChat({
      provider,
      system: '系统',
      user: '用户',
      maxOutputTokens: 1_400,
      thinkingMode: 'disabled',
      fetcher: async (_url, init) => {
        body = JSON.parse(String(init?.body))
        return Response.json({
          choices: [{
            finish_reason: 'stop',
            message: {
              reasoning_content: 'private reasoning must not be returned',
              content: '{"subtitle":{"enabled":false}}',
            },
          }],
        })
      },
    })
    expect(result).toBe('{"subtitle":{"enabled":false}}')
    expect(result).not.toContain('private reasoning')
    expect(body).toMatchObject({
      max_tokens: 1_400,
      thinking: { type: 'disabled' },
    })
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  it('never treats a reasoning-only length response as assistant content', async () => {
    const result = requestOpenAICompatibleChat({
      provider,
      system: '系统',
      user: '用户',
      fetcher: async () => Response.json({
        choices: [{
          finish_reason: 'length',
          message: {
            reasoning_content: 'private reasoning that is not a plan',
            content: null,
          },
        }],
      }),
    })
    await expect(result).rejects.toMatchObject({
      code: 'invalid_response',
      message: '模型服务没有返回有效文本。',
    })
    await expect(result).rejects.not.toThrow(/private reasoning/)
  })

  it.each([
    [401, 'auth_error'],
    [403, 'auth_error'],
    [404, 'model_error'],
    [429, 'quota_error'],
    [500, 'http_error'],
  ] as const)('classifies HTTP %s', async (status, code) => {
    await expect(requestOpenAICompatibleChat({ provider, system: '', user: '', fetcher: async () => new Response('', { status }) })).rejects.toMatchObject({ code })
  })

  it('classifies invalid and network responses without exposing raw errors', async () => {
    await expect(requestOpenAICompatibleChat({ provider, system: '', user: '', fetcher: async () => Response.json({ choices: [] }) })).rejects.toMatchObject({ code: 'invalid_response' })
    await expect(requestOpenAICompatibleChat({ provider, system: '', user: '', fetcher: async () => { throw new Error('C:/secret/path') } })).rejects.toMatchObject({ code: 'network_error' })
  })

  it('aborts slow requests with a stable timeout error', async () => {
    const fetcher = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    await expect(requestOpenAICompatibleChat({ provider, system: '', user: '', fetcher, timeoutMs: 5 })).rejects.toMatchObject({ code: 'timeout' })
  })
})
