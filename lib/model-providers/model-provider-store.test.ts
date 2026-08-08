import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDefaultModelProviderSettings,
  readModelProviderSettings,
  toPublicModelProviderSettings,
  writeModelProviderSettings,
} from './model-provider-store'

const roots: string[] = []

async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'koubo-model-providers-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('model provider store', () => {
  it('returns default providers when settings file is missing', async () => {
    const root = await tempRoot()

    await expect(readModelProviderSettings({ root })).resolves.toMatchObject({
      defaultProviderId: 'deepseek',
      providers: [
        { id: 'openai', status: 'disabled' },
        { id: 'deepseek', status: 'missing_credentials' },
        { id: 'local_openai_compatible', status: 'disabled' },
        { id: 'custom_openai_compatible', status: 'disabled' },
      ],
    })
  })

  it('persists secrets in backend settings but redacts public output', async () => {
    const root = await tempRoot()
    const settings = createDefaultModelProviderSettings()
    settings.providers = settings.providers.map((provider) =>
      provider.id === 'openai'
        ? {
            ...provider,
            enabled: true,
            apiKey: 'sk-test-secret-value',
          }
        : provider,
    )

    await writeModelProviderSettings(settings, { root })
    const raw = await readFile(path.join(root, 'model-providers.json'), 'utf8')
    const publicSettings = toPublicModelProviderSettings(await readModelProviderSettings({ root }))

    expect(raw).toContain('sk-test-secret-value')
    expect(JSON.stringify(publicSettings)).not.toContain('sk-test-secret-value')
    expect(publicSettings.providers.find((provider) => provider.id === 'openai')).toMatchObject({
      hasApiKey: true,
      apiKeyPreview: 'sk-t...alue',
    })
  })
})
