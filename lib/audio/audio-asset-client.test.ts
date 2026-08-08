import { describe, expect, it, vi } from 'vitest'
import { audioAssetEndpoint, createAudioAssetClient, statusFromAudioAssetResult } from './audio-asset-client'

describe('audio asset client', () => {
  it('builds the project audio asset endpoint', () => {
    expect(audioAssetEndpoint('demo project')).toBe('/api/projects/demo%20project/audio-assets')
  })

  it('uploads the File as a raw body without multipart buffering', async () => {
    const fetcher = vi.fn(async () => ({
      json: async () => ({
        status: 'ok',
        source: 'audio_asset',
        asset: {
          assetId: 'reference-001',
          relativePath: 'files/audio/reference-001.wav',
        },
      }),
    })) as unknown as typeof fetch

    const client = createAudioAssetClient(fetcher)
    const file = new File([new Uint8Array([1])], 'voice.wav', { type: 'audio/wav' })
    const result = await client({ projectId: 'demo', purpose: 'reference', file })

    expect(fetcher).toHaveBeenCalledWith('/api/projects/demo/audio-assets', {
      method: 'POST',
      headers: {
        'content-type': 'audio/wav',
        'x-koubo-audio-purpose': 'reference',
        'x-koubo-filename': 'voice.wav',
      },
      body: file,
    })
    expect(statusFromAudioAssetResult(result)).toBe('done')
  })

  it('returns desktop_backend_missing when audio asset API cannot be reached', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    const client = createAudioAssetClient(fetcher)
    const file = new File([new Uint8Array([1])], 'voice.wav', { type: 'audio/wav' })

    await expect(client({ projectId: 'demo', purpose: 'reference', file })).resolves.toMatchObject({
      status: 'upload_error',
      source: 'desktop_runtime',
      error: {
        code: 'desktop_backend_missing',
      },
    })
  })
})
