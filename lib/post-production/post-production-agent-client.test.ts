import { describe, expect, it, vi } from 'vitest'
import {
  createPostProductionAgentClient,
  createPostProductionTaskClient,
  postProductionArtifactFileEndpoint,
  postProductionAgentEndpoint,
  statusFromPostProductionAgentResult,
} from './post-production-agent-client'
import { createDefaultEditPlan } from './edit-plan'

describe('post-production agent client', () => {
  it('builds the project post-production endpoint', () => {
    expect(postProductionAgentEndpoint('demo project')).toBe('/api/projects/demo%20project/post-production-agent')
  })

  it('builds encoded video and cover artifact endpoints', () => {
    expect(postProductionArtifactFileEndpoint('demo project', 'post 001')).toBe('/api/projects/demo%20project/post-production-artifacts/post%20001/file')
    expect(postProductionArtifactFileEndpoint('demo', 'post-001', 'cover')).toBe('/api/projects/demo/post-production-artifacts/post-001/file?kind=cover')
  })

  it('posts post-production input to the API', async () => {
    const fetcher = vi.fn(async () => ({
      json: async () => ({
        status: 'ok',
        source: 'post_production_agent',
        artifact: {
          artifactId: 'post-001',
        },
        skillCall: {
          skillName: 'post-production-cut-review',
        },
      }),
    })) as unknown as typeof fetch

    const client = createPostProductionAgentClient(fetcher)
    const result = await client({
      projectId: 'demo',
      sessionId: 'post-session-001',
      input: {
        renderArtifactId: 'render-001',
        request: '加字幕并整理成片',
        plan: createDefaultEditPlan(),
      },
    })

    expect(fetcher).toHaveBeenCalledWith('/api/projects/demo/post-production-agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: expect.stringContaining('post-session-001'),
    })
    expect(statusFromPostProductionAgentResult(result)).toBe('done')
  })

  it('returns desktop_backend_missing when post-production API cannot be reached', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    const client = createPostProductionAgentClient(fetcher)

    await expect(
      client({
        projectId: 'demo',
        sessionId: 'post-session-001',
        input: {
          renderArtifactId: 'render-001',
          request: '加字幕并整理成片',
          plan: createDefaultEditPlan(),
        },
      }),
    ).resolves.toMatchObject({
      status: 'skill_error',
      source: 'desktop_runtime',
      error: {
        code: 'desktop_backend_missing',
      },
    })
  })

  it('loads the persisted post-production task for recovery', async () => {
    const fetcher = vi.fn(async () => ({ json: async () => ({ status: 'ok', source: 'post_production_task', project: { projectId: 'demo' } }) })) as unknown as typeof fetch
    const client = createPostProductionTaskClient(fetcher)
    await expect(client({ projectId: 'demo', sessionId: 'post-session' })).resolves.toMatchObject({ status: 'ok', source: 'post_production_task' })
    expect(fetcher).toHaveBeenCalledWith('/api/projects/demo/post-production-agent?sessionId=post-session', undefined)
  })
})
