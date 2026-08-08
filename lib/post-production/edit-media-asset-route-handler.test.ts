import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getWorkspacesRoot } from '@/lib/workspaces/workspace-manager'
import { handleEditMediaAssetPost } from './edit-media-asset-route-handler'

const projectId = 'test-edit-media-route-upload'

afterEach(async () => {
  await fs.rm(path.join(getWorkspacesRoot(), projectId), { recursive: true, force: true })
})

describe('handleEditMediaAssetPost', () => {
  it('streams a raw media body into the workspace', async () => {
    const response = await handleEditMediaAssetPost(new Request('http://localhost/api/projects/demo/edit-media-assets', {
      method: 'POST',
      headers: {
        'content-type': 'video/mp4',
        'content-length': '4',
        'x-koubo-filename': 'opening.mp4',
        'x-koubo-edit-kind': 'intro',
        'x-koubo-asset-name': encodeURIComponent('直播片头'),
      },
      body: new Uint8Array([1, 2, 3, 4]),
    }), projectId)

    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result).toMatchObject({
      status: 'ok',
      source: 'edit_media_asset',
      asset: { kind: 'intro', name: '直播片头', size: 4 },
    })
    await expect(fs.readFile(result.asset.path)).resolves.toEqual(Buffer.from([1, 2, 3, 4]))
  })

  it('returns a stable error when upload metadata is missing', async () => {
    const response = await handleEditMediaAssetPost(new Request('http://localhost/api/projects/demo/edit-media-assets', {
      method: 'POST',
      body: new Uint8Array([1]),
    }), projectId)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      status: 'invalid_request',
      error: { code: 'missing_file' },
    })
  })
})
