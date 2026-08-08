import { describe, expect, it, vi } from 'vitest'
import {
  agentSessionTimelineEndpoint,
  createAgentSessionTimelineClient,
} from './agent-session-timeline-client'

describe('agent session timeline client', () => {
  it('builds the project timeline endpoint', () => {
    expect(agentSessionTimelineEndpoint('demo project')).toBe(
      '/api/projects/demo%20project/agent?view=timeline',
    )
  })

  it('fetches the project session timeline', async () => {
    const response = {
      status: 'ok',
      source: 'agent_session_timeline',
      projectId: 'project-001',
      items: [
        {
          session: {
            sessionId: 'script-session-001',
            sessionKind: 'main',
            workspaceId: 'workspace-project-001',
            workspacePath: '/tmp/project-001',
            backend: 'local',
            agentRole: 'script',
            artifactId: 'script-001',
          },
        },
      ],
    }
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const client = createAgentSessionTimelineClient(fetcher)

    await expect(client({ projectId: 'project-001' })).resolves.toEqual(response)
    expect(fetcher).toHaveBeenCalledWith('/api/projects/project-001/agent?view=timeline', {
      method: 'GET',
    })
  })

  it('returns desktop_backend_missing when the API cannot be reached', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    const client = createAgentSessionTimelineClient(fetcher)

    await expect(client({ projectId: 'project-001' })).resolves.toMatchObject({
      status: 'agent_session_timeline_error',
      source: 'desktop_runtime',
      error: {
        code: 'desktop_backend_missing',
      },
    })
  })
})
