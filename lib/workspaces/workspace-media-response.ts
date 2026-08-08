import fs from 'node:fs/promises'
import { Readable } from 'node:stream'
import { assertInsideRoot } from './workspace-guard'

export type WorkspaceMediaResponseOptions = {
  rootPath: string
  filePath: string
  contentType: string
  rangeHeader?: string
  rangeEnabled?: boolean
  acceptRanges?: boolean
}

export class WorkspaceMediaResponseError extends Error {
  constructor(
    public readonly code: 'file_not_found' | 'not_a_file' | 'invalid_range',
    message: string,
  ) {
    super(message)
    this.name = 'WorkspaceMediaResponseError'
  }
}

/**
 * Streams a workspace-owned media file without materialising it in the Node heap.
 * Path containment and byte-range semantics live here so file routes cannot drift.
 */
export async function createWorkspaceMediaResponse(options: WorkspaceMediaResponseOptions): Promise<Response> {
  const safePath = assertInsideRoot(options.rootPath, options.filePath)
  const realRoot = await realPathOrClassify(options.rootPath)
  const finalLink = await lstatOrClassify(safePath)
  if (finalLink.isSymbolicLink()) {
    throw new WorkspaceMediaResponseError('not_a_file', '媒体路径不能是符号链接。')
  }

  const handle = await openMediaFile(safePath)
  try {
    // Resolve after opening: a parent junction changed before open is rejected,
    // while later path replacement cannot change the already-open handle.
    const realPath = await realPathOrClassify(safePath)
    assertInsideRoot(realRoot, realPath)
    const stat = await handle.stat()
    if (!stat.isFile()) throw new WorkspaceMediaResponseError('not_a_file', '媒体路径不是文件。')

    const range = options.rangeEnabled ? parseByteRange(options.rangeHeader, stat.size) : undefined
    const start = range?.start
    const end = range?.end
    const contentLength = range ? end! - start! + 1 : stat.size
    const nodeStream = handle.createReadStream({
      ...(range ? { start, end } : {}),
      autoClose: true,
    })
    const body = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>

    return new Response(body, {
      status: range ? 206 : 200,
      headers: {
        'content-type': options.contentType,
        'content-length': String(contentLength),
        ...(options.acceptRanges ? { 'accept-ranges': 'bytes' } : {}),
        ...(range ? { 'content-range': `bytes ${start}-${end}/${stat.size}` } : {}),
      },
    })
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

async function openMediaFile(filePath: string) {
  try {
    return await fs.open(filePath, 'r')
  } catch (error) {
    if (error instanceof WorkspaceMediaResponseError) throw error
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new WorkspaceMediaResponseError('file_not_found', '媒体文件不存在。')
    }
    throw error
  }
}

async function lstatOrClassify(filePath: string) {
  try {
    return await fs.lstat(filePath)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new WorkspaceMediaResponseError('file_not_found', '媒体文件不存在。')
    }
    throw error
  }
}

async function realPathOrClassify(filePath: string) {
  try {
    return await fs.realpath(filePath)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new WorkspaceMediaResponseError('file_not_found', '媒体文件不存在。')
    }
    throw error
  }
}

function parseByteRange(header: string | undefined, size: number) {
  if (!header) return undefined
  const match = /^bytes=(\d+)-(\d*)$/i.exec(header.trim())
  if (!match) throw invalidRange('媒体 Range 请求无效。')

  const start = Number(match[1])
  const requestedEnd = match[2] ? Number(match[2]) : size - 1
  const end = Math.min(requestedEnd, size - 1)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) {
    throw invalidRange('媒体 Range 超出文件范围。')
  }
  return { start, end }
}

function invalidRange(message: string) {
  return new WorkspaceMediaResponseError('invalid_range', message)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
