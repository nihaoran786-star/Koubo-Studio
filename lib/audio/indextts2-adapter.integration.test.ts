import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getAudioArtifact } from '@/lib/artifacts/audio-artifact'
import { saveScriptArtifact } from '@/lib/artifacts/script-artifact'
import { ensureProjectWorkspace, getWorkspacesRoot } from '@/lib/workspaces/workspace-manager'
import { generateIndexTTS2Audio } from './indextts2-service'

const shouldRun =
  process.env.RUN_INDEXTTS2_INTEGRATION === '1' &&
  typeof process.env.INDEXTTS2_REFERENCE_AUDIO === 'string' &&
  process.env.INDEXTTS2_REFERENCE_AUDIO.length > 0

const maybeIt = shouldRun ? it : it.skip
const projectId = 'indextts2-runtime-smoke'
const integrationTimeoutMs = readPositiveInteger(process.env.INDEXTTS2_TIMEOUT_MS) ?? 300_000

afterEach(async () => {
  await fs.rm(path.join(getWorkspacesRoot(), projectId), { recursive: true, force: true })
})

describe('IndexTTS2 runtime smoke', () => {
  maybeIt('generates a short audio artifact through the service with an approved script', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const referenceTarget = path.join(workspace.filesPath, 'audio', 'reference-smoke.wav')
    await fs.mkdir(path.dirname(referenceTarget), { recursive: true })
    await fs.copyFile(process.env.INDEXTTS2_REFERENCE_AUDIO!, referenceTarget)
    await saveScriptArtifact({
      workspace,
      artifactId: 'script-smoke',
      sessionId: 'script-session',
      approvalStatus: 'approved',
      content: {
        title: 'IndexTTS2 smoke',
        hook: '这是一次声音克隆 smoke。',
        body: '今天测试 IndexTTS2 本地生成音频。',
        caption: 'IndexTTS2 smoke',
        tags: ['#smoke'],
        durationSeconds: 4,
        voiceNotes: '自然、清晰、稳定。',
        shotNotes: '',
        riskNotes: '',
      },
    })

    const result = await generateIndexTTS2Audio({
      projectId,
      sessionId: 'voice-session',
      parameters: {
        scriptArtifactId: 'script-smoke',
        text: '今天测试 IndexTTS2 本地生成音频。',
        referenceAudioPath: 'files/audio/reference-smoke.wav',
        speed: 1,
        emotionText: '自然、清晰、稳定。',
        emotionAlpha: 0.2,
        useRandom: false,
        outputFormat: 'wav',
      },
    })

    if (result.status !== 'ok') throw new Error(JSON.stringify(result))
    expect(result.status).toBe('ok')
    expect(result.artifact).toMatchObject({
      artifactType: 'audio',
      status: 'ready',
      source: 'indextts2',
      parameters: expect.objectContaining({
        scriptArtifactId: 'script-smoke',
      }),
    })
    expect(result.artifact.durationSeconds).toBeGreaterThan(0)
    await expect(getAudioArtifact(workspace, result.artifact.artifactId)).resolves.toMatchObject({
      artifactType: 'audio',
      status: 'ready',
      parameters: expect.objectContaining({
        scriptArtifactId: 'script-smoke',
      }),
    })
    await expect(fs.stat(result.artifact.outputPath)).resolves.toMatchObject({ size: expect.any(Number) })
  }, integrationTimeoutMs + 60_000)
})

function readPositiveInteger(value: string | undefined) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return Math.ceil(parsed)
}
