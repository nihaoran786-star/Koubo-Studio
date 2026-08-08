import { requestJson } from '@/lib/api/api-fetch'

export type ManagedRuntimePhase = 'absent' | 'stopped' | 'running' | 'ready' | 'failed'

export type ManagedRuntimeResult =
  | {
      status: 'ok'
      source: 'managed_wsl'
      runtime: {
        phase: ManagedRuntimePhase
        installed: boolean
        running: boolean
        healthy: boolean
        version: string | null
        apiUrl: string | null
        detail: string
      }
      actions: {
        canImport: boolean
        canStart: boolean
        canStop: boolean
        canUninstall: boolean
      }
    }
  | {
      status: 'error'
      source: 'managed_wsl'
      error: { code: string; message: string }
    }

export function createManagedRuntimeClient(fetcher: typeof fetch = fetch) {
  return {
    get: async (): Promise<ManagedRuntimeResult> => {
      const result = await requestJson<unknown>('/api/settings/managed-runtime', {
        fetcher,
        init: { method: 'GET' },
        fallback: (error) => ({
          status: 'error',
          source: 'managed_wsl',
          error: { code: error.code, message: error.message },
        }),
      })
      return isManagedRuntimeResult(result)
        ? result
        : {
            status: 'error',
            source: 'managed_wsl',
            error: { code: 'invalid_response', message: '数字人运行环境返回了无法识别的数据。' },
          }
    },
  }
}

function isManagedRuntimeResult(value: unknown): value is ManagedRuntimeResult {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ManagedRuntimeResult>
  if (candidate.source !== 'managed_wsl') return false
  if (candidate.status === 'error') return Boolean(candidate.error?.code && candidate.error.message)
  return candidate.status === 'ok'
    && Boolean(candidate.runtime?.phase && candidate.runtime.detail)
    && typeof candidate.runtime?.installed === 'boolean'
    && typeof candidate.runtime?.running === 'boolean'
    && typeof candidate.runtime?.healthy === 'boolean'
    && Boolean(candidate.actions)
}
