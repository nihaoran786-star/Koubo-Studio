import type { AudioArtifact } from '@/lib/artifacts/audio-artifact'
import { buildProjectApiEndpoint } from '@/lib/api/api-endpoint'
import { requestJson } from '@/lib/api/api-fetch'
import type { VoiceGenerationParameters } from './voice-generation'
import type { IndexTTS2TaskState } from './indextts2-task'

export type IndexTTS2ClientStatus =
  | 'idle'
  | 'running'
  | 'done'
  | 'invalid_request'
  | 'adapter_error'

export type IndexTTS2ClientResult =
  | {
      status: 'ok'
      source: 'indextts2_service'
      artifact: AudioArtifact
      error?: never
    }
  | {
      status: 'invalid_request' | 'adapter_error'
      source: string
      artifact?: never
      error: {
        code: string
        message: string
      }
    }

type Fetcher = typeof fetch

export type IndexTTS2TaskClientResult =
  | {
      status: 'ok'
      source: 'indextts2_task'
      task?: IndexTTS2TaskState
      artifact?: AudioArtifact
    }
  | {
      status: 'adapter_error'
      source: string
      error: { code: string; message: string }
    }

export function indexTTS2Endpoint(projectId: string) {
  return buildProjectApiEndpoint(projectId, '/audio/indextts2')
}

export function createIndexTTS2Client(fetcher: Fetcher = fetch) {
  return async function requestIndexTTS2(input: {
    projectId: string
    sessionId: string
    parameters: VoiceGenerationParameters
  }): Promise<IndexTTS2ClientResult> {
    return requestJson<IndexTTS2ClientResult>(indexTTS2Endpoint(input.projectId), {
      fetcher,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: input.sessionId,
          parameters: input.parameters,
        }),
      },
      fallback: (error) => ({
        status: 'adapter_error',
        source: 'desktop_runtime',
        error,
      }),
    })
  }
}

export function createIndexTTS2TaskClient(fetcher: Fetcher = fetch) {
  return async function requestIndexTTS2Task(input: {
    projectId: string
    sessionId: string
  }): Promise<IndexTTS2TaskClientResult> {
    const endpoint = `${indexTTS2Endpoint(input.projectId)}?sessionId=${encodeURIComponent(input.sessionId)}`
    return requestJson<IndexTTS2TaskClientResult>(endpoint, {
      fetcher,
      fallback: (error) => ({
        status: 'adapter_error',
        source: 'desktop_runtime',
        error,
      }),
    })
  }
}

export function statusFromIndexTTS2Result(result: IndexTTS2ClientResult | undefined): IndexTTS2ClientStatus {
  if (!result) return 'idle'
  if (result.status === 'ok') return 'done'
  return result.status
}
