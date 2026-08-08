import { describe, expect, it } from 'vitest'
import { handleAvatarAssetFileGet, handleAvatarAssetPost } from './avatar-asset-route-handler'
import type { AvatarAssetUploadResult } from './avatar-asset'

describe('handleAvatarAssetPost', () => {
  it('uploads avatar video assets', async () => {
    const response = await handleAvatarAssetPost(
      new Request('http://localhost/api/projects/demo/avatar-assets', {
        method: 'POST',
        headers: {
          'content-type': 'video/mp4',
          'x-koubo-filename': 'avatar.mp4',
        },
        body: new Uint8Array([1, 2, 3]),
      }),
      {
        projectId: 'demo',
        saveAsset: async () =>
          ({
            status: 'ok',
            source: 'avatar_asset',
            asset: {
              assetId: 'avatar-001',
              assetType: 'avatar',
              projectId: 'demo',
              featureType: 'digital-human',
              originalFilename: 'avatar.mp4',
              contentType: 'video/mp4',
              relativePath: 'files/avatar/avatar-001.mp4',
              path: 'C:/workspace/files/avatar/avatar-001.mp4',
              size: 3,
              status: 'ready',
              createdAt: '2026-06-11T00:00:00.000Z',
              updatedAt: '2026-06-11T00:00:00.000Z',
            },
          }) satisfies AvatarAssetUploadResult,
      },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      source: 'avatar_asset',
      asset: {
        assetType: 'avatar',
      },
    })
  })

  it('rejects missing files with a typed error', async () => {
    const response = await handleAvatarAssetPost(
      new Request('http://localhost/api/projects/demo/avatar-assets', {
        method: 'POST',
        body: new FormData(),
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

  it('serves uploaded avatar video assets through a read-only file route', async () => {
    const response = await handleAvatarAssetFileGet(
      new Request('http://localhost/api/projects/demo/avatar-assets/avatar-001/file'),
      {
        projectId: 'demo',
        assetId: 'avatar-001',
        openFile: async () => new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'video/mp4' },
        }),
      },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp4')
    await expect(response.arrayBuffer()).resolves.toHaveProperty('byteLength', 3)
  })
})
