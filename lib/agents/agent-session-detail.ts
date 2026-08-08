import { listArtifactRecords } from '@/lib/artifacts/artifact-index'
import type { ArtifactRecord } from '@/lib/artifacts/artifact-types'
import { ensureProjectWorkspace } from '@/lib/workspaces/workspace-manager'
import type { AgentSessionMetadata } from './agent-session'
import { AgentSessionIndexError, listAgentSessions } from './agent-session-index'

export type AgentSessionDetailResult =
  | {
      status: 'ok'
      source: 'agent_session_detail'
      projectId: string
      session: AgentSessionMetadata
      parentSession?: AgentSessionMetadata
      artifactRecord?: ArtifactRecord
    }
  | {
      status: 'invalid_request' | 'index_error'
      source: 'agent_session_detail'
      error: {
        code: string
        message: string
      }
    }

export async function getAgentSessionDetail(input: {
  projectId: string
  sessionId: string
}): Promise<AgentSessionDetailResult> {
  if (!input.sessionId.trim()) {
    return invalidRequest('missing_session_id', 'sessionId 不能为空。')
  }

  try {
    const workspace = await ensureProjectWorkspace(input.projectId, 'digital-human')
    const session = (await listAgentSessions(workspace, { sessionId: input.sessionId.trim() }))[0]

    if (!session) {
      return invalidRequest('session_not_found', '未找到对应的 agent session。')
    }

    if (session.workspaceId !== workspace.workspaceId) {
      return invalidRequest('workspace_mismatch', 'agent session 不属于当前 workspace。')
    }

    const parentSession = session.parentSessionId
      ? (await listAgentSessions(workspace, { sessionId: session.parentSessionId }))[0]
      : undefined
    const artifactRecord = session.artifactId
      ? (await listArtifactRecords(workspace)).find((record) => record.artifactId === session.artifactId)
      : undefined

    return {
      status: 'ok',
      source: 'agent_session_detail',
      projectId: workspace.projectId,
      session,
      parentSession,
      artifactRecord,
    }
  } catch (error) {
    if (error instanceof AgentSessionIndexError) {
      return {
        status: 'index_error',
        source: 'agent_session_detail',
        error: {
          code: error.code,
          message: error.message,
        },
      }
    }
    throw error
  }
}

function invalidRequest(code: string, message: string): AgentSessionDetailResult {
  return {
    status: 'invalid_request',
    source: 'agent_session_detail',
    error: {
      code,
      message,
    },
  }
}
