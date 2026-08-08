import { describe, expect, it } from 'vitest'
import { handlePostProductionAgentGet, handlePostProductionAgentPost } from './post-production-agent-route-handler'
import type { RunPostProductionAgentResult } from './post-production-agent-service'
import { createDefaultEditPlan } from './edit-plan'

describe('handlePostProductionAgentPost', () => {
  it('returns the persisted task reconciliation for GET', async () => {
    const response = await handlePostProductionAgentGet(
      new Request('http://localhost/api/projects/demo/post-production-agent?sessionId=post-session-001'),
      {
        projectId: 'demo',
        getTask: async () => ({
          status: 'ok', source: 'post_production_task',
          task: undefined,
          project: { projectId: 'demo' } as never,
        }),
      },
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ status: 'ok', source: 'post_production_task', project: { projectId: 'demo' } })
  })

  it('returns post-production artifacts', async () => {
    const response = await handlePostProductionAgentPost(
      new Request('http://localhost/api/projects/demo/post-production-agent', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: 'post-session-001',
          input: {
            renderArtifactId: 'render-001',
            request: '加字幕并整理成片',
            plan: createDefaultEditPlan(),
          },
        }),
      }),
      {
        projectId: 'demo',
        runAgent: async () =>
          ({
            status: 'ok',
            source: 'post_production_agent',
            skillCall: {
              skillId: 'builtin:post-production-cut-review',
              skillName: 'post-production-cut-review',
            },
            artifact: {
              artifactId: 'post-001',
              artifactType: 'post-production',
              projectId: 'demo',
              featureType: 'digital-human',
              sessionId: 'post-session-001',
              status: 'ready',
              source: 'local_ffmpeg',
              renderArtifactId: 'render-001',
              scriptArtifactId: 'script-001',
              outputPath: 'artifacts/post-production/post-001.mp4',
              durationSeconds: 8,
              parameters: {
                plan: createDefaultEditPlan(),
                request: '加字幕并整理成片',
              },
              skillCall: {
                skillId: 'builtin:post-production-cut-review',
                skillName: 'post-production-cut-review',
              },
              createdAt: '2026-06-11T00:00:00.000Z',
              updatedAt: '2026-06-11T00:00:00.000Z',
            },
          }) satisfies RunPostProductionAgentResult,
      },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      source: 'post_production_agent',
      artifact: {
        artifactType: 'post-production',
      },
      skillCall: {
        skillName: 'post-production-cut-review',
      },
    })
  })

  it('rejects invalid session ids with a typed error', async () => {
    const response = await handlePostProductionAgentPost(
      new Request('http://localhost/api/projects/demo/post-production-agent', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: '',
          input: {},
        }),
      }),
      {
        projectId: 'demo',
        runAgent: async () => {
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
