import fs from 'node:fs/promises'
import path from 'node:path'
import type { ProjectWorkspace } from '@/lib/workspaces/workspace-types'
import { assertInsideRoot, assertSafeSegment, WorkspaceGuardError } from '@/lib/workspaces/workspace-guard'
import { RawMediaUploadError, streamFromBytes, writeRawMediaUpload } from '@/lib/media/raw-media-upload'

export type AvatarAssetStatus = 'ready' | 'failed'
export type AvatarAssetExtension = 'mp4' | 'mov' | 'webm'

export interface AvatarAsset {
  assetId: string
  assetType: 'avatar'
  projectId: string
  featureType: ProjectWorkspace['featureType']
  originalFilename: string
  contentType: string
  relativePath: string
  path: string
  size: number
  status: AvatarAssetStatus
  createdAt: string
  updatedAt: string
}

export type AvatarAssetUploadResult =
  | {
      status: 'ok'
      source: 'avatar_asset'
      asset: AvatarAsset
    }
  | {
      status: 'invalid_request' | 'upload_error'
      source: string
      error: {
        code: string
        message: string
      }
    }

interface AvatarAssetIndexFile {
  version: 1
  assets: AvatarAsset[]
}

const MAX_AVATAR_UPLOAD_SIZE = 300 * 1024 * 1024
const SUPPORTED_EXTENSIONS = ['mp4', 'mov', 'webm'] as const
const SUPPORTED_CONTENT_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/webm',
])

export class AvatarAssetValidationError extends Error {
  source = 'avatar_asset' as const

  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'AvatarAssetValidationError'
  }
}

export function validateAvatarAssetUpload(input: {
  filename: string
  contentType: string
  size: number
}) {
  const extension = extensionFromFilename(input.filename)

  if (!SUPPORTED_EXTENSIONS.includes(extension)) {
    throw new AvatarAssetValidationError('unsupported_file_type', '仅支持 mp4、mov、webm 数字人形象视频')
  }
  if (input.contentType && !SUPPORTED_CONTENT_TYPES.has(input.contentType)) {
    throw new AvatarAssetValidationError('unsupported_content_type', '数字人形象视频 MIME 类型不受支持')
  }
  if (input.size <= 0) {
    throw new AvatarAssetValidationError('empty_file', '数字人形象视频不能为空')
  }
  if (input.size > MAX_AVATAR_UPLOAD_SIZE) {
    throw new AvatarAssetValidationError('file_too_large', '数字人形象视频不能超过 300MB')
  }

  return { extension }
}

export async function saveAvatarAsset(input: {
  workspace: ProjectWorkspace
  originalFilename: string
  contentType: string
  bytes: Uint8Array
  now?: string
}): Promise<Extract<AvatarAssetUploadResult, { status: 'ok' }>> {
  return saveAvatarAssetStream({
    ...input,
    body: streamFromBytes(input.bytes),
    expectedBytes: input.bytes.byteLength,
  })
}

export async function saveAvatarAssetStream(input: {
  workspace: ProjectWorkspace
  originalFilename: string
  contentType: string
  body: ReadableStream<Uint8Array> | null
  expectedBytes?: number
  signal?: AbortSignal
  now?: string
}): Promise<Extract<AvatarAssetUploadResult, { status: 'ok' }>> {
  const { extension } = validateAvatarAssetUpload({
    filename: input.originalFilename,
    contentType: input.contentType,
    size: input.expectedBytes ?? 1,
  })
  const now = input.now ?? new Date().toISOString()
  const assetId = `avatar-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`
  const safeAssetId = assertSafeSegment(assetId, 'assetId')
  const filesAvatarPath = resolveAvatarFilesPath(input.workspace)
  const filename = `${safeAssetId}.${extension}`
  const assetPath = assertInsideRoot(filesAvatarPath, path.join(/*turbopackIgnore: true*/ filesAvatarPath, filename))
  const relativePath = normalizeRelativePath(path.relative(input.workspace.rootPath, assetPath))
  const asset: AvatarAsset = {
    assetId: safeAssetId,
    assetType: 'avatar',
    projectId: input.workspace.projectId,
    featureType: input.workspace.featureType,
    originalFilename: input.originalFilename,
    contentType: input.contentType,
    relativePath,
    path: assetPath,
    size: 0,
    status: 'ready',
    createdAt: now,
    updatedAt: now,
  }

  await fs.mkdir(filesAvatarPath, { recursive: true })
  try {
    asset.size = await writeRawMediaUpload({
      body: input.body,
      targetPath: assetPath,
      maxBytes: MAX_AVATAR_UPLOAD_SIZE,
      expectedBytes: input.expectedBytes,
      signal: input.signal,
    })
    validateAvatarAssetUpload({
      filename: input.originalFilename,
      contentType: input.contentType,
      size: asset.size,
    })
    await appendAvatarAsset(input.workspace, asset)
  } catch (error) {
    await fs.rm(assetPath, { force: true }).catch(() => undefined)
    if (error instanceof RawMediaUploadError) {
      throw new AvatarAssetValidationError(error.code, avatarUploadErrorMessage(error.code))
    }
    throw error
  }

  return {
    status: 'ok',
    source: 'avatar_asset',
    asset,
  }
}

export async function listAvatarAssets(workspace: ProjectWorkspace) {
  const index = await readAvatarAssetIndex(workspace)
  return index.assets
}

export async function getAvatarAsset(workspace: ProjectWorkspace, assetId: string) {
  const safeAssetId = assertSafeSegment(assetId, 'assetId')
  const index = await readAvatarAssetIndex(workspace)
  const asset = index.assets.find((item) => item.assetId === safeAssetId)
  if (!asset) {
    throw new AvatarAssetValidationError('missing_avatar_asset', '未找到数字人形象素材。')
  }
  if (asset.projectId !== workspace.projectId || asset.featureType !== workspace.featureType || asset.assetId !== safeAssetId) {
    throw new AvatarAssetValidationError('avatar_asset_identity_mismatch', '数字人形象素材不属于当前项目。')
  }
  return asset
}

export async function deleteAvatarAsset(workspace: ProjectWorkspace, assetId: string) {
  const asset = await getAvatarAsset(workspace, assetId)
  const safePath = assertInsideRoot(workspace.filesPath, asset.path)
  await fs.rm(safePath, { force: true })
  const index = await readAvatarAssetIndex(workspace)
  await writeAvatarAssetIndex(workspace, {
    version: 1,
    assets: index.assets.filter((item) => item.assetId !== asset.assetId),
  })
  return asset
}

function extensionFromFilename(filename: string): AvatarAssetExtension {
  const extension = path.extname(filename).replace('.', '').toLowerCase()
  if (extension === 'mp4' || extension === 'mov' || extension === 'webm') return extension
  return extension as AvatarAssetExtension
}

function resolveAvatarFilesPath(workspace: ProjectWorkspace) {
  return assertInsideRoot(workspace.filesPath, path.join(/*turbopackIgnore: true*/ workspace.filesPath, 'avatar'))
}

function resolveAvatarAssetIndexPath(workspace: ProjectWorkspace) {
  const avatarFilesPath = resolveAvatarFilesPath(workspace)
  return assertInsideRoot(avatarFilesPath, path.join(/*turbopackIgnore: true*/ avatarFilesPath, 'index.json'))
}

async function appendAvatarAsset(workspace: ProjectWorkspace, asset: AvatarAsset) {
  const index = await readAvatarAssetIndex(workspace)
  const nextAssets = [
    ...index.assets.filter((item) => item.assetId !== asset.assetId),
    asset,
  ]
  await writeAvatarAssetIndex(workspace, { version: 1, assets: nextAssets })
}

async function readAvatarAssetIndex(workspace: ProjectWorkspace): Promise<AvatarAssetIndexFile> {
  const indexPath = resolveAvatarAssetIndexPath(workspace)
  try {
    const raw = await fs.readFile(indexPath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<AvatarAssetIndexFile>
    if (parsed.version !== 1 || !Array.isArray(parsed.assets) || !parsed.assets.every(isAvatarAsset)) {
      throw new AvatarAssetValidationError('invalid_index', 'avatar asset index 格式无效')
    }
    for (const asset of parsed.assets) validateStoredAvatarAsset(workspace, asset)
    return { version: 1, assets: parsed.assets }
  } catch (error) {
    if (isMissingFile(error)) return { version: 1, assets: [] }
    throw error
  }
}

function validateStoredAvatarAsset(workspace: ProjectWorkspace, asset: AvatarAsset) {
  if (asset.projectId !== workspace.projectId || asset.featureType !== workspace.featureType) {
    throw new AvatarAssetValidationError('avatar_asset_identity_mismatch', '数字人形象素材不属于当前项目。')
  }
  let expectedPath: string
  let storedPath: string
  try {
    expectedPath = assertInsideRoot(workspace.filesPath, path.resolve(workspace.rootPath, asset.relativePath))
    storedPath = assertInsideRoot(workspace.filesPath, asset.path)
  } catch (error) {
    if (error instanceof WorkspaceGuardError) {
      throw new AvatarAssetValidationError('avatar_asset_path_escape', '数字人形象素材路径越过了当前项目目录。')
    }
    throw error
  }
  if (path.normalize(expectedPath) !== path.normalize(storedPath)) {
    throw new AvatarAssetValidationError('avatar_asset_path_mismatch', '数字人形象素材路径记录不一致。')
  }
}

function isAvatarAsset(value: unknown): value is AvatarAsset {
  if (!value || typeof value !== 'object') return false
  const asset = value as Partial<AvatarAsset>
  return asset.assetType === 'avatar' && typeof asset.assetId === 'string' &&
    typeof asset.projectId === 'string' && asset.featureType === 'digital-human' &&
    typeof asset.originalFilename === 'string' && typeof asset.contentType === 'string' &&
    typeof asset.relativePath === 'string' && typeof asset.path === 'string' &&
    typeof asset.size === 'number' && asset.size > 0 &&
    (asset.status === 'ready' || asset.status === 'failed') &&
    typeof asset.createdAt === 'string' && typeof asset.updatedAt === 'string'
}

async function writeAvatarAssetIndex(workspace: ProjectWorkspace, index: AvatarAssetIndexFile) {
  const indexPath = resolveAvatarAssetIndexPath(workspace)
  await fs.mkdir(path.dirname(indexPath), { recursive: true })
  const tempPath = `${indexPath}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(tempPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  await fs.rename(tempPath, indexPath)
}

function avatarUploadErrorMessage(code: RawMediaUploadError['code']) {
  if (code === 'file_too_large') return '数字人形象视频不能超过 300MB'
  if (code === 'empty_file' || code === 'missing_body') return '数字人形象视频不能为空'
  if (code === 'upload_aborted') return '数字人形象视频上传已取消'
  return '数字人形象视频上传内容长度不完整'
}

function normalizeRelativePath(value: string) {
  return value.split(path.sep).join('/')
}

function isMissingFile(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
