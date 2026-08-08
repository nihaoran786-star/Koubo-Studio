import { NextResponse } from 'next/server'
import { ensureProjectWorkspace } from '@/lib/workspaces/workspace-manager'
import { assertInsideRoot, WorkspaceGuardError } from '@/lib/workspaces/workspace-guard'
import { decodeUploadHeader, parseContentLength, RawMediaUploadError } from '@/lib/media/raw-media-upload'
import { createWorkspaceMediaResponse, WorkspaceMediaResponseError } from '@/lib/workspaces/workspace-media-response'
import {
  deleteEditMediaAsset,
  EditMediaAssetError,
  getEditMediaAsset,
  listEditMediaAssets,
  parseEditMediaAssetKind,
  saveEditMediaAssetStream,
} from './edit-media-asset'

export async function handleEditMediaAssetGet(request: Request, projectId: string) {
  try {
    const kindValue = new URL(request.url).searchParams.get('kind')
    const kind = kindValue ? parseEditMediaAssetKind(kindValue) : undefined
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    return NextResponse.json({ status: 'ok', source: 'edit_media_asset', assets: await listEditMediaAssets(workspace, kind) })
  } catch (error) { return errorResponse(error) }
}

export async function handleEditMediaAssetPost(request: Request, projectId: string) {
  try {
    const encodedFilename = request.headers.get('x-koubo-filename')
    if (!encodedFilename) throw new EditMediaAssetError('missing_file', '请选择素材文件。')
    const originalFilename = decodeUploadHeader(encodedFilename, '文件名')
    const kind = parseEditMediaAssetKind(request.headers.get('x-koubo-edit-kind'))
    const encodedName = request.headers.get('x-koubo-asset-name')
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const asset = await saveEditMediaAssetStream({
      workspace,
      kind,
      name: encodedName ? decodeUploadHeader(encodedName, '素材名称') : undefined,
      originalFilename,
      contentType: request.headers.get('content-type') ?? '',
      body: request.body,
      expectedBytes: parseContentLength(request),
      signal: request.signal,
    })
    return NextResponse.json({ status: 'ok', source: 'edit_media_asset', asset })
  } catch (error) { return errorResponse(error) }
}

export async function handleEditMediaAssetDelete(projectId: string, assetId: string) {
  try {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const asset = await deleteEditMediaAsset(workspace, assetId)
    return NextResponse.json({ status: 'ok', source: 'edit_media_asset', assetId: asset.assetId })
  } catch (error) { return errorResponse(error) }
}

export async function handleEditMediaAssetFileGet(_request: Request, projectId: string, assetId: string) {
  try {
    const workspace = await ensureProjectWorkspace(projectId, 'digital-human')
    const asset = await getEditMediaAsset(workspace, assetId)
    return createWorkspaceMediaResponse({
      rootPath: workspace.filesPath,
      filePath: assertInsideRoot(workspace.filesPath, asset.path),
      contentType: asset.contentType || 'application/octet-stream',
    })
  } catch (error) { return errorResponse(error) }
}

function errorResponse(error: unknown) {
  if (error instanceof EditMediaAssetError) {
    return NextResponse.json({ status: 'invalid_request', source: error.source, error: { code: error.code, message: error.message } }, { status: error.code === 'asset_not_found' ? 404 : 400 })
  }
  if (error instanceof WorkspaceGuardError) {
    return NextResponse.json({ status: 'invalid_request', source: 'workspace', error: { code: 'workspace_guard', message: error.message } }, { status: 400 })
  }
  if (error instanceof WorkspaceMediaResponseError) {
    return NextResponse.json({
      status: 'asset_error',
      source: 'edit_media_asset',
      error: { code: error.code, message: error.message },
    }, { status: error.code === 'invalid_range' ? 416 : 404 })
  }
  if (error instanceof RawMediaUploadError) {
    return NextResponse.json({ status: 'invalid_request', source: 'edit_media_asset', error: { code: error.code, message: error.message } }, { status: 400 })
  }
  return NextResponse.json({ status: 'asset_error', source: 'edit_media_asset', error: { code: 'unexpected_error', message: error instanceof Error ? error.message : String(error) } }, { status: 500 })
}
