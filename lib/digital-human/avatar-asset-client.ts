import type { AvatarAsset } from './avatar-asset'
import { buildProjectApiEndpoint } from '@/lib/api/api-endpoint'
import { requestJson } from '@/lib/api/api-fetch'

export type AvatarAssetClientStatus = 'idle' | 'uploading' | 'done' | 'invalid_request' | 'upload_error'

export type AvatarAssetClientResult =
  | {
      status: 'ok'
      source: 'avatar_asset'
      asset: AvatarAsset
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

export function avatarAssetEndpoint(projectId: string) {
  return buildProjectApiEndpoint(projectId, '/avatar-assets')
}

export function avatarAssetFileEndpoint(projectId: string, assetId: string) {
  return `${avatarAssetEndpoint(projectId)}/${encodeURIComponent(assetId)}/file`
}

export async function listAvatarAssetsClient(projectId: string, fetcher: Fetcher = fetch) {
  return requestJson<{ status: 'ok'; source: 'avatar_asset'; assets: AvatarAsset[] } | AvatarAssetClientResult>(
    avatarAssetEndpoint(projectId),
    {
      fetcher,
      fallback: (error) => ({ status: 'upload_error', source: 'desktop_runtime', error }),
    },
  )
}

export async function deleteAvatarAssetClient(projectId: string, assetId: string, fetcher: Fetcher = fetch) {
  return requestJson<{ status: 'ok'; source: 'avatar_asset'; assetId: string } | AvatarAssetClientResult>(
    `${avatarAssetEndpoint(projectId)}/${encodeURIComponent(assetId)}`,
    {
      fetcher,
      init: { method: 'DELETE' },
      fallback: (error) => ({ status: 'upload_error', source: 'desktop_runtime', error }),
    },
  )
}

export function createAvatarAssetClient(fetcher: Fetcher = fetch) {
  return async function uploadAvatarAsset(input: {
    projectId: string
    file: File
  }): Promise<AvatarAssetClientResult> {
    return requestJson<AvatarAssetClientResult>(avatarAssetEndpoint(input.projectId), {
      fetcher,
      init: {
        method: 'POST',
        headers: {
          'content-type': input.file.type || 'application/octet-stream',
          'x-koubo-filename': encodeURIComponent(input.file.name),
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

export function statusFromAvatarAssetResult(result: AvatarAssetClientResult | undefined): AvatarAssetClientStatus {
  if (!result) return 'idle'
  if (result.status === 'ok') return 'done'
  return result.status
}
