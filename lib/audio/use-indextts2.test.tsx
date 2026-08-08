// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useIndexTTS2 } from './use-indextts2'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useIndexTTS2', () => {
  it('submits voice parameters and exposes the generated artifact', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => ({
      json: async () => init?.method === 'POST'
        ? ({
            status: 'ok',
            source: 'indextts2_service',
            artifact: {
              artifactId: 'audio-001',
              outputPath: 'audio/audio-001.wav',
              createdAt: '2026-07-15T00:00:00.000Z',
              updatedAt: '2026-07-15T00:00:00.000Z',
            },
          })
        : ({ status: 'ok', source: 'indextts2_task' }),
    }))
    vi.stubGlobal('fetch', fetcher)
    const user = userEvent.setup()

    render(<IndexTTS2Probe />)
    await user.click(screen.getByRole('button', { name: '生成音频' }))

    await waitFor(() => expect(screen.getByText('done')).toBeInTheDocument())
    expect(screen.getByText('audio-001')).toBeInTheDocument()
    expect(fetcher).toHaveBeenCalledWith('/api/projects/demo/audio/indextts2', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"speed":1.2'),
    }))
    const postCall = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')
    const [, init] = postCall as unknown as [RequestInfo | URL, RequestInit]
    const body = JSON.parse(String(init.body))
    expect(body.parameters).toMatchObject({
      scriptArtifactId: 'script-001',
      referenceAudioPath: 'files/audio/reference.wav',
      emotionText: '自然清晰',
      emotionReferenceAudioPath: 'files/audio/emotion.wav',
      seed: 99,
      trimSeconds: 10,
    })
  })

  it('recovers a ready artifact after refresh', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({
        status: 'ok',
        source: 'indextts2_task',
        task: {
          taskId: 'audio-recovered',
          projectId: 'demo',
          sessionId: 'voice-session',
          status: 'ready',
          artifactId: 'audio-recovered',
          createdAt: '2026-07-15T00:00:00.000Z',
          updatedAt: '2026-07-15T00:01:00.000Z',
        },
        artifact: {
          artifactId: 'audio-recovered',
          createdAt: '2026-07-15T00:00:00.000Z',
          updatedAt: '2026-07-15T00:01:00.000Z',
        },
      }),
    })))

    render(<IndexTTS2Probe />)
    await waitFor(() => expect(screen.getByText('done')).toBeInTheDocument())
    expect(screen.getByText('audio-recovered')).toBeInTheDocument()
  })

  it('recovers a stable failed task error after refresh', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({
        status: 'ok',
        source: 'indextts2_task',
        task: {
          taskId: 'audio-failed',
          projectId: 'demo',
          sessionId: 'voice-session',
          status: 'failed',
          error: { code: 'runtime_missing', message: 'IndexTTS2 runtime 未配置' },
          createdAt: '2026-07-15T00:00:00.000Z',
          updatedAt: '2026-07-15T00:01:00.000Z',
        },
      }),
    })))

    render(<IndexTTS2Probe />)
    await waitFor(() => expect(screen.getByText('adapter_error')).toBeInTheDocument())
    expect(screen.getByText('runtime_missing')).toBeInTheDocument()
  })
})

function IndexTTS2Probe() {
  const audio = useIndexTTS2('demo')

  return (
    <div>
      <span>{audio.status}</span>
      <span>{audio.lastResult?.status === 'ok' ? audio.lastResult.artifact.artifactId : ''}</span>
      <span>{audio.lastResult?.status !== 'ok' ? audio.lastResult?.error.code : ''}</span>
      <button
        onClick={() =>
          audio.generate({
            sessionId: 'voice-session-001',
            parameters: {
              scriptArtifactId: 'script-001',
              text: '测试音频',
              referenceAudioPath: 'files/audio/reference.wav',
              speed: 1.2,
              emotionText: '自然清晰',
              emotionAlpha: 0.25,
              emotionReferenceAudioPath: 'files/audio/emotion.wav',
              seed: 99,
              trimSeconds: 10,
              useRandom: false,
              outputFormat: 'wav',
            },
          })
        }
      >
        生成音频
      </button>
    </div>
  )
}
