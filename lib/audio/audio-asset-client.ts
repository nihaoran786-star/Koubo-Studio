import type { AudioAsset, AudioAssetPurpose } from './audio-asset'
import { buildProjectApiEndpoint } from '@/lib/api/api-endpoint'
import { requestJson } from '@/lib/api/api-fetch'

export type AudioAssetClientStatus = 'idle' | 'uploading' | 'done' | 'invalid_request' | 'upload_error'

export type AudioAssetClientResult =
  | {
      status: 'ok'
      source: 'audio_asset'
      asset: AudioAsset
      error?: never
    }
  | {
      status: 'invalid_request' | 'upload_error'
      source: string
      asset?: never
      error: {
        code: string
        message: string
      }
    }

type Fetcher = typeof fetch

export function audioAssetEndpoint(projectId: string) {
  return buildProjectApiEndpoint(projectId, '/audio-assets')
}

export function audioAssetFileEndpoint(projectId: string, assetId: string) {
  return `${audioAssetEndpoint(projectId)}/${encodeURIComponent(assetId)}/file`
}

export async function listAudioAssetsClient(projectId: string, fetcher: Fetcher = fetch) {
  return requestJson<{ status: 'ok'; source: 'audio_asset'; assets: AudioAsset[] } | AudioAssetClientResult>(
    audioAssetEndpoint(projectId),
    {
      fetcher,
      fallback: (error) => ({ status: 'upload_error', source: 'desktop_runtime', error }),
    },
  )
}

export async function deleteAudioAssetClient(projectId: string, assetId: string, fetcher: Fetcher = fetch) {
  return requestJson<{ status: 'ok'; source: 'audio_asset'; assetId: string } | AudioAssetClientResult>(
    `${audioAssetEndpoint(projectId)}/${encodeURIComponent(assetId)}`,
    {
      fetcher,
      init: { method: 'DELETE' },
      fallback: (error) => ({ status: 'upload_error', source: 'desktop_runtime', error }),
    },
  )
}

export function createAudioAssetClient(fetcher: Fetcher = fetch) {
  return async function uploadAudioAsset(input: {
    projectId: string
    purpose: AudioAssetPurpose
    file: File
  }): Promise<AudioAssetClientResult> {
    return requestJson<AudioAssetClientResult>(audioAssetEndpoint(input.projectId), {
      fetcher,
      init: {
        method: 'POST',
        headers: {
          'content-type': input.file.type || 'application/octet-stream',
          'x-koubo-filename': encodeURIComponent(input.file.name),
          'x-koubo-audio-purpose': input.purpose,
        },
        body: input.file,
      },
      fallback: (error) => ({
        status: 'upload_error',
        source: 'desktop_runtime',
        error,
      }),
    })
  }
}

export function statusFromAudioAssetResult(result: AudioAssetClientResult | undefined): AudioAssetClientStatus {
  if (!result) return 'idle'
  if (result.status === 'ok') return 'done'
  return result.status
}
