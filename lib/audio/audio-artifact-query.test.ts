import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { saveAudioArtifact } from '@/lib/artifacts/audio-artifact'
import { ensureProjectWorkspace, getWorkspacesRoot } from '@/lib/workspaces/workspace-manager'
import { getLatestReadyAudioArtifact } from './audio-artifact-query'

const projectId = 'test-audio-query'

afterEach(async () => {
  await fs.rm(path.join(getWorkspacesRoot(), projectId), { recursive: true, force: true })
})

describe('getLatestReadyAudioArtifact', () => {
  it('returns the latest ready audio artifact with a playback reference', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    await saveAudioArtifact({
      workspace,
      artifactId: 'audio-old',
      sessionId: 'voice-session',
      status: 'ready',
      source: 'indextts2',
      outputPath: path.join(workspace.artifactsPath, 'audio', 'audio-old.wav'),
      durationSeconds: 3,
      parameters: baseParameters('旧音频'),
      now: '2026-06-11T00:00:00.000Z',
    })
    await saveAudioArtifact({
      workspace,
      artifactId: 'audio-new',
      sessionId: 'voice-session',
      status: 'ready',
      source: 'indextts2',
      outputPath: path.join(workspace.artifactsPath, 'audio', 'audio-new.wav'),
      durationSeconds: 5.5,
      parameters: baseParameters('新音频'),
      now: '2026-06-11T00:01:00.000Z',
    })
    await saveAudioArtifact({
      workspace,
      artifactId: 'audio-failed',
      sessionId: 'voice-session',
      status: 'failed',
      source: 'indextts2',
      outputPath: path.join(workspace.artifactsPath, 'audio', 'audio-failed.wav'),
      durationSeconds: 0,
      parameters: baseParameters('失败音频'),
      now: '2026-06-11T00:02:00.000Z',
    })

    await expect(getLatestReadyAudioArtifact(workspace)).resolves.toMatchObject({
      status: 'ok',
      source: 'audio_artifact_query',
      selected: {
        artifactId: 'audio-new',
        durationSeconds: 5.5,
        playbackUrl: '/api/projects/test-audio-query/audio-artifacts/audio-new/file',
      },
    })
  })

  it('can select the latest ready audio for a specific script artifact', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    await saveAudioArtifact({
      workspace,
      artifactId: 'audio-current-script',
      sessionId: 'voice-session',
      status: 'ready',
      source: 'indextts2',
      outputPath: path.join(workspace.artifactsPath, 'audio', 'audio-current-script.wav'),
      durationSeconds: 4,
      parameters: baseParameters('当前文案音频', 'script-current'),
      now: '2026-06-11T00:01:00.000Z',
    })
    await saveAudioArtifact({
      workspace,
      artifactId: 'audio-other-script-newer',
      sessionId: 'voice-session',
      status: 'ready',
      source: 'indextts2',
      outputPath: path.join(workspace.artifactsPath, 'audio', 'audio-other-script-newer.wav'),
      durationSeconds: 5,
      parameters: baseParameters('其他文案音频', 'script-other'),
      now: '2026-06-11T00:02:00.000Z',
    })

    await expect(
      getLatestReadyAudioArtifact(workspace, { scriptArtifactId: 'script-current' }),
    ).resolves.toMatchObject({
      status: 'ok',
      selected: {
        artifactId: 'audio-current-script',
      },
    })
  })

  it('returns not_found when no ready audio exists', async () => {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')

    await expect(getLatestReadyAudioArtifact(workspace)).resolves.toMatchObject({
      status: 'not_found',
      source: 'audio_artifact_query',
      selected: undefined,
    })
  })
})

function baseParameters(text: string, scriptArtifactId = 'script-audio-query') {
  return {
    scriptArtifactId,
    text,
    speed: 1,
    emotionAlpha: 0.2,
    useRandom: false,
    outputFormat: 'wav' as const,
  }
}
