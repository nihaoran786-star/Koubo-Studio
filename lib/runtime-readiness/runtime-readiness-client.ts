import { requestJson } from '@/lib/api/api-fetch'
import type { LocalRuntimeConfigPatch } from '@/lib/runtime-data/runtime-config-store'
import type { RuntimeReadinessApiResult, RuntimeReadinessProfileId, RuntimeReadinessUpdateInput } from './runtime-readiness-types'

type Fetcher = typeof fetch

export function createRuntimeReadinessClient(fetcher: Fetcher = fetch) {
  return {
    get: async (): Promise<RuntimeReadinessApiResult> =>
      requestJson<RuntimeReadinessApiResult>('/api/settings/runtime-readiness', {
        fetcher,
        init: { method: 'GET' },
        fallback: (error) => ({
          status: 'error',
          source: 'runtime_readiness',
          summary: { ready: 0, missing: 0, warning: 0 },
          checks: [],
          error: {
            code: 'runtime_readiness_error',
            message: error.message,
          },
        }),
      }),
    updateProfile: async (profileId: RuntimeReadinessProfileId): Promise<RuntimeReadinessApiResult> =>
      updateRuntimeReadiness(fetcher, { profileId }),
    updateLocalRuntimeConfig: async (localRuntimeConfig: LocalRuntimeConfigPatch): Promise<RuntimeReadinessApiResult> =>
      updateRuntimeReadiness(fetcher, { localRuntimeConfig }),
  }
}

function updateRuntimeReadiness(fetcher: Fetcher, input: RuntimeReadinessUpdateInput) {
  return requestJson<RuntimeReadinessApiResult>('/api/settings/runtime-readiness', {
    fetcher,
    init: {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
    fallback: (error) => ({
      status: 'error',
      source: 'runtime_readiness',
      summary: { ready: 0, missing: 0, warning: 0 },
      checks: [],
      error: {
        code: 'runtime_readiness_error',
        message: error.message,
      },
    }),
  })
}
