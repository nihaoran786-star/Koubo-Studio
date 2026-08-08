import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureProjectWorkspace, getWorkspacesRoot } from '@/lib/workspaces/workspace-manager'
import { deleteAvatarAsset, getAvatarAsset, listAvatarAssets, saveAvatarAsset, validateAvatarAssetUpload } from './avatar-asset'

const projectId = 'test-avatar-asset'

afterEach(async () => {
  await fs.rm(path.join(getWorkspacesRoot(), projectId), { recursive: true, force: true })
})

describe('avatar asset', () => {
  it('saves uploaded avatar video under workspace files and indexes it', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const result = await saveAvatarAsset({
      workspace,
      originalFilename: 'avatar.mp4',
      contentType: 'video/mp4',
      bytes: new Uint8Array([1, 2, 3]),
      now: '2026-06-11T00:00:00.000Z',
    })

    expect(result).toMatchObject({
      status: 'ok',
      source: 'avatar_asset',
      asset: {
        assetType: 'avatar',
        projectId,
        originalFilename: 'avatar.mp4',
        contentType: 'video/mp4',
        relativePath: expect.stringContaining('files/avatar/'),
        status: 'ready',
      },
    })
    if (result.status !== 'ok') throw new Error('expected ok')
    await expect(fs.stat(result.asset.path)).resolves.toMatchObject({ size: 3 })
    await expect(listAvatarAssets(workspace)).resolves.toHaveLength(1)
    await expect(getAvatarAsset(workspace, result.asset.assetId)).resolves.toMatchObject({
      assetId: result.asset.assetId,
      relativePath: result.asset.relativePath,
    })
    await deleteAvatarAsset(workspace, result.asset.assetId)
    await expect(listAvatarAssets(workspace)).resolves.toHaveLength(0)
    await expect(fs.stat(result.asset.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects unsupported avatar file types', () => {
    expect(() =>
      validateAvatarAssetUpload({
        filename: 'avatar.txt',
        contentType: 'text/plain',
        size: 3,
      }),
    ).toThrowError(/仅支持/)
  })

  it('rejects forged cross-project identity in the persisted index', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const saved = await saveAvatarAsset({
      workspace,
      originalFilename: 'avatar.mp4',
      contentType: 'video/mp4',
      bytes: new Uint8Array([1, 2, 3]),
    })
    const indexPath = path.join(workspace.filesPath, 'avatar', 'index.json')
    const index = JSON.parse(await fs.readFile(indexPath, 'utf8'))
    index.assets[0].projectId = 'another-project'
    await fs.writeFile(indexPath, JSON.stringify(index), 'utf8')

    await expect(getAvatarAsset(workspace, saved.asset.assetId)).rejects.toMatchObject({
      code: 'avatar_asset_identity_mismatch',
    })
  })

  it('rejects a persisted path that does not match the workspace relative path', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const saved = await saveAvatarAsset({
      workspace,
      originalFilename: 'avatar.mp4',
      contentType: 'video/mp4',
      bytes: new Uint8Array([1, 2, 3]),
    })
    const indexPath = path.join(workspace.filesPath, 'avatar', 'index.json')
    const index = JSON.parse(await fs.readFile(indexPath, 'utf8'))
    index.assets[0].relativePath = 'files/avatar/different.mp4'
    await fs.writeFile(indexPath, JSON.stringify(index), 'utf8')

    await expect(getAvatarAsset(workspace, saved.asset.assetId)).rejects.toMatchObject({
      code: 'avatar_asset_path_mismatch',
    })
  })
})
