import { describe, expect, it } from 'vitest'
import { MODEL_PROVIDER_CATALOG } from './model-provider-catalog'

describe('model provider catalog', () => {
  it('lists supported first-wave provider families', () => {
    expect(MODEL_PROVIDER_CATALOG.map((provider) => provider.kind)).toEqual([
      'openai',
      'deepseek',
      'local_openai_compatible',
      'custom_openai_compatible',
    ])
  })

  it('distinguishes ChatGPT subscription guidance from OpenAI API credentials', () => {
    const openai = MODEL_PROVIDER_CATALOG.find((provider) => provider.kind === 'openai')

    expect(openai).toMatchObject({
      authMode: 'api_key',
      requiresApiKey: true,
      dataLocation: 'cloud_provider',
    })
    expect(openai?.note).toContain('ChatGPT')
  })
})
