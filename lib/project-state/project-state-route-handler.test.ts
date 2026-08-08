import { describe, expect, it, vi } from 'vitest'
import { emptyScript } from '@/lib/workspace'
import { handleProjectsGet, handleProjectsPost, handleProjectStatePatch } from './project-state-route-handler'

vi.mock('./project-state-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./project-state-service')>()
  return {
    ...actual,
    createProjectState: vi.fn(async ({ projectId, script }) => ({
      version: 1, revision: 1, projectId: projectId ?? 'project-generated', title: '未命名口播作品', status: 'draft',
      currentStep: 'idea', furthestStep: 'idea', script, stages: {}, createdAt: 'now', updatedAt: 'now',
    })),
    mutateProjectState: vi.fn(async (_projectId, mutation) => ({ revision: 2, currentStep: mutation.step ?? 'idea' })),
    listProjectStates: vi.fn(async () => ({
      projects: [{ projectId: 'project-valid' }],
      issues: [{ projectId: 'project-corrupt', code: 'invalid_project_state', message: '项目数据已损坏，暂时无法打开。' }],
    })),
  }
})

describe('project state HTTP handlers', () => {
  it('returns a degraded list without hiding valid projects', async () => {
    const response = await handleProjectsGet()
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'degraded',
      projects: [{ projectId: 'project-valid' }],
      issues: [{ projectId: 'project-corrupt', code: 'invalid_project_state' }],
    })
  })

  it('creates a project from explicit local state', async () => {
    const response = await handleProjectsPost(new Request('http://localhost/api/projects', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'project-001', script: emptyScript() }),
    }))
    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({ status: 'ok', project: { projectId: 'project-001', revision: 1 } })
  })

  it('passes a controlled mutation to the project service', async () => {
    const response = await handleProjectStatePatch(new Request('http://localhost/api/projects/project-001/state', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'set_current_step', step: 'voice', expectedRevision: 1 }),
    }), { projectId: 'project-001' })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ status: 'ok', project: { revision: 2, currentStep: 'voice' } })
  })

  it('rejects malformed mutations at the route boundary', async () => {
    const response = await handleProjectStatePatch(new Request('http://localhost/api/projects/project-001/state', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}',
    }), { projectId: 'project-001' })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ status: 'invalid_request', error: { code: 'invalid_mutation' } })
  })
})
