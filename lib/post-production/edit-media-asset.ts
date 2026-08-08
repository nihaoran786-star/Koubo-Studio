import fs from 'node:fs/promises'
import path from 'node:path'
import type { ProjectWorkspace } from '@/lib/workspaces/workspace-types'
import { assertInsideRoot, assertSafeSegment } from '@/lib/workspaces/workspace-guard'
import { RawMediaUploadError, streamFromBytes, writeRawMediaUpload } from '@/lib/media/raw-media-upload'

export type EditMediaAssetKind = 'background_music' | 'intro' | 'outro'

export interface EditMediaAsset {
  assetId: string
  assetType: 'edit_media'
  projectId: string
  kind: EditMediaAssetKind
  name: string
  originalFilename: string
  contentType: string
  relativePath: string
  path: string
  size: number
  status: 'ready'
  createdAt: string
  updatedAt: string
}

interface EditMediaAssetIndex { version: 1; assets: EditMediaAsset[] }

const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'aac'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm'])
const MAX_SIZE = 500 * 1024 * 1024

export class EditMediaAssetError extends Error {
  source = 'edit_media_asset' as const
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'EditMediaAssetError'
  }
}

export function parseEditMediaAssetKind(value: unknown): EditMediaAssetKind {
  if (value === 'background_music' || value === 'intro' || value === 'outro') return value
  throw new EditMediaAssetError('invalid_kind', '素材类型只能是背景音乐、片头或片尾。')
}

export function validateEditMediaAsset(input: { kind: EditMediaAssetKind; filename: string; size: number }) {
  const extension = path.extname(input.filename).slice(1).toLowerCase()
  const valid = input.kind === 'background_music' ? AUDIO_EXTENSIONS.has(extension) : VIDEO_EXTENSIONS.has(extension)
  if (!valid) {
    throw new EditMediaAssetError(
      'unsupported_file_type',
      input.kind === 'background_music' ? '背景音乐仅支持 mp3、wav、m4a、aac。' : '片头片尾仅支持 mp4、mov、webm。',
    )
  }
  if (input.size <= 0) throw new EditMediaAssetError('empty_file', '素材文件不能为空。')
  if (input.size > MAX_SIZE) throw new EditMediaAssetError('file_too_large', '素材文件不能超过 500MB。')
  return extension
}

export async function saveEditMediaAsset(input: {
  workspace: ProjectWorkspace
  kind: EditMediaAssetKind
  name?: string
  originalFilename: string
  contentType: string
  bytes: Uint8Array
  now?: string
}) {
  return saveEditMediaAssetStream({
    ...input,
    body: streamFromBytes(input.bytes),
    expectedBytes: input.bytes.byteLength,
  })
}

export async function saveEditMediaAssetStream(input: {
  workspace: ProjectWorkspace
  kind: EditMediaAssetKind
  name?: string
  originalFilename: string
  contentType: string
  body: ReadableStream<Uint8Array> | null
  expectedBytes?: number
  signal?: AbortSignal
  now?: string
}) {
  const extension = validateEditMediaAsset({ kind: input.kind, filename: input.originalFilename, size: input.expectedBytes ?? 1 })
  const now = input.now ?? new Date().toISOString()
  const assetId = assertSafeSegment(`${kindPrefix(input.kind)}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`, 'assetId')
  const root = resolveEditMediaRoot(input.workspace)
  const assetPath = assertInsideRoot(root, path.join(/*turbopackIgnore: true*/ root, `${assetId}.${extension}`))
  const asset: EditMediaAsset = {
    assetId,
    assetType: 'edit_media',
    projectId: input.workspace.projectId,
    kind: input.kind,
    name: sanitizeName(input.name) || path.basename(input.originalFilename, path.extname(input.originalFilename)),
    originalFilename: input.originalFilename,
    contentType: input.contentType,
    relativePath: path.relative(input.workspace.rootPath, assetPath).split(path.sep).join('/'),
    path: assetPath,
    size: 0,
    status: 'ready',
    createdAt: now,
    updatedAt: now,
  }
  await fs.mkdir(root, { recursive: true })
  try {
    asset.size = await writeRawMediaUpload({
      body: input.body,
      targetPath: assetPath,
      maxBytes: MAX_SIZE,
      expectedBytes: input.expectedBytes,
      signal: input.signal,
    })
    validateEditMediaAsset({ kind: input.kind, filename: input.originalFilename, size: asset.size })
    const index = await readIndex(input.workspace)
    await writeIndex(input.workspace, { version: 1, assets: [...index.assets, asset] })
  } catch (error) {
    await fs.rm(assetPath, { force: true }).catch(() => undefined)
    if (error instanceof RawMediaUploadError) {
      throw new EditMediaAssetError(error.code, editMediaUploadErrorMessage(error.code))
    }
    throw error
  }
  return asset
}

export async function listEditMediaAssets(workspace: ProjectWorkspace, kind?: EditMediaAssetKind) {
  const index = await readIndex(workspace)
  return kind ? index.assets.filter((asset) => asset.kind === kind) : index.assets
}

export async function getEditMediaAsset(workspace: ProjectWorkspace, assetId: string) {
  const safeId = assertSafeSegment(assetId, 'assetId')
  const asset = (await readIndex(workspace)).assets.find((item) => item.assetId === safeId)
  if (!asset) throw new EditMediaAssetError('asset_not_found', '剪辑素材不存在。')
  return asset
}

export async function deleteEditMediaAsset(workspace: ProjectWorkspace, assetId: string) {
  const asset = await getEditMediaAsset(workspace, assetId)
  await fs.rm(assertInsideRoot(resolveEditMediaRoot(workspace), asset.path), { force: true })
  const index = await readIndex(workspace)
  await writeIndex(workspace, { version: 1, assets: index.assets.filter((item) => item.assetId !== asset.assetId) })
  return asset
}

function resolveEditMediaRoot(workspace: ProjectWorkspace) {
  return assertInsideRoot(workspace.filesPath, path.join(/*turbopackIgnore: true*/ workspace.filesPath, 'edit-media'))
}

function indexPath(workspace: ProjectWorkspace) {
  const root = resolveEditMediaRoot(workspace)
  return assertInsideRoot(root, path.join(/*turbopackIgnore: true*/ root, 'index.json'))
}

async function readIndex(workspace: ProjectWorkspace): Promise<EditMediaAssetIndex> {
  try {
    const parsed = JSON.parse(await fs.readFile(indexPath(workspace), 'utf8')) as Partial<EditMediaAssetIndex>
    if (parsed.version !== 1 || !Array.isArray(parsed.assets)) throw new EditMediaAssetError('invalid_index', '剪辑素材索引损坏。')
    return { version: 1, assets: parsed.assets }
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT') return { version: 1, assets: [] }
    throw error
  }
}

async function writeIndex(workspace: ProjectWorkspace, index: EditMediaAssetIndex) {
  const target = indexPath(workspace)
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.tmp`
  await fs.writeFile(temp, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  await fs.rename(temp, target)
}

function kindPrefix(kind: EditMediaAssetKind) {
  if (kind === 'background_music') return 'bgm'
  return kind
}

function sanitizeName(value?: string) {
  return value?.trim().replace(/[\u0000-\u001f]/g, '').slice(0, 80) ?? ''
}

function editMediaUploadErrorMessage(code: RawMediaUploadError['code']) {
  if (code === 'file_too_large') return '素材文件不能超过 500MB。'
  if (code === 'empty_file' || code === 'missing_body') return '素材文件不能为空。'
  if (code === 'upload_aborted') return '素材上传已取消。'
  return '素材上传内容长度不完整。'
}
