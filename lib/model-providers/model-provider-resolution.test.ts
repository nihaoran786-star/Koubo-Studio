import { describe, expect, it } from 'vitest'
import {
  resolveDefaultModelProvider,
  resolveModelProviderFromSettings,
} from './model-provider-resolution'
import { createDefaultModelProviderSettings } from './model-provider-store'

describe('model provider resolution', () => {
  it('resolves an OpenAI-compatible API provider for the native model adapter', () => {
    const settings = createDefaultModelProviderSettings()
    settings.defaultProviderId = 'openai'
    settings.providers = settings.providers.map((provider) =>
      provider.id === 'openai'
        ? {
            ...provider,
            enabled: true,
            apiKey: 'openai-secret',
            status: 'configured',
          }
        : provider,
    )

    expect(resolveModelProviderFromSettings(settings)).toMatchObject({
      status: 'ok',
      provider: {
        providerId: 'openai',
        modelId: 'gpt-4.1-mini',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'openai-secret',
        authHeader: true,
      },
    })
  })

  it('resolves DeepSeek as OpenAI-compatible provider', () => {
    const settings = createDefaultModelProviderSettings()
    settings.defaultProviderId = 'deepseek'
    settings.providers = settings.providers.map((provider) =>
      provider.id === 'deepseek'
        ? {
            ...provider,
            enabled: true,
            apiKey: 'deepseek-secret',
            status: 'configured',
          }
        : provider,
    )

    expect(resolveModelProviderFromSettings(settings)).toMatchObject({
      status: 'ok',
      provider: {
        providerKind: 'deepseek',
        modelId: 'deepseek-chat',
        apiKey: 'deepseek-secret',
      },
    })
  })

  it('returns missing credentials for the new empty-config DeepSeek default', () => {
    const settings = createDefaultModelProviderSettings()

    expect(resolveModelProviderFromSettings(settings)).toMatchObject({
      status: 'missing_credentials',
      error: {
        code: 'missing_credentials',
      },
    })
  })

  it('rejects disabled default provider', () => {
    const settings = createDefaultModelProviderSettings()
    settings.defaultProviderId = 'openai'

    expect(resolveModelProviderFromSettings(settings)).toMatchObject({
      status: 'provider_disabled',
      error: {
        code: 'provider_disabled',
      },
    })
  })

  it('rejects missing api key for cloud providers', () => {
    const settings = createDefaultModelProviderSettings()
    settings.defaultProviderId = 'openai'
    settings.providers = settings.providers.map((provider) =>
      provider.id === 'openai'
        ? {
            ...provider,
            enabled: true,
          }
        : provider,
    )

    expect(resolveModelProviderFromSettings(settings)).toMatchObject({
      status: 'missing_credentials',
      error: {
        code: 'missing_credentials',
      },
    })
  })

  it('returns runtime_error when settings cannot be read', async () => {
    await expect(
      resolveDefaultModelProvider({
        readSettings: async () => {
          throw new Error('settings failed')
        },
      }),
    ).resolves.toMatchObject({
      status: 'runtime_error',
      error: {
        code: 'runtime_error',
      },
    })
  })
})
