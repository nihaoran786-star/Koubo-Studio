import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  ModelChatError,
  type OpenAICompatibleChatInput,
} from '@/lib/model-providers/openai-compatible-chat-adapter'
import { createDefaultEditPlan } from './edit-plan'
import { generateAiEditPlan } from './edit-plan-agent'

const provider = {
  status: 'ok' as const,
  source: 'model_provider_resolution' as const,
  provider: {
    providerId: 'local',
    providerKind: 'local_openai_compatible' as const,
    modelId: 'qwen',
    baseUrl: 'http://127.0.0.1:11434/v1',
    authHeader: false,
  },
}

function decision(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    r: '9:16',
    f: 'cover',
    s: 'bold',
    c: 12,
    vv: 1,
    bg: null,
    bv: 0.16,
    i: null,
    o: null,
    ct: 0,
    p: 'preserve',
    ep: 'energetic',
    mo: 'punch',
    cp: 'impact',
    cg: 'vivid',
    fx: 'subtle',
    hk: '先看结果',
    kw: [],
    ef: ['animated-captions', 'hook-card', 'punch-zoom'],
    ...overrides,
  }
}

describe('generateAiEditPlan', () => {
  it('sends compact business context and merges a bounded decision into EditPlan v1', async () => {
    const requestChat = vi.fn(async (_input: OpenAICompatibleChatInput) => JSON.stringify(decision()))
    const result = await generateAiEditPlan({
      instruction: '字幕醒目一些',
      script: '公开口播文案',
      currentPlan: createDefaultEditPlan(),
      availableAssets: [{ assetId: 'bgm-001', kind: 'background_music' }],
      resolveProvider: async () => provider,
      requestChat,
    })

    expect(result).toMatchObject({ status: 'ok', plan: { subtitles: { style: 'bold' } } })
    const call = requestChat.mock.calls[0][0]
    expect(JSON.parse(call.user)).toEqual({
      i: '字幕醒目一些',
      t: '公开口播文案',
      n: 6,
      d: 0,
      p: {
        r: '9:16',
        f: 'cover',
        s: 'clean',
        c: 18,
        vv: 1,
        bg: null,
        bv: 0.16,
        i: null,
        o: null,
        ct: 0,
        pace: 'preserve',
        ep: 'clean',
        mo: 'none',
        cp: 'static',
        cg: 'natural',
        fx: 'off',
        ef: [],
      },
      a: [['b', 'bgm-001']],
      e: [
        'animated-captions',
        'hook-card',
        'punch-zoom',
        'progress-line',
        'light-leak',
        'film-burn',
        'focus-glow',
      ],
    })
    expect(call.user).not.toMatch(/C:\\|workspace|ffmpeg|executor/i)
    expect(call.system).toContain('短字段')
    expect(call.maxOutputTokens).toBe(700)
    expect(call.temperature).toBe(0.1)
    expect(result).toMatchObject({
      usage: {
        source: 'model',
        maxOutputTokens: 700,
        cacheKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    })
  })

  it('returns a stable configuration error without invoking the model', async () => {
    const requestChat = vi.fn()
    const result = await generateAiEditPlan({
      instruction: '精剪',
      script: '文案',
      currentPlan: createDefaultEditPlan(),
      availableAssets: [],
      resolveProvider: async () => ({
        status: 'missing_credentials',
        source: 'model_provider_resolution',
        error: { code: 'missing_credentials', message: '请配置 Provider。' },
      }),
      requestChat,
    })
    expect(result).toMatchObject({ status: 'needs_configuration', error: { code: 'ai_provider_missing_credentials' } })
    expect(requestChat).not.toHaveBeenCalled()
  })

  it.each(['command', 'path', 'args', 'skill', 'executor'])('rejects forbidden model field %s', async (key) => {
    const requestChat = vi.fn(async () => JSON.stringify({ ...decision(), [key]: 'unsafe' }))
    const result = await generateAiEditPlan({
      instruction: '精剪', script: '文案', currentPlan: createDefaultEditPlan(), availableAssets: [],
      resolveProvider: async () => provider, requestChat,
    })
    expect(result).toMatchObject({ status: 'agent_error', error: { code: 'forbidden_ai_edit_plan_field' } })
  })

  it('rejects unknown fields before EditPlan parsing', async () => {
    const requestChat = vi.fn(async () => JSON.stringify({
      ...decision(),
      animation: 'bounce',
    }))
    const result = await generateAiEditPlan({
      instruction: '精剪', script: '文案', currentPlan: createDefaultEditPlan(), availableAssets: [],
      resolveProvider: async () => provider, requestChat,
    })
    expect(result).toMatchObject({ status: 'agent_error', error: { code: 'unknown_ai_edit_plan_field' } })
  })

  it('drops model emphasis words that are absent from the approved script', async () => {
    const requestChat = vi.fn(async () => JSON.stringify(decision({
      kw: ['真实口播', '模型臆造词'],
    })))
    const result = await generateAiEditPlan({
      instruction: '精剪',
      script: '这是一段真实口播文案。',
      currentPlan: createDefaultEditPlan(),
      availableAssets: [],
      resolveProvider: async () => provider,
      requestChat,
    })

    expect(result).toMatchObject({
      status: 'ok',
      plan: {
        creative: {
          emphasis: ['真实口播'],
        },
      },
    })
  })

  it('classifies invalid JSON, invalid plan values and model failures', async () => {
    const base = { instruction: '精剪', script: '文案', currentPlan: createDefaultEditPlan(), availableAssets: [], resolveProvider: async () => provider }
    await expect(generateAiEditPlan({ ...base, requestChat: async () => '```json\n{}\n```' })).resolves.toMatchObject({ error: { code: 'invalid_ai_edit_plan_json' } })
    await expect(generateAiEditPlan({ ...base, requestChat: async () => JSON.stringify(decision({ r: '4:3' })) })).resolves.toMatchObject({ error: { code: 'invalid_ratio' } })
    await expect(generateAiEditPlan({ ...base, requestChat: async () => { throw new ModelChatError('timeout', '超时') } })).resolves.toMatchObject({ status: 'agent_error', error: { code: 'ai_model_timeout' } })
  })

  it('bounds long scripts and rejects an asset id that was not supplied', async () => {
    const requestChat = vi.fn(async () => JSON.stringify(decision({ bg: 'invented-bgm' })))
    const result = await generateAiEditPlan({
      instruction: '精剪',
      script: '长文案'.repeat(2000),
      currentPlan: createDefaultEditPlan(),
      availableAssets: [],
      resolveProvider: async () => provider,
      requestChat,
    })
    expect(result).toMatchObject({ status: 'agent_error', error: { code: 'unknown_ai_asset' } })
    const [call] = requestChat.mock.calls[0] as unknown as [OpenAICompatibleChatInput]
    const context = JSON.parse(call.user)
    expect(context.t.length).toBeLessThanOrEqual(1800)
    expect(call.user.length).toBeLessThan(2600)
  })

  it('reuses a validated persistent plan without spending a second model call', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'koubo-ai-plan-cache-'))
    const requestChat = vi.fn(async () => JSON.stringify(decision({ p: 'tight' })))
    const input = {
      instruction: '去掉长停顿，节奏紧凑',
      script: '这是一段需要自动剪辑的口播文案。',
      currentPlan: createDefaultEditPlan(),
      availableAssets: [],
      cacheDirectory: directory,
      resolveProvider: async () => provider,
      requestChat,
    }
    try {
      const first = await generateAiEditPlan(input)
      const second = await generateAiEditPlan(input)
      expect(first).toMatchObject({
        status: 'ok',
        source: 'ai_edit_plan_agent',
        plan: { timeline: { removeSilence: true } },
        usage: { source: 'model' },
      })
      expect(second).toMatchObject({
        status: 'ok',
        source: 'ai_edit_plan_cache',
        plan: { timeline: { removeSilence: true } },
        usage: { source: 'cache' },
      })
      expect(requestChat).toHaveBeenCalledTimes(1)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('uses low reasoning without temperature overrides for Gemini 3 planning', async () => {
    const requestChat = vi.fn(async (_input: OpenAICompatibleChatInput) => JSON.stringify(decision()))
    const result = await generateAiEditPlan({
      instruction: '自动剪辑',
      script: '短文案',
      currentPlan: createDefaultEditPlan(),
      availableAssets: [],
      resolveProvider: async () => ({
        status: 'ok',
        source: 'model_provider_resolution',
        provider: {
          providerId: 'gemini',
          providerKind: 'custom_openai_compatible',
          modelId: 'gemini-3.1-pro-preview',
          baseUrl: 'https://example.invalid/v1',
          authHeader: true,
        },
      }),
      requestChat,
    })
    expect(result).toMatchObject({
      status: 'ok',
      usage: { maxOutputTokens: 700 },
    })
    expect(requestChat.mock.calls[0][0]).toMatchObject({
      maxOutputTokens: 700,
      reasoningEffort: 'low',
    })
    expect(requestChat.mock.calls[0][0].temperature).toBeUndefined()
  })

  it('disables thinking only for deepseek-v4-flash while preserving its output headroom', async () => {
    const requestChat = vi.fn(async (_input: OpenAICompatibleChatInput) => JSON.stringify(decision()))
    const result = await generateAiEditPlan({
      instruction: '自动剪辑',
      script: '短文案',
      currentPlan: createDefaultEditPlan(),
      availableAssets: [],
      resolveProvider: async () => ({
        status: 'ok',
        source: 'model_provider_resolution',
        provider: {
          providerId: 'deepseek',
          providerKind: 'custom_openai_compatible',
          modelId: 'deepseek-v4-flash',
          baseUrl: 'https://example.invalid/v1',
          authHeader: true,
        },
      }),
      requestChat,
    })
    expect(result).toMatchObject({
      status: 'ok',
      usage: { maxOutputTokens: 1_400 },
    })
    expect(requestChat.mock.calls[0][0]).toMatchObject({
      maxOutputTokens: 1_400,
      thinkingMode: 'disabled',
    })
    expect(requestChat.mock.calls[0][0].reasoningEffort).toBeUndefined()
    expect(requestChat.mock.calls[0][0].temperature).toBeUndefined()
  })
})
