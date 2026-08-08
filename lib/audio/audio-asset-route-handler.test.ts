import { describe, expect, it } from 'vitest'
import { handleAudioAssetPost } from './audio-asset-route-handler'
import type { AudioAssetUploadResult } from './audio-asset'

describe('handleAudioAssetPost', () => {
  it('returns uploaded audio asset metadata', async () => {
    const response = await handleAudioAssetPost(
      new Request('http://localhost/api/projects/demo/audio-assets', {
        method: 'POST',
        headers: {
          'content-type': 'audio/wav',
          'x-koubo-filename': 'voice.wav',
          'x-koubo-audio-purpose': 'reference',
        },
        body: new Uint8Array([1, 2, 3]),
      }),
      {
        projectId: 'demo',
        saveAsset: async () =>
          ({
            status: 'ok',
            source: 'audio_asset',
            asset: {
              assetId: 'reference-001',
              assetType: 'audio',
              projectId: 'demo',
              featureType: 'digital-human',
              purpose: 'reference',
              originalFilename: 'voice.wav',
              contentType: 'audio/wav',
              relativePath: 'files/audio/reference-001.wav',
              path: 'C:/workspace/files/audio/reference-001.wav',
              size: 3,
              status: 'ready',
              createdAt: '2026-06-11T00:00:00.000Z',
              updatedAt: '2026-06-11T00:00:00.000Z',
            },
          }) satisfies AudioAssetUploadResult,
      },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      source: 'audio_asset',
      asset: {
        purpose: 'reference',
        relativePath: 'files/audio/reference-001.wav',
      },
    })
  })

  it('rejects missing files with a typed error', async () => {
    const form = new FormData()
    form.set('purpose', 'reference')

    const response = await handleAudioAssetPost(
      new Request('http://localhost/api/projects/demo/audio-assets', {
        method: 'POST',
        body: form,
      }),
      {
        projectId: 'demo',
        saveAsset: async () => {
          throw new Error('should not be called')
        },
      },
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      status: 'invalid_request',
      source: 'api',
      error: {
        code: 'missing_file',
      },
    })
  })
})
