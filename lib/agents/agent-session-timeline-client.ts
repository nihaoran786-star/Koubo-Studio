import { requestJson } from '@/lib/api/api-fetch'
import { buildProjectApiEndpoint } from '@/lib/api/api-endpoint'
import type { AgentSessionMetadata } from './agent-session'
import type { ArtifactRecord } from '@/lib/artifacts/artifact-types'

type Fetcher = typeof fetch

export interface AgentSessionTimelineItem {
  session: AgentSessionMetadata
  artifactRecord?: ArtifactRecord
}

export type AgentSessionTimelineClientResult =
  | {
      status: 'ok'
      source: 'agent_session_timeline'
      projectId: string
      items: AgentSessionTimelineItem[]
    }
  | {
      status: 'agent_session_timeline_error' | 'index_error'
      source: 'agent_session_timeline' | 'desktop_runtime'
      error: {
        code: string
        message: string
      }
    }

export function agentSessionTimelineEndpoint(projectId: string) {
  return buildProjectApiEndpoint(projectId, '/agent?view=timeline')
}

export function createAgentSessionTimelineClient(fetcher: Fetcher = fetch) {
  return async (input: { projectId: string }): Promise<AgentSessionTimelineClientResult> =>
    requestJson<AgentSessionTimelineClientResult>(agentSessionTimelineEndpoint(input.projectId), {
      fetcher,
      init: { method: 'GET' },
      fallback: (error) => ({
        status: 'agent_session_timeline_error',
        source: 'desktop_runtime',
        error: {
          code: error.code,
          message: error.message,
        },
      }),
    })
}
