import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getAudioArtifact } from '@/lib/artifacts/audio-artifact'
import { getRenderArtifact } from '@/lib/artifacts/render-artifact'
import { saveScriptArtifact } from '@/lib/artifacts/script-artifact'
import { generateIndexTTS2Audio } from '@/lib/audio/indextts2-service'
import { createProjectState } from '@/lib/project-state/project-state-service'
import { emptyScript } from '@/lib/workspace'
import { saveAvatarAsset } from './avatar-asset'
import { ensureProjectWorkspace, getWorkspacesRoot } from '@/lib/workspaces/workspace-manager'
import { generateHeyGemRender } from './heygem-service'

const projectId = 'digital-human-chain-smoke'
const referenceAudio = process.env.INDEXTTS2_REFERENCE_AUDIO?.trim()
const avatarAsset = process.env.DUIX_AVATAR_INTEGRATION_AVATAR_ASSET?.trim() || process.env.HEYGEM_INTEGRATION_AVATAR_ASSET?.trim()
const hasHeyGemRuntime = Boolean(
  process.env.DUIX_AVATAR_API_URL?.trim() ||
    process.env.HEYGEM_API_URL?.trim() ||
    process.env.DUIX_AVATAR_SCRIPT_PATH?.trim() ||
    process.env.HEYGEM_SCRIPT_PATH?.trim(),
)
const shouldRun =
  process.env.RUN_DIGITAL_HUMAN_CHAIN_SMOKE === '1' &&
  Boolean(referenceAudio) &&
  hasHeyGemRuntime &&
  Boolean(avatarAsset)

const maybeIt = shouldRun ? it : it.skip

afterEach(async () => {
  try {
    await fs.rm(path.join(getWorkspacesRoot(), projectId), { recursive: true, force: true })
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined
    // The official Duix lite container can retain a Windows bind-mount handle
    // for the source avatar after a successful render. This is test cleanup
    // only; the render assertions above have already validated the artifact.
    if (code !== 'ENOTEMPTY' && code !== 'EPERM' && code !== 'EBUSY') throw error
  }
})

describe('digital-human real runtime chain smoke', () => {
  maybeIt('uses one approved script artifact through IndexTTS2 audio and HeyGem/Duix render services', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const referenceTarget = path.join(workspace.filesPath, 'audio', 'reference-chain.wav')
    await fs.mkdir(path.dirname(referenceTarget), { recursive: true })
    await fs.copyFile(referenceAudio!, referenceTarget)

    await saveScriptArtifact({
      workspace,
      artifactId: 'script-chain',
      sessionId: 'script-session',
      approvalStatus: 'approved',
      content: {
        title: '数字人口播链路 smoke',
        hook: '这是一次完整链路测试。',
        body: '这条音频由 IndexTTS2 生成，并继续交给数字人后端生成视频。',
        caption: '数字人口播链路 smoke',
        tags: ['#smoke'],
        durationSeconds: 8,
        voiceNotes: '自然、清晰、稳定。',
        shotNotes: '正面半身数字人口播。',
        riskNotes: '',
      },
    })
    await createProjectState({
      projectId,
      script: {
        ...emptyScript(),
        artifactId: 'script-chain',
        approvalStatus: 'approved',
        title: '数字人口播链路 smoke',
        body: '这条音频由 IndexTTS2 生成，并继续交给数字人后端生成视频。',
        generated: true,
      },
    })

    const audioResult = await generateIndexTTS2Audio({
      projectId,
      sessionId: 'voice-session',
      parameters: {
        scriptArtifactId: 'script-chain',
        text: '这条音频由 IndexTTS2 生成，并继续交给数字人后端生成视频。',
        referenceAudioPath: 'files/audio/reference-chain.wav',
        speed: 1,
        emotionText: '自然、清晰、稳定。',
        emotionAlpha: 0.2,
        useRandom: false,
        outputFormat: 'wav',
      },
    })

    if (audioResult.status !== 'ok') throw new Error(JSON.stringify(audioResult))
    await expect(getAudioArtifact(workspace, audioResult.artifact.artifactId)).resolves.toMatchObject({
      artifactType: 'audio',
      status: 'ready',
      source: 'indextts2',
      parameters: expect.objectContaining({
        scriptArtifactId: 'script-chain',
      }),
    })

    const avatarAssetId = await prepareAvatar(workspace)
    const renderResult = await generateHeyGemRender({
      projectId,
      sessionId: 'digital-human-session',
      input: {
        avatarAssetId,
        mode: 'standard',
      },
    })

    if (renderResult.status !== 'ok') throw new Error(JSON.stringify(renderResult))
    expect(renderResult.artifact).toMatchObject({
      artifactType: 'render',
      status: 'ready',
      source: 'heygem',
      scriptArtifactId: 'script-chain',
      audioArtifactId: audioResult.artifact.artifactId,
    })
    expect(renderResult.artifact.durationSeconds).toBeGreaterThan(0)
    await expect(getRenderArtifact(workspace, renderResult.artifact.artifactId)).resolves.toMatchObject({
      artifactType: 'render',
      status: 'ready',
      audioArtifactId: audioResult.artifact.artifactId,
    })
    await expect(fs.stat(renderResult.artifact.outputPath)).resolves.toMatchObject({ size: expect.any(Number) })
  }, 900000)
})

async function prepareAvatar(workspace: Awaited<ReturnType<typeof ensureProjectWorkspace>>) {
  if (!avatarAsset) throw new Error('真实数字人链路 smoke 需要 DUIX_AVATAR_INTEGRATION_AVATAR_ASSET。')
  const extension = path.extname(avatarAsset) || '.mp4'
  const bytes = new Uint8Array(await fs.readFile(avatarAsset))
  const saved = await saveAvatarAsset({
    workspace,
    originalFilename: `chain-avatar${extension}`,
    contentType: extension.toLowerCase() === '.webm' ? 'video/webm' : extension.toLowerCase() === '.mov' ? 'video/quicktime' : 'video/mp4',
    bytes,
  })
  return saved.asset.assetId
}
