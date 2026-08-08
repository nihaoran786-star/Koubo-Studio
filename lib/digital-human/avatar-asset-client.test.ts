import { describe, expect, it, vi } from 'vitest'
import { createAvatarAssetClient } from './avatar-asset-client'

describe('avatar asset client', () => {
  it('sends the File as a raw request body', async () => {
    const fetcher = vi.fn(async () => ({ json: async () => ({ status: 'ok', source: 'avatar_asset', asset: {} }) })) as unknown as typeof fetch
    const file = new File([new Uint8Array([1])], '我的形象.mp4', { type: 'video/mp4' })

    await createAvatarAssetClient(fetcher)({ projectId: 'demo', file })

    expect(fetcher).toHaveBeenCalledWith('/api/projects/demo/avatar-assets', {
      method: 'POST',
      headers: {
        'content-type': 'video/mp4',
        'x-koubo-filename': encodeURIComponent('我的形象.mp4'),
      },
      body: file,
    })
  })
})
