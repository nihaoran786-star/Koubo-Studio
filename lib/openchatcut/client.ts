'use client'

import { requestJson } from '@/lib/api/api-fetch'
import type { OpenChatCutProjectBridge, OpenChatCutResult, OpenChatCutRuntimeStatus } from './types'

const runtimeEndpoint = '/api/openchatcut'

export function getOpenChatCutRuntimeClient() {
  return requestJson<OpenChatCutResult<{ runtime: OpenChatCutRuntimeStatus }>>(runtimeEndpoint, {
    fallback: (error) => ({ status: 'error', source: 'openchatcut', error }),
  })
}

export function mutateOpenChatCutRuntimeClient(body: { action: 'prepare' } | { action: 'launch'; target: 'installer' | 'app' }) {
  return requestJson<OpenChatCutResult<{ runtime: OpenChatCutRuntimeStatus }>>(runtimeEndpoint, {
    init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    fallback: (error) => ({ status: 'error', source: 'openchatcut', error }),
  })
}

export function mutateOpenChatCutProjectClient(projectId: string, body: Record<string, unknown>) {
  return requestJson<OpenChatCutResult<{ bridge: OpenChatCutProjectBridge }>>(`/api/openchatcut/projects/${encodeURIComponent(projectId)}`, {
    init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    fallback: (error) => ({ status: 'error', source: 'openchatcut', error }),
  })
}

export function getOpenChatCutProjectClient(projectId: string) {
  return requestJson<OpenChatCutResult<{
    bridge?: OpenChatCutProjectBridge
    stale?: boolean
    detail?: string
  }>>(`/api/openchatcut/projects/${encodeURIComponent(projectId)}`, {
    fallback: (error) => ({ status: 'error', source: 'openchatcut', error }),
  })
}
