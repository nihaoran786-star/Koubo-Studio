import fs from 'node:fs/promises'
import path from 'node:path'
import type { ProjectWorkspace } from '@/lib/workspaces/workspace-types'
import { assertInsideRoot, assertSafeSegment } from '@/lib/workspaces/workspace-guard'
import { RawMediaUploadError, streamFromBytes, writeRawMediaUpload } from '@/lib/media/raw-media-upload'

export type AudioAssetPurpose = 'reference' | 'emotion' | 'recording'
export type AudioAssetStatus = 'ready' | 'failed'
export type AudioAssetExtension = 'wav' | 'mp3' | 'm4a'

export interface AudioAsset {
  assetId: string
  assetType: 'audio'
  projectId: string
  featureType: ProjectWorkspace['featureType']
  purpose: AudioAssetPurpose
  originalFilename: string
  contentType: string
  relativePath: string
  path: string
  size: number
  status: AudioAssetStatus
  createdAt: string
  updatedAt: string
}

export type AudioAssetUploadResult =
  | {
      status: 'ok'
      source: 'audio_asset'
      asset: AudioAsset
    }
  | {
      status: 'invalid_request' | 'upload_error'
      source: string
      error: {
        code: string
        message: string
      }
    }

interface AudioAssetIndexFile {
  version: 1
  assets: AudioAsset[]
}

const MAX_AUDIO_UPLOAD_SIZE = 50 * 1024 * 1024
const SUPPORTED_EXTENSIONS = ['wav', 'mp3', 'm4a'] as const
const SUPPORTED_CONTENT_TYPES = new Set([
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/x-m4a',
])

export class AudioAssetValidationError extends Error {
  source = 'audio_asset' as const

  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'AudioAssetValidationError'
  }
}

export function validateAudioAssetUpload(input: {
  filename: string
  contentType: string
  size: number
  purpose: unknown
}) {
  const purpose = parseAudioAssetPurpose(input.purpose)
  const extension = extensionFromFilename(input.filename)

  if (!SUPPORTED_EXTENSIONS.includes(extension)) {
    throw new AudioAssetValidationError('unsupported_file_type', '仅支持 wav、mp3、m4a 音频文件')
  }
  if (input.contentType && !SUPPORTED_CONTENT_TYPES.has(input.contentType)) {
    throw new AudioAssetValidationError('unsupported_content_type', '音频 MIME 类型不受支持')
  }
  if (input.size <= 0) {
    throw new AudioAssetValidationError('empty_file', '音频文件不能为空')
  }
  if (input.size > MAX_AUDIO_UPLOAD_SIZE) {
    throw new AudioAssetValidationError('file_too_large', '音频文件不能超过 50MB')
  }

  return { purpose, extension }
}

export async function saveAudioAsset(input: {
  workspace: ProjectWorkspace
  purpose: AudioAssetPurpose
  originalFilename: string
  contentType: string
  bytes: Uint8Array
  now?: string
}): Promise<Extract<AudioAssetUploadResult, { status: 'ok' }>> {
  return saveAudioAssetStream({
    ...input,
    body: streamFromBytes(input.bytes),
    expectedBytes: input.bytes.byteLength,
  })
}

export async function saveAudioAssetStream(input: {
  workspace: ProjectWorkspace
  purpose: AudioAssetPurpose
  originalFilename: string
  contentType: string
  body: ReadableStream<Uint8Array> | null
  expectedBytes?: number
  signal?: AbortSignal
  now?: string
}): Promise<Extract<AudioAssetUploadResult, { status: 'ok' }>> {
  const { extension } = validateAudioAssetUpload({
    filename: input.originalFilename,
    contentType: input.contentType,
    size: input.expectedBytes ?? 1,
    purpose: input.purpose,
  })
  const now = input.now ?? new Date().toISOString()
  const assetId = `${input.purpose}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`
  const safeAssetId = assertSafeSegment(assetId, 'assetId')
  const filesAudioPath = resolveAudioFilesPath(input.workspace)
  const filename = `${safeAssetId}.${extension}`
  const assetPath = assertInsideRoot(filesAudioPath, path.join(/*turbopackIgnore: true*/ filesAudioPath, filename))
  const relativePath = normalizeRelativePath(path.relative(input.workspace.rootPath, assetPath))
  const asset: AudioAsset = {
    assetId: safeAssetId,
    assetType: 'audio',
    projectId: input.workspace.projectId,
    featureType: input.workspace.featureType,
    purpose: input.purpose,
    originalFilename: input.originalFilename,
    contentType: input.contentType,
    relativePath,
    path: assetPath,
    size: 0,
    status: 'ready',
    createdAt: now,
    updatedAt: now,
  }

  await fs.mkdir(filesAudioPath, { recursive: true })
  try {
    asset.size = await writeRawMediaUpload({
      body: input.body,
      targetPath: assetPath,
      maxBytes: MAX_AUDIO_UPLOAD_SIZE,
      expectedBytes: input.expectedBytes,
      signal: input.signal,
    })
    validateAudioAssetUpload({
      filename: input.originalFilename,
      contentType: input.contentType,
      size: asset.size,
      purpose: input.purpose,
    })
    await appendAudioAsset(input.workspace, asset)
  } catch (error) {
    await fs.rm(assetPath, { force: true }).catch(() => undefined)
    if (error instanceof RawMediaUploadError) {
      throw new AudioAssetValidationError(error.code, audioUploadErrorMessage(error.code))
    }
    throw error
  }

  return {
    status: 'ok',
    source: 'audio_asset',
    asset,
  }
}

export async function getAudioAsset(workspace: ProjectWorkspace, assetId: string) {
  const safeAssetId = assertSafeSegment(assetId, 'assetId')
  const assets = await listAudioAssets(workspace)
  const asset = assets.find((item) => item.assetId === safeAssetId)
  if (!asset) {
    throw new AudioAssetValidationError('asset_not_found', 'audio asset 不存在')
  }
  return asset
}

export async function listAudioAssets(workspace: ProjectWorkspace) {
  const index = await readAudioAssetIndex(workspace)
  return index.assets
}

export async function deleteAudioAsset(workspace: ProjectWorkspace, assetId: string) {
  const asset = await getAudioAsset(workspace, assetId)
  const safePath = assertInsideRoot(workspace.filesPath, asset.path)
  await fs.rm(safePath, { force: true })
  const index = await readAudioAssetIndex(workspace)
  await writeAudioAssetIndex(workspace, {
    version: 1,
    assets: index.assets.filter((item) => item.assetId !== asset.assetId),
  })
  return asset
}

function parseAudioAssetPurpose(value: unknown): AudioAssetPurpose {
  if (value === 'reference' || value === 'emotion' || value === 'recording') return value
  throw new AudioAssetValidationError('invalid_purpose', 'purpose 只能是 reference、emotion 或 recording')
}

function extensionFromFilename(filename: string): AudioAssetExtension {
  const extension = path.extname(filename).replace('.', '').toLowerCase()
  if (extension === 'wav' || extension === 'mp3' || extension === 'm4a') return extension
  return extension as AudioAssetExtension
}

function resolveAudioFilesPath(workspace: ProjectWorkspace) {
  return assertInsideRoot(workspace.filesPath, path.join(/*turbopackIgnore: true*/ workspace.filesPath, 'audio'))
}

function resolveAudioAssetIndexPath(workspace: ProjectWorkspace) {
  const audioFilesPath = resolveAudioFilesPath(workspace)
  return assertInsideRoot(audioFilesPath, path.join(/*turbopackIgnore: true*/ audioFilesPath, 'index.json'))
}

async function appendAudioAsset(workspace: ProjectWorkspace, asset: AudioAsset) {
  const index = await readAudioAssetIndex(workspace)
  const nextAssets = [
    ...index.assets.filter((item) => item.assetId !== asset.assetId),
    asset,
  ]
  await writeAudioAssetIndex(workspace, { version: 1, assets: nextAssets })
}

async function readAudioAssetIndex(workspace: ProjectWorkspace): Promise<AudioAssetIndexFile> {
  const indexPath = resolveAudioAssetIndexPath(workspace)
  try {
    const raw = await fs.readFile(indexPath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<AudioAssetIndexFile>
    if (parsed.version !== 1 || !Array.isArray(parsed.assets)) {
      throw new AudioAssetValidationError('invalid_index', 'audio asset index 格式无效')
    }
    return { version: 1, assets: parsed.assets }
  } catch (error) {
    if (isMissingFile(error)) return { version: 1, assets: [] }
    throw error
  }
}

async function writeAudioAssetIndex(workspace: ProjectWorkspace, index: AudioAssetIndexFile) {
  const indexPath = resolveAudioAssetIndexPath(workspace)
  await fs.mkdir(path.dirname(indexPath), { recursive: true })
  const tempPath = `${indexPath}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(tempPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  await fs.rename(tempPath, indexPath)
}

function audioUploadErrorMessage(code: RawMediaUploadError['code']) {
  if (code === 'file_too_large') return '音频文件不能超过 50MB'
  if (code === 'empty_file' || code === 'missing_body') return '音频文件不能为空'
  if (code === 'upload_aborted') return '音频上传已取消'
  return '音频上传内容长度不完整'
}

function normalizeRelativePath(value: string) {
  return value.split(path.sep).join('/')
}

function isMissingFile(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
