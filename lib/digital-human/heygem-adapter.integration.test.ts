import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runHeyGemAdapter } from './heygem-adapter'

const shouldRun =
  process.env.RUN_HEYGEM_INTEGRATION === '1' &&
  (
    Boolean(process.env.DUIX_AVATAR_API_URL?.trim()) ||
    Boolean(process.env.HEYGEM_API_URL?.trim()) ||
    Boolean(process.env.DUIX_AVATAR_SCRIPT_PATH?.trim()) ||
    Boolean(process.env.HEYGEM_SCRIPT_PATH?.trim())
  ) &&
  Boolean(process.env.DUIX_AVATAR_INTEGRATION_AUDIO?.trim() || process.env.HEYGEM_INTEGRATION_AUDIO?.trim())

const maybeIt = shouldRun ? it : it.skip
const tmpRoots: string[] = []
const avatarAssetPath = process.env.DUIX_AVATAR_INTEGRATION_AVATAR_ASSET || process.env.HEYGEM_INTEGRATION_AVATAR_ASSET

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => fs.rm(root, { recursive: true, force: true })))
  tmpRoots.length = 0
})

describe('HeyGem adapter integration', () => {
  maybeIt('generates a short digital-human video with the configured runtime', async () => {
    const workspacePath = await fs.mkdtemp(path.join(process.cwd(), 'tmp-heygem-integration-'))
    tmpRoots.push(workspacePath)
    const outputPath = path.join(workspacePath, 'artifacts', 'render', 'integration.mp4')
    await fs.mkdir(path.dirname(outputPath), { recursive: true })

    const result = await runHeyGemAdapter({
      projectId: 'integration',
      workspacePath,
      outputPath,
      scriptArtifact: {
        artifactId: 'script-integration',
        artifactType: 'script',
        projectId: 'integration',
        featureType: 'digital-human',
        sessionId: 'script-session',
        approvalStatus: 'approved',
        content: {
          title: 'HeyGem 集成测试',
          hook: '这是一次集成测试。',
          body: '这是一次 HeyGem 数字人生成集成测试。',
          caption: 'HeyGem 集成测试',
          tags: ['#测试'],
          durationSeconds: 5,
          voiceNotes: '',
          shotNotes: '',
          riskNotes: '',
        },
        createdAt: '2026-06-11T00:00:00.000Z',
        updatedAt: '2026-06-11T00:00:00.000Z',
      },
      audioArtifact: {
        artifactId: 'audio-integration',
        artifactType: 'audio',
        projectId: 'integration',
        featureType: 'digital-human',
        sessionId: 'voice-session',
        status: 'ready',
        source: 'indextts2',
        outputPath: process.env.DUIX_AVATAR_INTEGRATION_AUDIO || process.env.HEYGEM_INTEGRATION_AUDIO!,
        durationSeconds: 5,
        parameters: {
          scriptArtifactId: 'script-integration',
          text: '这是一次 HeyGem 数字人生成集成测试。',
          speed: 1,
          emotionAlpha: 0.2,
          useRandom: false,
          outputFormat: 'wav',
        },
        createdAt: '2026-06-11T00:00:00.000Z',
        updatedAt: '2026-06-11T00:00:00.000Z',
      },
      input: {
        scriptArtifactId: 'script-integration',
        audioArtifactId: 'audio-integration',
        avatar: {
          source: avatarAssetPath ? 'upload' : 'library',
          id: process.env.DUIX_AVATAR_INTEGRATION_AVATAR_ID || process.env.HEYGEM_INTEGRATION_AVATAR_ID || 'default',
          name: 'integration-avatar',
          assetPath: avatarAssetPath,
        },
        mode: 'standard',
      },
    })

    if (result.status !== 'ok') throw new Error(JSON.stringify(result))
    expect(result.status).toBe('ok')
    expect(result.durationSeconds).toBeGreaterThan(0)
    await expect(fs.stat(result.outputPath)).resolves.toMatchObject({ size: expect.any(Number) })
  }, 600000)
})
