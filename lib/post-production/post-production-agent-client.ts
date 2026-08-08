import type { PostProductionArtifact } from '@/lib/artifacts/post-production-artifact'
import { buildProjectApiEndpoint } from '@/lib/api/api-endpoint'
import { requestJson } from '@/lib/api/api-fetch'
import type { PostProductionAgentInput } from './post-production-agent-service'
import type { ProjectStateDocument } from '@/lib/project-state/project-state-types'
import type { PostProductionTaskState } from './post-production-task'

export type PostProductionAgentClientStatus =
  | 'idle'
  | 'recovering'
  | 'running'
  | 'done'
  | 'invalid_request'
  | 'skill_error'

export type PostProductionAgentClientResult =
  | {
      status: 'ok'
      source: 'post_production_agent'
      artifact: PostProductionArtifact
      skillCall: {
        skillId: string
        skillName: string
      }
      error?: never
    }
  | {
      status: 'invalid_request' | 'skill_error'
      source: string
      artifact?: PostProductionArtifact
      skillCall?: {
        skillId: string
        skillName: string
      }
      error: {
        code: string
        message: string
      }
    }

type Fetcher = typeof fetch

export type PostProductionTaskClientResult =
  | { status: 'ok'; source: 'post_production_task'; task?: PostProductionTaskState; artifact?: PostProductionArtifact; project: ProjectStateDocument }
  | { status: 'invalid_request' | 'skill_error'; source: string; error: { code: string; message: string } }

export function postProductionAgentEndpoint(projectId: string) {
  return buildProjectApiEndpoint(projectId, '/post-production-agent')
}

export function postProductionArtifactFileEndpoint(
  projectId: string,
  artifactId: string,
  kind: 'video' | 'cover' = 'video',
) {
  const endpoint = buildProjectApiEndpoint(projectId, `/post-production-artifacts/${encodeURIComponent(artifactId)}/file`)
  return kind === 'cover' ? `${endpoint}?kind=cover` : endpoint
}

export function createPostProductionAgentClient(fetcher: Fetcher = fetch) {
  return async function requestPostProductionAgent(input: {
    projectId: string
    sessionId: string
    input: PostProductionAgentInput
    signal?: AbortSignal
  }): Promise<PostProductionAgentClientResult> {
    return requestJson<PostProductionAgentClientResult>(postProductionAgentEndpoint(input.projectId), {
      fetcher,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: input.sessionId,
          input: input.input,
        }),
        ...(input.signal ? { signal: input.signal } : {}),
      },
      fallback: (error) => ({
        status: 'skill_error',
        source: 'desktop_runtime',
        error,
      }),
    })
  }
}

export function createPostProductionTaskClient(fetcher: Fetcher = fetch) {
  return async function requestPostProductionTask(input: { projectId: string; sessionId: string; signal?: AbortSignal }) {
    return requestJson<PostProductionTaskClientResult>(
      `${postProductionAgentEndpoint(input.projectId)}?sessionId=${encodeURIComponent(input.sessionId)}`,
      {
        fetcher,
        ...(input.signal ? { init: { signal: input.signal } } : {}),
        fallback: (error) => ({ status: 'skill_error', source: 'desktop_runtime', error }),
      },
    )
  }
}

export function statusFromPostProductionAgentResult(
  result: PostProductionAgentClientResult | undefined,
): PostProductionAgentClientStatus {
  if (!result) return 'idle'
  if (result.status === 'ok') return 'done'
  return result.status
}
