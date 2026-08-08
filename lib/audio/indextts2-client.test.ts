import { describe, expect, it, vi } from 'vitest'
import {
  createIndexTTS2Client,
  createIndexTTS2TaskClient,
  indexTTS2Endpoint,
  statusFromIndexTTS2Result,
} from './indextts2-client'

describe('IndexTTS2 client', () => {
  it('builds the project audio endpoint', () => {
    expect(indexTTS2Endpoint('demo project')).toBe('/api/projects/demo%20project/audio/indextts2')
  })

  it('posts voice generation parameters', async () => {
    const mockFetcher = vi.fn(async () => ({
      json: async () => ({
        status: 'ok',
        source: 'indextts2_service',
        artifact: {
          artifactId: 'audio-001',
        },
      }),
    }))
    const fetcher = mockFetcher as unknown as typeof fetch

    const client = createIndexTTS2Client(fetcher)
    const result = await client({
      projectId: 'demo',
      sessionId: 'voice-session-001',
      parameters: {
        scriptArtifactId: 'script-001',
        text: '测试',
        referenceAudioPath: 'files/audio/reference.wav',
        speed: 1,
        emotionText: '自然清晰',
        emotionAlpha: 0.2,
        emotionReferenceAudioPath: 'files/audio/emotion.wav',
        seed: 42,
        trimSeconds: 10,
        useRandom: false,
        outputFormat: 'wav',
      },
    })

    expect(fetcher).toHaveBeenCalledWith('/api/projects/demo/audio/indextts2', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: expect.stringContaining('"trimSeconds":10'),
    })
    const [, init] = mockFetcher.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit]
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({
      sessionId: 'voice-session-001',
      parameters: {
        scriptArtifactId: 'script-001',
        referenceAudioPath: 'files/audio/reference.wav',
        emotionText: '自然清晰',
        emotionReferenceAudioPath: 'files/audio/emotion.wav',
        seed: 42,
        trimSeconds: 10,
      },
    })
    expect(statusFromIndexTTS2Result(result)).toBe('done')
  })

  it('returns desktop_backend_missing when IndexTTS2 API cannot be reached', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    const client = createIndexTTS2Client(fetcher)

    await expect(
      client({
        projectId: 'demo',
        sessionId: 'voice-session-001',
        parameters: {
          scriptArtifactId: 'script-001',
          text: '测试',
          speed: 1,
          emotionAlpha: 0.2,
          useRandom: false,
          outputFormat: 'wav',
        },
      }),
    ).resolves.toMatchObject({
      status: 'adapter_error',
      source: 'desktop_runtime',
      error: {
        code: 'desktop_backend_missing',
      },
    })
  })

  it('gets a persisted task by session id', async () => {
    const fetcher = vi.fn(async () => ({
      json: async () => ({
        status: 'ok',
        source: 'indextts2_task',
        task: { taskId: 'audio-001', status: 'ready' },
        artifact: { artifactId: 'audio-001' },
      }),
    })) as unknown as typeof fetch

    await expect(createIndexTTS2TaskClient(fetcher)({
      projectId: 'demo',
      sessionId: 'voice session',
    })).resolves.toMatchObject({
      status: 'ok',
      task: { status: 'ready' },
      artifact: { artifactId: 'audio-001' },
    })
    expect(fetcher).toHaveBeenCalledWith(
      '/api/projects/demo/audio/indextts2?sessionId=voice%20session',
      undefined,
    )
  })
})
