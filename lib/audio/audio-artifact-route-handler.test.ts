import { describe, expect, it } from 'vitest'
import { handleLatestAudioArtifactGet } from './audio-artifact-route-handler'
import type { LatestAudioArtifactResult } from './audio-artifact-query'

describe('handleLatestAudioArtifactGet', () => {
  it('returns latest ready audio metadata', async () => {
    const response = await handleLatestAudioArtifactGet(
      new Request('http://localhost/api/projects/demo/audio-artifacts/latest'),
      {
        projectId: 'demo',
        getLatest: async (input) => {
          expect(input).toEqual({ projectId: 'demo', scriptArtifactId: undefined })
          return ({
            status: 'ok',
            source: 'audio_artifact_query',
            selected: {
              artifactId: 'audio-001',
              durationSeconds: 8.2,
              outputPath: 'C:/workspace/artifacts/audio/audio-001.wav',
              playbackUrl: '/api/projects/demo/audio-artifacts/audio-001/file',
              createdAt: '2026-06-11T00:00:00.000Z',
            },
          }) satisfies LatestAudioArtifactResult
        },
      },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      selected: {
        artifactId: 'audio-001',
        playbackUrl: '/api/projects/demo/audio-artifacts/audio-001/file',
      },
    })
  })

  it('passes scriptArtifactId from the query string into latest audio lookup', async () => {
    const response = await handleLatestAudioArtifactGet(
      new Request('http://localhost/api/projects/demo/audio-artifacts/latest?scriptArtifactId=script-001'),
      {
        projectId: 'demo',
        getLatest: async (input) => {
          expect(input).toEqual({ projectId: 'demo', scriptArtifactId: 'script-001' })
          return {
            status: 'not_found',
            source: 'audio_artifact_query',
          } satisfies LatestAudioArtifactResult
        },
      },
    )

    expect(response.status).toBe(404)
  })

  it('returns 404 when no ready audio exists', async () => {
    const response = await handleLatestAudioArtifactGet(
      new Request('http://localhost/api/projects/demo/audio-artifacts/latest'),
      {
        projectId: 'demo',
        getLatest: async () =>
          ({
            status: 'not_found',
            source: 'audio_artifact_query',
          }) satisfies LatestAudioArtifactResult,
      },
    )

    expect(response.status).toBe(404)
  })
})
