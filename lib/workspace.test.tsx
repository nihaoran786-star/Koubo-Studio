// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyScript, useWorkspace } from './workspace'

const mocks = vi.hoisted(() => ({
  list: vi.fn(), create: vi.fn(), get: vi.fn(), mutate: vi.fn(),
}))
vi.mock('./project-state/project-state-client', () => ({ createProjectStateClient: () => mocks }))

const project = {
  version: 1 as const, revision: 3, projectId: 'project-001', title: '服务端项目', status: 'editing' as const,
  currentStep: 'render' as const, furthestStep: 'publish' as const,
  stages: {
    script: { status: 'ready' as const, artifactId: 'script-001', updatedAt: '2026-07-16T00:00:00.000Z' },
    voice: { status: 'ready' as const, artifactId: 'audio-001', updatedAt: '2026-07-16T00:00:00.000Z' },
    digitalHuman: { status: 'ready' as const, artifactId: 'render-001', updatedAt: '2026-07-16T00:00:00.000Z' },
    edit: { status: 'ready' as const, artifactId: 'post-001', updatedAt: '2026-07-16T00:00:00.000Z' },
    publish: { status: 'needs_input' as const, updatedAt: '2026-07-16T00:00:00.000Z' },
  },
  script: { ...emptyScript(), artifactId: 'script-001', title: '服务端项目', approvalStatus: 'approved' as const },
  createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z',
}

beforeEach(() => {
  localStorage.clear()
  mocks.list.mockResolvedValue({ status: 'ok', source: 'project_state', projects: [project] })
  mocks.create.mockResolvedValue({ status: 'ok', source: 'project_state', project })
  mocks.get.mockResolvedValue({ status: 'ok', source: 'project_state', project })
  mocks.mutate.mockResolvedValue({ status: 'ok', source: 'project_state', project: { ...project, revision: 4 } })
})
afterEach(() => vi.clearAllMocks())

describe('API-backed workspace facade', () => {
  it('exposes valid projects with degraded recovery state and retries the list', async () => {
    mocks.list
      .mockResolvedValueOnce({
        status: 'degraded', source: 'project_state', projects: [project],
        issues: [{ projectId: 'project-corrupt', code: 'invalid_project_state', message: '项目数据已损坏，暂时无法打开。' }],
      })
      .mockResolvedValueOnce({ status: 'ok', source: 'project_state', projects: [project], issues: [] })

    const { result } = renderHook(() => useWorkspace())
    await waitFor(() => expect(result.current.status).toBe('degraded'))
    expect(result.current.projects).toHaveLength(1)
    expect(result.current.error).toMatchObject({ code: 'invalid_project_state' })

    await act(async () => { await result.current.retry() })

    expect(result.current.status).toBe('ready')
    expect(result.current.error).toBeUndefined()
    expect(mocks.list).toHaveBeenCalledTimes(2)
  })

  it('hydrates stage and artifact selections exclusively from project.json API state', async () => {
    localStorage.setItem('koubo-agent.workspace.v1', JSON.stringify({ projects: [{ id: 'project-001', title: '旧浏览器项目', script: emptyScript() }] }))
    const { result } = renderHook(() => useWorkspace())
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.projects).toEqual([
      expect.objectContaining({
        id: 'project-001', title: '服务端项目', step: 4, furthestStep: 5,
        selectedAudioArtifactId: 'audio-001', selectedRenderArtifactId: 'render-001', selectedPostProductionArtifactId: 'post-001',
      }),
    ])
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('creates projects on the server before exposing them to the UI', async () => {
    mocks.list.mockResolvedValueOnce({ status: 'ok', source: 'project_state', projects: [] })
    const { result } = renderHook(() => useWorkspace())
    await waitFor(() => expect(result.current.ready).toBe(true))
    let id = ''
    await act(async () => { id = await result.current.createProject() })
    expect(id).toBe('project-001')
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ script: expect.objectContaining({ approvalStatus: 'draft' }) }))
    expect(result.current.projects[0].id).toBe('project-001')
  })
})
