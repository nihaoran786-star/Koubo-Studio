import { NextResponse } from 'next/server'
import { ensureProjectWorkspace } from '@/lib/workspaces/workspace-manager'
import { WorkspaceGuardError } from '@/lib/workspaces/workspace-guard'
import { decodeUploadHeader, parseContentLength, RawMediaUploadError } from '@/lib/media/raw-media-upload'
import { createWorkspaceMediaResponse, WorkspaceMediaResponseError } from '@/lib/workspaces/workspace-media-response'
import {
  saveAudioAssetStream,
  deleteAudioAsset,
  getAudioAsset,
  listAudioAssets,
  AudioAssetValidationError,
  type AudioAssetPurpose,
  type AudioAssetUploadResult,
} from './audio-asset'

export async function handleAudioAssetPost(
  request: Request,
  options: {
    projectId: string
    saveAsset?: (input: {
      projectId: string
      purpose: AudioAssetPurpose
      originalFilename: string
      contentType: string
      body: ReadableStream<Uint8Array> | null
      expectedBytes?: number
      signal: AbortSignal
    }) => Promise<AudioAssetUploadResult>
  },
) {
  try {
    const encodedFilename = request.headers.get('x-koubo-filename')
    if (!encodedFilename) return invalidRequest('missing_file', 'file 不能为空')
    const originalFilename = decodeUploadHeader(encodedFilename, '文件名')
    const purpose = request.headers.get('x-koubo-audio-purpose')
    if (!isAudioAssetPurpose(purpose)) {
      return invalidRequest('invalid_purpose', 'purpose 只能是 reference、emotion 或 recording')
    }

    const result = await (options.saveAsset ?? saveAssetFromWorkspace)({
      projectId: options.projectId,
      purpose,
      originalFilename,
      contentType: request.headers.get('content-type') ?? '',
      body: request.body,
      expectedBytes: parseContentLength(request),
      signal: request.signal,
    })

    return NextResponse.json(result, { status: statusCodeForResult(result) })
  } catch (error) {
    if (error instanceof AudioAssetValidationError) {
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

export async function handleAudioAssetGet(options: { projectId: string }) {
  try {
    const workspace = await ensureProjectWorkspace(options.projectId, 'digital-human')
    return NextResponse.json({ status: 'ok', source: 'audio_asset', assets: await listAudioAssets(workspace) })
  } catch (error) {
    return audioAssetErrorResponse(error)
  }
}

export async function handleAudioAssetDelete(options: { projectId: string; assetId: string }) {
  try {
    const workspace = await ensureProjectWorkspace(options.projectId, 'digital-human')
    const asset = await deleteAudioAsset(workspace, options.assetId)
    return NextResponse.json({ status: 'ok', source: 'audio_asset', assetId: asset.assetId })
  } catch (error) {
    return audioAssetErrorResponse(error)
  }
}

export async function handleAudioAssetFileGet(_request: Request, options: { projectId: string; assetId: string }) {
  try {
    const workspace = await ensureProjectWorkspace(options.projectId, 'digital-human')
    const asset = await getAudioAsset(workspace, options.assetId)
    const safePath = (await import('@/lib/workspaces/workspace-guard')).assertInsideRoot(workspace.filesPath, asset.path)
    return createWorkspaceMediaResponse({
      rootPath: workspace.filesPath,
      filePath: safePath,
      contentType: asset.contentType || 'audio/wav',
      acceptRanges: true,
    })
  } catch (error) {
    return audioAssetErrorResponse(error)
  }
}

function audioAssetErrorResponse(error: unknown) {
  if (error instanceof AudioAssetValidationError) {
    return NextResponse.json({
      status: 'invalid_request',
      source: error.source,
      error: { code: error.code, message: error.message },
    }, { status: error.code === 'asset_not_found' ? 404 : 400 })
  }
  if (error instanceof WorkspaceGuardError) return invalidRequest('workspace_guard', error.message)
  if (error instanceof WorkspaceMediaResponseError) {
    return NextResponse.json({
      status: 'asset_error',
      source: 'audio_asset',
      error: { code: error.code, message: error.message },
    }, { status: error.code === 'invalid_range' ? 416 : 404 })
  }
  return NextResponse.json({
    status: 'upload_error',
    source: 'audio_asset',
    error: { code: 'unexpected_error', message: error instanceof Error ? error.message : String(error) },
  }, { status: 500 })
}

async function saveAssetFromWorkspace(input: {
  projectId: string
  purpose: AudioAssetPurpose
  originalFilename: string
  contentType: string
  body: ReadableStream<Uint8Array> | null
  expectedBytes?: number
  signal: AbortSignal
}) {
  const workspace = await ensureProjectWorkspace(input.projectId, 'digital-human')
  return saveAudioAssetStream({
    workspace,
    purpose: input.purpose,
    originalFilename: input.originalFilename,
    contentType: input.contentType,
    body: input.body,
    expectedBytes: input.expectedBytes,
    signal: input.signal,
  })
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

function statusCodeForResult(result: AudioAssetUploadResult) {
  if (result.status === 'ok') return 200
  if (result.status === 'invalid_request') return 400
  return 500
}

function isAudioAssetPurpose(value: string | null): value is AudioAssetPurpose {
  return value === 'reference' || value === 'emotion' || value === 'recording'
}
