// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useHeyGem } from './use-heygem'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useHeyGem recovery state', () => {
  it('starts in recovering and only becomes done with a ready task plus artifact', async () => {
    let resolveFetch: ((response: Response) => void) | undefined
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve })))

    const { result } = renderHook(() => useHeyGem('project-001'))

    expect(result.current.status).toBe('recovering')

    await act(async () => {
      resolveFetch?.(jsonResponse(taskResult('render-001')))
    })

    await waitFor(() => expect(result.current.status).toBe('done'))
    expect(result.current.task).toMatchObject({ status: 'ready', artifactId: 'render-001' })
    expect(result.current.artifact).toMatchObject({ artifactId: 'render-001', status: 'ready' })
    expect(result.current.project).toMatchObject({ projectId: 'project-001' })
  })

  it('does not expose a ready task when the verified artifact is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      ...taskResult('render-missing'),
      artifact: undefined,
    })))

    const { result } = renderHook(() => useHeyGem('project-001'))

    await waitFor(() => expect(result.current.status).toBe('adapter_error'))
    expect(result.current.task).toBeUndefined()
    expect(result.current.lastResult).toMatchObject({
      error: { code: 'render_artifact_missing' },
    })
  })

  it('rejects an old ready task when the project digital-human stage no longer selects it', async () => {
    const stale = taskResult('render-old')
    stale.project.stages.digitalHuman.artifactId = 'render-current'
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(stale)))

    const { result } = renderHook(() => useHeyGem('project-001'))

    await waitFor(() => expect(result.current.status).toBe('adapter_error'))
    expect(result.current.task).toBeUndefined()
    expect(result.current.lastResult).toMatchObject({
      error: { code: 'render_project_state_mismatch' },
    })
  })

  it('resets to recovering when project or session changes', async () => {
    let resolveSecond: ((response: Response) => void) | undefined
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('project-001')) return jsonResponse(taskResult('render-001'))
      return new Promise<Response>((resolve) => { resolveSecond = resolve })
    })
    vi.stubGlobal('fetch', fetcher)

    const { result, rerender } = renderHook(
      ({ projectId, sessionId }) => useHeyGem(projectId, sessionId),
      { initialProps: { projectId: 'project-001', sessionId: 'avatar-session' } },
    )
    await waitFor(() => expect(result.current.status).toBe('done'))

    rerender({ projectId: 'project-002', sessionId: 'avatar-session-2' })

    expect(result.current.status).toBe('recovering')
    expect(result.current.task).toBeUndefined()

    await act(async () => {
      resolveSecond?.(jsonResponse(taskResult('render-002', 'project-002', 'avatar-session-2')))
    })
    await waitFor(() => expect(result.current.task?.artifactId).toBe('render-002'))
  })

  it('coalesces generation and prevents an older recovery GET from overwriting the confirmed result', async () => {
    const getResolvers: Array<(response: Response) => void> = []
    let resolvePost: ((response: Response) => void) | undefined
    const fetcher = vi.fn((_: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Promise<Response>((resolve) => { resolvePost = resolve })
      }
      return new Promise<Response>((resolve) => { getResolvers.push(resolve) })
    })
    vi.stubGlobal('fetch', fetcher)
    const { result } = renderHook(() => useHeyGem('project-001'))
    await waitFor(() => expect(getResolvers).toHaveLength(1))

    let first: Promise<unknown> | undefined
    let second: Promise<unknown> | undefined
    act(() => {
      first = result.current.generate(generateInput())
      second = result.current.generate(generateInput())
    })
    await act(async () => { await Promise.resolve() })
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)

    await act(async () => {
      resolvePost?.(jsonResponse({
        status: 'ok',
        source: 'heygem_service',
        artifact: taskResult('render-new').artifact,
      }))
      await Promise.all([first, second])
    })

    await waitFor(() => expect(getResolvers).toHaveLength(2))
    await act(async () => {
      getResolvers[1](jsonResponse(taskResult('render-new')))
    })
    await waitFor(() => expect(result.current.task?.artifactId).toBe('render-new'))

    await act(async () => {
      getResolvers[0](jsonResponse(taskResult('render-old')))
    })
    expect(result.current.status).toBe('done')
    expect(result.current.task?.artifactId).toBe('render-new')
  })

  it('keeps retrying transient GET failures with capped backoff, then polls queued and running tasks', async () => {
    vi.useFakeTimers()
    let attempt = 0
    const fetcher = vi.fn(async () => {
      attempt += 1
      if (attempt <= 5) throw new TypeError('temporary network failure')
      if (attempt === 6) return jsonResponse(progressTaskResult('queued'))
      if (attempt === 7) return jsonResponse(progressTaskResult('running'))
      return jsonResponse(taskResult('render-recovered'))
    })
    vi.stubGlobal('fetch', fetcher)

    const { result } = renderHook(() => useHeyGem('project-001'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.status).toBe('recovering')
    expect(fetcher).toHaveBeenCalledTimes(1)

    for (const delay of [1000, 2000, 4000, 8000, 8000]) {
      await act(async () => { await vi.advanceTimersByTimeAsync(delay) })
    }
    expect(fetcher).toHaveBeenCalledTimes(6)
    expect(result.current.status).toBe('running')
    expect(result.current.task?.status).toBe('queued')

    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(result.current.task?.status).toBe('running')
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(result.current.status).toBe('done')
    expect(result.current.artifact?.artifactId).toBe('render-recovered')
  })

  it('stops retrying a deterministic corrupt task-state error', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn(async () => jsonResponse({
      status: 'adapter_error',
      source: 'heygem_task',
      error: { code: 'task_state_corrupt', message: '任务状态文件损坏。' },
    }))
    vi.stubGlobal('fetch', fetcher)

    const { result } = renderHook(() => useHeyGem('project-001'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.status).toBe('adapter_error')
    expect(fetcher).toHaveBeenCalledTimes(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('reconciles an uncertain POST adapter error and unlocks the next generation', async () => {
    let postCount = 0
    let getCount = 0
    const fetcher = vi.fn(async (_: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        postCount += 1
        throw new TypeError('connection dropped after submit')
      }
      getCount += 1
      return jsonResponse(getCount === 1
        ? { ...taskResult('unused'), task: undefined, artifact: undefined }
        : taskResult(`render-post-${postCount}`))
    })
    vi.stubGlobal('fetch', fetcher)
    const { result } = renderHook(() => useHeyGem('project-001'))
    await waitFor(() => expect(result.current.status).toBe('idle'))

    await act(async () => { await result.current.generate(generateInput()) })
    await waitFor(() => expect(result.current.status).toBe('done'))
    expect(result.current.artifact?.artifactId).toBe('render-post-1')

    await act(async () => { await result.current.generate(generateInput()) })
    await waitFor(() => expect(result.current.artifact?.artifactId).toBe('render-post-2'))
    expect(postCount).toBe(2)
  })

  it('fails an invalid POST directly without starting recovery polling', async () => {
    let getCount = 0
    const fetcher = vi.fn(async (_: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return jsonResponse({
          status: 'invalid_request',
          source: 'api',
          error: { code: 'invalid_avatar', message: '形象素材无效。' },
        })
      }
      getCount += 1
      return jsonResponse({ ...taskResult('unused'), task: undefined, artifact: undefined })
    })
    vi.stubGlobal('fetch', fetcher)
    const { result } = renderHook(() => useHeyGem('project-001'))
    await waitFor(() => expect(result.current.status).toBe('idle'))

    await act(async () => { await result.current.generate(generateInput()) })
    expect(result.current.status).toBe('invalid_request')
    expect(result.current.lastResult).toMatchObject({ error: { code: 'invalid_avatar' } })
    expect(getCount).toBe(1)
  })
})

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function taskResult(artifactId: string, projectId = 'project-001', sessionId = 'avatar-session') {
  return {
    status: 'ok',
    source: 'heygem_task',
    task: {
      taskId: artifactId,
      projectId,
      sessionId,
      status: 'ready',
      artifactId,
      createdAt: '2026-07-17T00:00:00.000Z',
      updatedAt: '2026-07-17T00:01:00.000Z',
    },
    artifact: {
      artifactId,
      artifactType: 'render',
      projectId,
      featureType: 'digital-human',
      sessionId,
      status: 'ready',
      source: 'heygem',
      scriptArtifactId: 'script-001',
      audioArtifactId: 'audio-001',
      outputPath: `C:/workspace/${artifactId}.mp4`,
      durationSeconds: 12,
      avatar: { source: 'upload', id: 'avatar-001', name: 'avatar.mp4' },
      mode: 'standard',
      createdAt: '2026-07-17T00:00:00.000Z',
      updatedAt: '2026-07-17T00:01:00.000Z',
    },
    project: {
      version: 1,
      revision: 4,
      projectId,
      title: '测试项目',
      status: 'editing',
      currentStep: 'avatar',
      furthestStep: 'avatar',
      stages: {
        script: { status: 'ready', artifactId: 'script-001', updatedAt: '2026-07-17T00:00:00.000Z' },
        voice: { status: 'ready', artifactId: 'audio-001', updatedAt: '2026-07-17T00:00:00.000Z' },
        digitalHuman: {
          status: 'ready',
          artifactId,
          source: 'heygem',
          operation: {
            id: artifactId,
            sessionId,
            upstreamArtifactId: 'audio-001',
            startedAt: '2026-07-17T00:00:00.000Z',
          },
          updatedAt: '2026-07-17T00:01:00.000Z',
        },
        edit: { status: 'needs_input', updatedAt: '2026-07-17T00:00:00.000Z' },
        publish: { status: 'needs_input', updatedAt: '2026-07-17T00:00:00.000Z' },
      },
      script: {},
      createdAt: '2026-07-17T00:00:00.000Z',
      updatedAt: '2026-07-17T00:01:00.000Z',
    },
  }
}

function generateInput() {
  return {
    sessionId: 'avatar-session',
    input: {
      avatarAssetId: 'avatar-001',
      mode: 'standard' as const,
    },
  }
}

function progressTaskResult(status: 'queued' | 'running') {
  const result = taskResult('render-progress')
  return {
    ...result,
    task: {
      ...result.task,
      status,
      artifactId: undefined,
    },
    artifact: undefined,
    project: {
      ...result.project,
      stages: {
        ...result.project.stages,
        digitalHuman: {
          ...result.project.stages.digitalHuman,
          status: 'running',
          artifactId: undefined,
        },
      },
    },
  }
}
