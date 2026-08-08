import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  handleModelProviderTestPost,
  handleModelProvidersGet,
  handleModelProvidersPut,
} from './model-provider-route-handler'

const roots: string[] = []

async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'koubo-model-provider-route-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('model provider route handler', () => {
  it('returns redacted default settings', async () => {
    const response = await handleModelProvidersGet({ root: await tempRoot() })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      source: 'model_provider_store',
      settings: {
        defaultProviderId: 'deepseek',
        providers: expect.arrayContaining([
          expect.objectContaining({ id: 'openai', hasApiKey: false }),
          expect.objectContaining({ id: 'deepseek', hasApiKey: false, status: 'missing_credentials' }),
        ]),
      },
    })
  })

  it('updates provider config while returning redacted secrets', async () => {
    const root = await tempRoot()
    const response = await handleModelProvidersPut(
      new Request('http://local.test/api/settings/model-providers', {
        method: 'PUT',
        body: JSON.stringify({
          defaultProviderId: 'deepseek',
          providers: [
            {
              id: 'deepseek',
              enabled: true,
              apiKey: 'deepseek-secret',
            },
          ],
        }),
      }),
      { root },
    )

    expect(response.status).toBe(200)
    const payload = await response.json()
    const deepseek = payload.settings.providers.find((provider: { id: string }) => provider.id === 'deepseek')
    expect(payload.settings.defaultProviderId).toBe('deepseek')
    expect(deepseek).toMatchObject({
      hasApiKey: true,
      apiKeyPreview: 'deep...cret',
    })
    expect(JSON.stringify(payload)).not.toContain('deepseek-secret')
  })

  it('tests provider connection and persists normalized status', async () => {
    const root = await tempRoot()
    await handleModelProvidersPut(
      new Request('http://local.test/api/settings/model-providers', {
        method: 'PUT',
        body: JSON.stringify({
          providers: [
            {
              id: 'openai',
              enabled: true,
              apiKey: 'openai-secret',
            },
          ],
        }),
      }),
      { root },
    )
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }))

    const response = await handleModelProviderTestPost(
      new Request('http://local.test/api/settings/model-providers', {
        method: 'POST',
        body: JSON.stringify({ providerId: 'openai' }),
      }),
      {
        root,
        fetcher,
        now: () => new Date('2026-06-11T00:00:00.000Z'),
      },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      source: 'model_provider_test',
      result: {
        status: 'connected',
        providerId: 'openai',
      },
      settings: {
        providers: expect.arrayContaining([
          expect.objectContaining({
            id: 'openai',
            status: 'connected',
            lastTestedAt: '2026-06-11T00:00:00.000Z',
          }),
        ]),
      },
    })
  })
})
