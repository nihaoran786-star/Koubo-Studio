import { describe, expect, it, vi } from 'vitest'
import {
  createHeyGemClient,
  createHeyGemTaskClient,
  heyGemEndpoint,
  renderArtifactFileEndpoint,
  statusFromHeyGemResult,
} from './heygem-client'

describe('HeyGem client', () => {
  it('builds the project digital-human endpoint', () => {
    expect(heyGemEndpoint('demo project')).toBe('/api/projects/demo%20project/digital-human/heygem')
  })

  it('builds render artifact file endpoints', () => {
    expect(renderArtifactFileEndpoint('demo project', 'render 001')).toBe(
      '/api/projects/demo%20project/render-artifacts/render%20001/file',
    )
  })

  it('posts only the selected avatar asset id and render mode', async () => {
    const fetcher = vi.fn(async () => ({
      json: async () => ({
        status: 'ok',
        source: 'heygem_service',
        artifact: {
          artifactId: 'render-001',
        },
      }),
    })) as unknown as typeof fetch

    const client = createHeyGemClient(fetcher)
    const result = await client({
      projectId: 'demo',
      sessionId: 'avatar-session-001',
      input: {
        avatarAssetId: 'avatar-001',
        mode: 'standard',
      },
    })

    expect(fetcher).toHaveBeenCalledWith('/api/projects/demo/digital-human/heygem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'avatar-session-001',
        input: {
          avatarAssetId: 'avatar-001',
          mode: 'standard',
        },
      }),
    })
    expect(statusFromHeyGemResult(result)).toBe('done')
  })

  it('returns desktop_backend_missing when HeyGem API cannot be reached', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    const client = createHeyGemClient(fetcher)

    await expect(
      client({
        projectId: 'demo',
        sessionId: 'avatar-session-001',
        input: {
          avatarAssetId: 'avatar-001',
          mode: 'standard',
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

  it('queries persisted task state by session id', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: 'ok',
        source: 'heygem_task',
        task: { status: 'ready', artifactId: 'render-001' },
      }),
    })) as unknown as typeof fetch

    const result = await createHeyGemTaskClient(fetcher)({
      projectId: 'demo project',
      sessionId: 'avatar session',
    })

    expect(fetcher).toHaveBeenCalledWith(
      '/api/projects/demo%20project/digital-human/heygem?sessionId=avatar%20session',
      undefined,
    )
    expect(result).toMatchObject({
      status: 'ok',
      task: { status: 'ready', artifactId: 'render-001' },
    })
  })

  it('forwards abort signals to POST and recovery GET requests', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      json: async () => ({ status: 'adapter_error', error: {} }),
    }))
    const fetcher = fetchMock as unknown as typeof fetch
    const controller = new AbortController()

    await createHeyGemClient(fetcher)({
      projectId: 'demo',
      sessionId: 'avatar-session',
      signal: controller.signal,
      input: {
        avatarAssetId: 'avatar-001',
        mode: 'standard',
      },
    })
    await createHeyGemTaskClient(fetcher)({
      projectId: 'demo',
      sessionId: 'avatar-session',
      signal: controller.signal,
    })

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', signal: controller.signal })
    expect(fetchMock.mock.calls[1]?.[1]).toEqual({ signal: controller.signal })
  })
})
