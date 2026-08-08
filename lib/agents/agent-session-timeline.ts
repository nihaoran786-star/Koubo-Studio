import { listArtifactRecords } from '@/lib/artifacts/artifact-index'
import type { ArtifactRecord } from '@/lib/artifacts/artifact-types'
import { ensureProjectWorkspace } from '@/lib/workspaces/workspace-manager'
import type { AgentSessionMetadata } from './agent-session'
import { AgentSessionIndexError, listAgentSessions } from './agent-session-index'

export interface AgentSessionTimelineItem {
  session: AgentSessionMetadata
  artifactRecord?: ArtifactRecord
}

export type AgentSessionTimelineResult =
  | {
      status: 'ok'
      source: 'agent_session_timeline'
      projectId: string
      items: AgentSessionTimelineItem[]
    }
  | {
      status: 'index_error'
      source: 'agent_session_timeline'
      error: {
        code: string
        message: string
      }
    }

export async function listAgentSessionTimeline(input: {
  projectId: string
}): Promise<AgentSessionTimelineResult> {
  try {
    const workspace = await ensureProjectWorkspace(input.projectId, 'digital-human')
    const [sessions, artifactRecords] = await Promise.all([
      listAgentSessions(workspace),
      listArtifactRecords(workspace),
    ])
    const artifactById = new Map(artifactRecords.map((record) => [record.artifactId, record]))
    const items = sessions
      .filter((session) => session.workspaceId === workspace.workspaceId)
      .map((session) => ({
        session,
        artifactRecord: session.artifactId ? artifactById.get(session.artifactId) : undefined,
      }))
      .sort((left, right) => timestampFor(right).localeCompare(timestampFor(left)))

    return {
      status: 'ok',
      source: 'agent_session_timeline',
      projectId: workspace.projectId,
      items,
    }
  } catch (error) {
    if (error instanceof AgentSessionIndexError) {
      return {
        status: 'index_error',
        source: 'agent_session_timeline',
        error: {
          code: error.code,
          message: error.message,
        },
      }
    }
    throw error
  }
}

function timestampFor(item: AgentSessionTimelineItem) {
  return item.artifactRecord?.updatedAt ?? item.artifactRecord?.createdAt ?? item.session.sessionId
}
