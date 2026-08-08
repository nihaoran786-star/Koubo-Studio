import { describe, expect, it, vi } from 'vitest'
import { readModelProviderSmokeConfig, runModelProviderRuntimeSmoke } from './model-provider-runtime-smoke.mjs'

describe('model provider runtime smoke', () => {
  it('is opt-in and uses model-provider names only', async () => {
    const logger = { log: vi.fn(), error: vi.fn() }
    await expect(runModelProviderRuntimeSmoke({ env: {}, logger })).resolves.toEqual({ status: 'skipped', reason: 'disabled' })
    expect(readModelProviderSmokeConfig({
      RUN_MODEL_PROVIDER_SMOKE: '1',
      MODEL_PROVIDER_SMOKE_BACKEND_URL: 'http://127.0.0.1:3100/',
    })).toMatchObject({ enabled: true, backendUrl: 'http://127.0.0.1:3100', projectId: 'model-provider-smoke' })
  })

  it('tests the selected provider and creates a real script artifact without skill metadata', async () => {
    const calls = []
    const fetcher = vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), init })
      if (init.method === 'GET') return json({ settings: { defaultProviderId: 'deepseek' } })
      if (String(url).endsWith('/api/settings/model-providers')) return json({ status: 'ok' })
      return json({
        status: 'ok',
        artifact: { artifactId: 'script-001', content: { title: '标题', body: '正文' } },
      })
    })
    const result = await runModelProviderRuntimeSmoke({
      env: {
        RUN_MODEL_PROVIDER_SMOKE: '1',
        MODEL_PROVIDER_SMOKE_BACKEND_URL: 'http://127.0.0.1:3100',
      },
      fetcher,
      logger: { log: vi.fn(), error: vi.fn() },
    })
    expect(result).toEqual({ status: 'ok', providerId: 'deepseek', artifactId: 'script-001' })
    const scriptCall = calls.find((call) => call.url.includes('/script-agent'))
    expect(JSON.parse(scriptCall.init.body)).toEqual({
      message: expect.any(String),
      approvalStatus: 'draft',
    })
  })

  it('rejects template provider configuration before network calls', async () => {
    const fetcher = vi.fn()
    const result = await runModelProviderRuntimeSmoke({
      env: {
        RUN_MODEL_PROVIDER_SMOKE: '1',
        MODEL_PROVIDER_SMOKE_BACKEND_URL: 'http://127.0.0.1:3100',
        MODEL_PROVIDER_SMOKE_CONFIGURE_PROVIDER: '1',
        MODEL_PROVIDER_SMOKE_PROVIDER_ID: 'deepseek',
        MODEL_PROVIDER_SMOKE_BASE_URL: 'https://api.deepseek.com/v1',
        MODEL_PROVIDER_SMOKE_MODEL: 'replace-with-real-model',
      },
      fetcher,
      logger: { log: vi.fn(), error: vi.fn() },
    })
    expect(result).toMatchObject({ status: 'failed', error: { code: 'placeholder_provider_config' } })
    expect(fetcher).not.toHaveBeenCalled()
  })
})

function json(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}
