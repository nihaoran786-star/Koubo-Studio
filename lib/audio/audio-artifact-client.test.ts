import { describe, expect, it, vi } from 'vitest'
import {
  audioArtifactFileEndpoint,
  audioArtifactLatestEndpoint,
  createAudioArtifactClient,
  normalizeLatestAudioArtifactResult,
  statusFromLatestAudioResult,
} from './audio-artifact-client'

describe('audio artifact client', () => {
  it('builds the latest audio endpoint', () => {
    expect(audioArtifactLatestEndpoint('demo project')).toBe(
      '/api/projects/demo%20project/audio-artifacts/latest',
    )
    expect(audioArtifactLatestEndpoint('demo project', { scriptArtifactId: 'script 001' })).toBe(
      '/api/projects/demo%20project/audio-artifacts/latest?scriptArtifactId=script+001',
    )
  })

  it('builds the audio artifact file endpoint', () => {
    expect(audioArtifactFileEndpoint('demo project', 'audio 001')).toBe(
      '/api/projects/demo%20project/audio-artifacts/audio%20001/file',
    )
  })

  it('loads latest audio metadata', async () => {
    const fetcher = vi.fn(async () => ({
      json: async () => ({
        status: 'ok',
        source: 'audio_artifact_query',
        selected: {
          artifactId: 'audio-001',
          playbackUrl: '/api/projects/demo/audio-artifacts/audio-001/file',
        },
      }),
    })) as unknown as typeof fetch

    const client = createAudioArtifactClient(fetcher)
    const result = await client.latest({ projectId: 'demo' })

    expect(fetcher).toHaveBeenCalledWith('/api/projects/demo/audio-artifacts/latest', undefined)
    expect(statusFromLatestAudioResult(result)).toBe('done')
  })

  it('loads latest audio metadata for a specific script artifact', async () => {
    const fetcher = vi.fn(async () => ({
      json: async () => ({
        status: 'not_found',
        source: 'audio_artifact_query',
      }),
    })) as unknown as typeof fetch

    const client = createAudioArtifactClient(fetcher)
    await client.latest({ projectId: 'demo', scriptArtifactId: 'script-001' })

    expect(fetcher).toHaveBeenCalledWith(
      '/api/projects/demo/audio-artifacts/latest?scriptArtifactId=script-001',
      undefined,
    )
  })

  it('returns desktop_backend_missing when latest audio API cannot be reached', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    const client = createAudioArtifactClient(fetcher)

    await expect(client.latest({ projectId: 'demo' })).resolves.toMatchObject({
      status: 'error',
      source: 'desktop_runtime',
      error: {
        code: 'desktop_backend_missing',
      },
    })
  })

  it('normalizes relative playback URLs against configured desktop local backend', () => {
    vi.stubEnv('NEXT_PUBLIC_DESKTOP_LOCAL_BACKEND_URL', 'http://127.0.0.1:3100')

    expect(
      normalizeLatestAudioArtifactResult({
        status: 'ok',
        source: 'audio_artifact_query',
        selected: {
          artifactId: 'audio-001',
          outputPath: 'C:/workspace/audio.wav',
          durationSeconds: 3,
          playbackUrl: '/api/projects/demo/audio-artifacts/audio-001/file',
          createdAt: '2026-06-11T00:00:00.000Z',
        },
      }),
    ).toMatchObject({
      selected: {
        playbackUrl: 'http://127.0.0.1:3100/api/projects/demo/audio-artifacts/audio-001/file',
      },
    })

    vi.unstubAllEnvs()
  })
})
