import type { RenderArtifact } from '@/lib/artifacts/render-artifact'
import type { ProjectStateDocument } from '@/lib/project-state/project-state-types'
import { buildProjectApiEndpoint } from '@/lib/api/api-endpoint'
import { requestJson } from '@/lib/api/api-fetch'
import type { HeyGemGenerateInput } from './heygem-service'
import type { HeyGemTaskState } from './heygem-task'

export type HeyGemClientStatus =
  | 'idle'
  | 'recovering'
  | 'running'
  | 'done'
  | 'invalid_request'
  | 'adapter_error'

export type HeyGemClientResult =
  | {
      status: 'ok'
      source: 'heygem_service'
      artifact: RenderArtifact
      error?: never
    }
  | {
      status: 'invalid_request' | 'adapter_error'
      source: string
      artifact?: RenderArtifact
      error: {
        code: string
        message: string
      }
    }

type Fetcher = typeof fetch

export type HeyGemTaskClientResult =
  | {
      status: 'ok'
      source: 'heygem_task'
      task?: HeyGemTaskState
      artifact?: RenderArtifact
      project: ProjectStateDocument
    }
  | {
      status: 'invalid_request' | 'adapter_error'
      source: string
      error: { code: string; message: string }
    }

export function heyGemEndpoint(projectId: string) {
  return buildProjectApiEndpoint(projectId, '/digital-human/heygem')
}

export function renderArtifactFileEndpoint(projectId: string, artifactId: string) {
  return buildProjectApiEndpoint(projectId, `/render-artifacts/${encodeURIComponent(artifactId)}/file`)
}

export function createHeyGemClient(fetcher: Fetcher = fetch) {
  return async function requestHeyGem(input: {
    projectId: string
    sessionId: string
    input: HeyGemGenerateInput
    signal?: AbortSignal
  }): Promise<HeyGemClientResult> {
    return requestJson<HeyGemClientResult>(heyGemEndpoint(input.projectId), {
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
        status: 'adapter_error',
        source: 'desktop_runtime',
        error,
      }),
    })
  }
}

export function createHeyGemTaskClient(fetcher: Fetcher = fetch) {
  return async function requestHeyGemTask(input: {
    projectId: string
    sessionId: string
    signal?: AbortSignal
  }): Promise<HeyGemTaskClientResult> {
    const endpoint = `${heyGemEndpoint(input.projectId)}?sessionId=${encodeURIComponent(input.sessionId)}`
    return requestJson<HeyGemTaskClientResult>(endpoint, {
      fetcher,
      ...(input.signal ? { init: { signal: input.signal } } : {}),
      fallback: (error) => ({
        status: 'adapter_error',
        source: 'desktop_runtime',
        error,
      }),
    })
  }
}

export function statusFromHeyGemResult(result: HeyGemClientResult | undefined): HeyGemClientStatus {
  if (!result) return 'idle'
  if (result.status === 'ok') return 'done'
  return result.status
}
