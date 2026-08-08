import { buildProjectApiEndpoint } from '@/lib/api/api-endpoint'
import { requestJson } from '@/lib/api/api-fetch'
import type { EditMediaAsset, EditMediaAssetKind } from './edit-media-asset'

export function editMediaAssetEndpoint(projectId: string) {
  return buildProjectApiEndpoint(projectId, '/edit-media-assets')
}

export function editMediaAssetFileEndpoint(projectId: string, assetId: string) {
  return `${editMediaAssetEndpoint(projectId)}/${encodeURIComponent(assetId)}/file`
}

export async function listEditMediaAssetsClient(projectId: string, kind?: EditMediaAssetKind) {
  const suffix = kind ? `?kind=${encodeURIComponent(kind)}` : ''
  return requestJson<{ status: 'ok'; source: 'edit_media_asset'; assets: EditMediaAsset[] } | AssetClientError>(`${editMediaAssetEndpoint(projectId)}${suffix}`, { fallback })
}

export async function uploadEditMediaAssetClient(input: { projectId: string; kind: EditMediaAssetKind; name?: string; file: File }, fetcher: typeof fetch = fetch) {
  const headers: Record<string, string> = {
    'content-type': input.file.type || 'application/octet-stream',
    'x-koubo-filename': encodeURIComponent(input.file.name),
    'x-koubo-edit-kind': input.kind,
  }
  if (input.name) headers['x-koubo-asset-name'] = encodeURIComponent(input.name)
  return requestJson<{ status: 'ok'; source: 'edit_media_asset'; asset: EditMediaAsset } | AssetClientError>(editMediaAssetEndpoint(input.projectId), { fetcher, init: { method: 'POST', headers, body: input.file }, fallback })
}

export async function deleteEditMediaAssetClient(projectId: string, assetId: string) {
  return requestJson<{ status: 'ok'; source: 'edit_media_asset'; assetId: string } | AssetClientError>(`${editMediaAssetEndpoint(projectId)}/${encodeURIComponent(assetId)}`, { init: { method: 'DELETE' }, fallback })
}

interface AssetClientError { status: 'invalid_request' | 'asset_error'; source: string; error: { code: string; message: string } }
function fallback(error: { code: string; message: string }): AssetClientError {
  return { status: 'asset_error', source: 'desktop_runtime', error }
}
