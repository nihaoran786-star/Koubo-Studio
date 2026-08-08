import { NextResponse } from 'next/server'
import { ensureProjectWorkspace } from '@/lib/workspaces/workspace-manager'
import { assertInsideRoot, WorkspaceGuardError } from '@/lib/workspaces/workspace-guard'
import { decodeUploadHeader, parseContentLength, RawMediaUploadError } from '@/lib/media/raw-media-upload'
import { createWorkspaceMediaResponse, WorkspaceMediaResponseError } from '@/lib/workspaces/workspace-media-response'
import {
  AvatarAssetValidationError,
  getAvatarAsset,
  deleteAvatarAsset,
  listAvatarAssets,
  saveAvatarAssetStream,
  type AvatarAssetUploadResult,
} from './avatar-asset'

export async function handleAvatarAssetPost(
  request: Request,
  options: {
    projectId: string
    saveAsset?: (input: {
      projectId: string
      originalFilename: string
      contentType: string
      body: ReadableStream<Uint8Array> | null
      expectedBytes?: number
      signal: AbortSignal
    }) => Promise<AvatarAssetUploadResult>
  },
) {
  try {
    const encodedFilename = request.headers.get('x-koubo-filename')
    if (!encodedFilename) return invalidRequest('missing_file', 'file 不能为空')
    const originalFilename = decodeUploadHeader(encodedFilename, '文件名')
    const result = await (options.saveAsset ?? saveAssetFromWorkspace)({
      projectId: options.projectId,
      originalFilename,
      contentType: request.headers.get('content-type') ?? '',
      body: request.body,
      expectedBytes: parseContentLength(request),
      signal: request.signal,
    })

    return NextResponse.json(result, { status: statusCodeForResult(result) })
  } catch (error) {
    if (error instanceof AvatarAssetValidationError) {
      return NextResponse.json(
        {
          status: 'invalid_request',
          source: error.source,
          error: {
            code: error.code,
            message: error.message,
          },
        },
        { status: 400 },
      )
    }
    if (error instanceof WorkspaceGuardError) {
      return invalidRequest('workspace_guard', error.message)
    }
    if (error instanceof RawMediaUploadError) return invalidRequest(error.code, error.message)

    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json(
      {
        status: 'upload_error',
        source: 'api',
        error: {
          code: 'unexpected_error',
          message,
        },
      },
      { status: 500 },
    )
  }
}

export async function handleAvatarAssetGet(options: { projectId: string }) {
  try {
    const workspace = await ensureProjectWorkspace(options.projectId, 'digital-human')
    return NextResponse.json({ status: 'ok', source: 'avatar_asset', assets: await listAvatarAssets(workspace) })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function handleAvatarAssetDelete(options: { projectId: string; assetId: string }) {
  try {
    const workspace = await ensureProjectWorkspace(options.projectId, 'digital-human')
    const asset = await deleteAvatarAsset(workspace, options.assetId)
    return NextResponse.json({ status: 'ok', source: 'avatar_asset', assetId: asset.assetId })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function handleAvatarAssetFileGet(
  request: Request,
  options: {
    projectId: string
    assetId: string
    openFile?: (input: { projectId: string; assetId: string }) => Promise<Response>
  },
) {
  try {
    return await (options.openFile ?? openAvatarAssetFileFromWorkspace)({
      projectId: options.projectId,
      assetId: options.assetId,
    })
  } catch (error) {
    return errorResponse(error)
  }
}

async function saveAssetFromWorkspace(input: {
  projectId: string
  originalFilename: string
  contentType: string
  body: ReadableStream<Uint8Array> | null
  expectedBytes?: number
  signal: AbortSignal
}) {
  const workspace = await ensureProjectWorkspace(input.projectId, 'digital-human')
  return saveAvatarAssetStream({
    workspace,
    originalFilename: input.originalFilename,
    contentType: input.contentType,
    body: input.body,
    expectedBytes: input.expectedBytes,
    signal: input.signal,
  })
}

async function openAvatarAssetFileFromWorkspace(input: { projectId: string; assetId: string }) {
  const workspace = await ensureProjectWorkspace(input.projectId, 'digital-human')
  const asset = await getAvatarAsset(workspace, input.assetId)
  const safePath = assertInsideRoot(workspace.filesPath, asset.path)
  return createWorkspaceMediaResponse({
    rootPath: workspace.filesPath,
    filePath: safePath,
    contentType: asset.contentType || contentTypeForAvatarAsset(safePath),
  })
}

function contentTypeForAvatarAsset(filePath: string) {
  const normalized = filePath.toLowerCase()
  if (normalized.endsWith('.mov')) return 'video/quicktime'
  if (normalized.endsWith('.webm')) return 'video/webm'
  return 'video/mp4'
}

function invalidRequest(code: string, message: string) {
  return NextResponse.json(
    {
      status: 'invalid_request',
      source: 'api',
      error: {
        code,
        message,
      },
    },
    { status: 400 },
  )
}

function errorResponse(error: unknown) {
  if (error instanceof AvatarAssetValidationError) {
    return NextResponse.json(
      {
        status: 'invalid_request',
        source: error.source,
        error: {
          code: error.code,
          message: error.message,
        },
      },
      { status: 404 },
    )
  }
  if (error instanceof WorkspaceGuardError) {
    return invalidRequest('workspace_guard', error.message)
  }
  if (error instanceof WorkspaceMediaResponseError) {
    return NextResponse.json(
      {
        status: 'avatar_asset_error',
        source: 'avatar_asset_file',
        error: { code: error.code, message: error.message },
      },
      { status: error.code === 'invalid_range' ? 416 : 404 },
    )
  }

  const message = error instanceof Error ? error.message : String(error)
  return NextResponse.json(
    {
      status: 'avatar_asset_error',
      source: 'avatar_asset_file',
      error: {
        code: 'unexpected_error',
        message,
      },
    },
    { status: 500 },
  )
}

function statusCodeForResult(result: AvatarAssetUploadResult) {
  if (result.status === 'ok') return 200
  if (result.status === 'invalid_request') return 400
  return 500
}
