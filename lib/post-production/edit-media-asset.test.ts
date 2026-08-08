import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureProjectWorkspace, getWorkspacesRoot } from '@/lib/workspaces/workspace-manager'
import {
  deleteEditMediaAsset,
  getEditMediaAsset,
  listEditMediaAssets,
  saveEditMediaAsset,
  validateEditMediaAsset,
} from './edit-media-asset'

const projectId = 'test-edit-media-assets'

afterEach(async () => {
  await fs.rm(path.join(getWorkspacesRoot(), projectId), { recursive: true, force: true })
})

describe('edit media asset', () => {
  it('validates media kind against real file type', () => {
    expect(validateEditMediaAsset({ kind: 'background_music', filename: 'bed.mp3', size: 4 })).toBe('mp3')
    expect(validateEditMediaAsset({ kind: 'intro', filename: 'intro.mp4', size: 4 })).toBe('mp4')
    expect(() => validateEditMediaAsset({ kind: 'background_music', filename: 'fake.mp4', size: 4 })).toThrow(/背景音乐/)
  })

  it('imports, filters, resolves and deletes workspace edit media', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const bgm = await saveEditMediaAsset({
      workspace,
      kind: 'background_music',
      name: '轻快直播 BGM',
      originalFilename: 'bed.mp3',
      contentType: 'audio/mpeg',
      bytes: new Uint8Array([1, 2, 3, 4]),
      now: '2026-07-16T00:00:00.000Z',
    })
    const intro = await saveEditMediaAsset({
      workspace,
      kind: 'intro',
      originalFilename: 'opening.mp4',
      contentType: 'video/mp4',
      bytes: new Uint8Array([5, 6, 7]),
      now: '2026-07-16T00:00:01.000Z',
    })

    await expect(listEditMediaAssets(workspace)).resolves.toHaveLength(2)
    await expect(listEditMediaAssets(workspace, 'background_music')).resolves.toEqual([bgm])
    await expect(getEditMediaAsset(workspace, intro.assetId)).resolves.toMatchObject({ name: 'opening', kind: 'intro' })
    await deleteEditMediaAsset(workspace, bgm.assetId)
    await expect(listEditMediaAssets(workspace)).resolves.toEqual([intro])
    await expect(fs.stat(bgm.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
