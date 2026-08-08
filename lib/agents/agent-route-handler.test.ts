import { describe, expect, it } from 'vitest'
import type { AgentSessionDetailResult } from './agent-session-detail'
import { handleAgentGet } from './agent-route-handler'

const okResult: AgentSessionDetailResult = {
  status: 'ok',
  source: 'agent_session_detail',
  projectId: 'project-001',
  session: {
    sessionId: 'script-session-001',
    sessionKind: 'main',
    workspaceId: 'workspace-project-001',
    workspacePath: '/tmp/project-001',
    backend: 'local',
    agentRole: 'script',
    artifactId: 'script-001',
  },
}

describe('handleAgentGet', () => {
  it('returns project session timeline when requested', async () => {
    const response = await handleAgentGet(
      new Request('http://localhost/api/projects/project-001/agent?view=timeline'),
      {
        projectId: 'project-001',
        listSessionTimeline: async (input) => {
          expect(input).toEqual({ projectId: 'project-001' })
          return {
            status: 'ok',
            source: 'agent_session_timeline',
            projectId: 'project-001',
            items: [
              {
                session: okResult.session,
              },
            ],
          }
        },
      },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      source: 'agent_session_timeline',
      items: [
        {
          session: {
            sessionId: 'script-session-001',
          },
        },
      ],
    })
  })

  it('returns session detail by sessionId', async () => {
    const response = await handleAgentGet(
      new Request('http://localhost/api/projects/project-001/agent?sessionId=script-session-001'),
      {
        projectId: 'project-001',
        getSessionDetail: async (input) => {
          expect(input).toEqual({
            projectId: 'project-001',
            sessionId: 'script-session-001',
          })
          return okResult
        },
      },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      source: 'agent_session_detail',
      session: {
        sessionId: 'script-session-001',
        agentRole: 'script',
      },
    })
  })

  it('rejects missing sessionId', async () => {
    const response = await handleAgentGet(
      new Request('http://localhost/api/projects/project-001/agent'),
      {
        projectId: 'project-001',
        getSessionDetail: async () => {
          throw new Error('should not load detail')
        },
      },
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      status: 'invalid_request',
      source: 'api',
      error: {
        code: 'missing_session_id',
      },
    })
  })

  it('maps session detail errors to stable status codes', async () => {
    const response = await handleAgentGet(
      new Request('http://localhost/api/projects/project-001/agent?sessionId=missing-session'),
      {
        projectId: 'project-001',
        getSessionDetail: async () => ({
          status: 'invalid_request',
          source: 'agent_session_detail',
          error: {
            code: 'session_not_found',
            message: '未找到对应的 agent session。',
          },
        }),
      },
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      status: 'invalid_request',
      source: 'agent_session_detail',
      error: {
        code: 'session_not_found',
      },
    })
  })

  it('rejects unknown agent views', async () => {
    const response = await handleAgentGet(
      new Request('http://localhost/api/projects/project-001/agent?view=unknown'),
      {
        projectId: 'project-001',
      },
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      status: 'invalid_request',
      source: 'api',
      error: {
        code: 'invalid_view',
      },
    })
  })
})
