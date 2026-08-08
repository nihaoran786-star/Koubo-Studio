import { describe, expect, it, vi } from 'vitest'
import { uploadEditMediaAssetClient } from './edit-media-asset-client'

describe('edit media asset client', () => {
  it('sends media and metadata without multipart buffering', async () => {
    const fetcher = vi.fn(async () => ({ json: async () => ({ status: 'ok', source: 'edit_media_asset', asset: {} }) })) as unknown as typeof fetch
    const file = new File([new Uint8Array([1])], 'opening.mp4', { type: 'video/mp4' })

    await uploadEditMediaAssetClient({ projectId: 'demo', kind: 'intro', name: '直播片头', file }, fetcher)

    expect(fetcher).toHaveBeenCalledWith('/api/projects/demo/edit-media-assets', {
      method: 'POST',
      headers: {
        'content-type': 'video/mp4',
        'x-koubo-filename': 'opening.mp4',
        'x-koubo-edit-kind': 'intro',
        'x-koubo-asset-name': encodeURIComponent('直播片头'),
      },
      body: file,
    })
  })
})
