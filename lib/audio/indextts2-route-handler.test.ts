import { describe, expect, it } from 'vitest'
import { handleIndexTTS2Get, handleIndexTTS2Post } from './indextts2-route-handler'
import type { GenerateIndexTTS2AudioResult } from './indextts2-service'
import type { ProjectStateDocument } from '@/lib/project-state/project-state-types'

describe('handleIndexTTS2Post', () => {
  it('returns a persisted task for recovery', async () => {
    const response = await handleIndexTTS2Get(
      new Request('http://localhost/api/projects/demo/audio/indextts2?sessionId=voice-session'),
      {
        projectId: 'demo',
        getTask: async () => ({
          status: 'ok',
          source: 'indextts2_task',
          task: {
            taskId: 'audio-001',
            projectId: 'demo',
            sessionId: 'voice-session',
            status: 'failed',
            error: { code: 'runtime_failed', message: 'failed' },
            createdAt: '2026-07-15T00:00:00.000Z',
            updatedAt: '2026-07-15T00:01:00.000Z',
          },
          project: {
            projectId: 'demo',
            revision: 2,
            stages: { voice: { status: 'failed', error: { code: 'runtime_failed', message: 'failed' } } },
          } as unknown as ProjectStateDocument,
        }),
      },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      task: { status: 'failed', error: { code: 'runtime_failed' } },
      project: { stages: { voice: { status: 'failed', error: { code: 'runtime_failed' } } } },
    })
  })

  it('returns generated audio artifacts', async () => {
    const response = await handleIndexTTS2Post(
      new Request('http://localhost/api/projects/demo/audio/indextts2', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: 'voice-session-001',
          parameters: {
            scriptArtifactId: 'script-001',
            text: '测试音频',
            speed: 1,
            emotionAlpha: 0.2,
            outputFormat: 'wav',
            useRandom: false,
          },
        }),
      }),
      {
        projectId: 'demo',
        generateAudio: async () =>
          ({
            status: 'ok',
            source: 'indextts2_service',
            artifact: {
              artifactId: 'audio-001',
              artifactType: 'audio',
              projectId: 'demo',
              featureType: 'digital-human',
              sessionId: 'voice-session-001',
              status: 'ready',
              source: 'indextts2',
              outputPath: 'audio/audio-001.wav',
              durationSeconds: 5,
              parameters: {
                scriptArtifactId: 'script-001',
                text: '测试音频',
                speed: 1,
                emotionAlpha: 0.2,
                useRandom: false,
                outputFormat: 'wav',
              },
              createdAt: '2026-06-11T00:00:00.000Z',
              updatedAt: '2026-06-11T00:00:00.000Z',
            },
          }) satisfies GenerateIndexTTS2AudioResult,
      },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      source: 'indextts2_service',
      artifact: {
        artifactType: 'audio',
      },
    })
  })

  it('rejects invalid request bodies with a typed error', async () => {
    const response = await handleIndexTTS2Post(
      new Request('http://localhost/api/projects/demo/audio/indextts2', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: '',
          parameters: {
            scriptArtifactId: 'script-001',
            text: '',
            speed: 3,
          },
        }),
      }),
      {
        projectId: 'demo',
        generateAudio: async () => {
          throw new Error('should not be called')
        },
      },
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      status: 'invalid_request',
      source: 'api',
      error: {
        code: 'invalid_session_id',
      },
    })
  })
})
