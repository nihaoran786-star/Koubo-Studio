import type { LatestAudioArtifactResult } from './audio-artifact-query'
import { buildApiEndpoint, buildProjectApiEndpoint } from '@/lib/api/api-endpoint'
import { requestJson } from '@/lib/api/api-fetch'

export type LatestAudioArtifactStatus = 'idle' | 'loading' | 'done' | 'not_found' | 'error'

type Fetcher = typeof fetch

export function audioArtifactLatestEndpoint(projectId: string, options: { scriptArtifactId?: string } = {}) {
  const endpoint = buildProjectApiEndpoint(projectId, '/audio-artifacts/latest')
  if (!options.scriptArtifactId) return endpoint
  const params = new URLSearchParams({ scriptArtifactId: options.scriptArtifactId })
  return `${endpoint}?${params.toString()}`
}

export function audioArtifactFileEndpoint(projectId: string, artifactId: string) {
  return buildProjectApiEndpoint(projectId, `/audio-artifacts/${encodeURIComponent(artifactId)}/file`)
}

export function createAudioArtifactClient(fetcher: Fetcher = fetch) {
  return {
    latest: async (input: { projectId: string; scriptArtifactId?: string }): Promise<LatestAudioArtifactResult> => {
      const result = await requestJson<LatestAudioArtifactResult>(audioArtifactLatestEndpoint(input.projectId, {
        scriptArtifactId: input.scriptArtifactId,
      }), {
        fetcher,
        fallback: (error) => ({
          status: 'error',
          source: 'desktop_runtime',
          error,
        }),
      })
      return normalizeLatestAudioArtifactResult(result)
    },
  }
}

export function normalizeLatestAudioArtifactResult(result: LatestAudioArtifactResult): LatestAudioArtifactResult {
  if (result.status !== 'ok') return result
  return {
    ...result,
    selected: {
      ...result.selected,
      playbackUrl: buildApiEndpoint(result.selected.playbackUrl),
    },
  }
}

export function statusFromLatestAudioResult(result: LatestAudioArtifactResult | undefined): LatestAudioArtifactStatus {
  if (!result) return 'idle'
  if (result.status === 'ok') return 'done'
  if (result.status === 'not_found') return 'not_found'
  return 'error'
}
