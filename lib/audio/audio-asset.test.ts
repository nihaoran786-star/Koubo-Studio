import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureProjectWorkspace, getWorkspacesRoot } from '@/lib/workspaces/workspace-manager'
import {
  getAudioAsset,
  listAudioAssets,
  saveAudioAsset,
  validateAudioAssetUpload,
  AudioAssetValidationError,
  deleteAudioAsset,
} from './audio-asset'

const projectId = 'test-audio-assets'

afterEach(async () => {
  await fs.rm(path.join(getWorkspacesRoot(), projectId), { recursive: true, force: true })
})

describe('audio asset management', () => {
  it('validates supported audio uploads', () => {
    expect(
      validateAudioAssetUpload({
        filename: 'voice.wav',
        contentType: 'audio/wav',
        size: 1024,
        purpose: 'reference',
      }),
    ).toMatchObject({
      extension: 'wav',
      purpose: 'reference',
    })
  })

  it('rejects unsupported audio upload types', () => {
    expect(() =>
      validateAudioAssetUpload({
        filename: 'voice.txt',
        contentType: 'text/plain',
        size: 1024,
        purpose: 'reference',
      }),
    ).toThrow(AudioAssetValidationError)
  })

  it('writes uploaded audio inside the project workspace and indexes the asset', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const result = await saveAudioAsset({
      workspace,
      purpose: 'emotion',
      originalFilename: 'emotion reference.mp3',
      contentType: 'audio/mpeg',
      bytes: new Uint8Array([1, 2, 3, 4]),
      now: '2026-06-11T00:00:00.000Z',
    })

    expect(result.asset).toMatchObject({
      assetType: 'audio',
      purpose: 'emotion',
      originalFilename: 'emotion reference.mp3',
      contentType: 'audio/mpeg',
      relativePath: expect.stringMatching(/^files\/audio\/emotion-/),
      size: 4,
      status: 'ready',
    })
    await expect(fs.readFile(result.asset.path)).resolves.toEqual(Buffer.from([1, 2, 3, 4]))
    await expect(getAudioAsset(workspace, result.asset.assetId)).resolves.toMatchObject(result.asset)
    await expect(listAudioAssets(workspace)).resolves.toHaveLength(1)
    await deleteAudioAsset(workspace, result.asset.assetId)
    await expect(listAudioAssets(workspace)).resolves.toHaveLength(0)
    await expect(fs.stat(result.asset.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
