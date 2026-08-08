import fs from 'node:fs/promises'

export class RawMediaUploadError extends Error {
  constructor(
    public code: 'missing_body' | 'file_too_large' | 'empty_file' | 'upload_aborted' | 'size_mismatch',
    message: string,
  ) {
    super(message)
    this.name = 'RawMediaUploadError'
  }
}

export async function writeRawMediaUpload(input: {
  body: ReadableStream<Uint8Array> | null
  targetPath: string
  maxBytes: number
  expectedBytes?: number
  signal?: AbortSignal
}) {
  if (!input.body) throw new RawMediaUploadError('missing_body', '上传内容不能为空')
  if (input.expectedBytes !== undefined && input.expectedBytes > input.maxBytes) {
    throw new RawMediaUploadError('file_too_large', '上传文件超过大小限制')
  }

  const tempPath = `${input.targetPath}.${process.pid}.${crypto.randomUUID()}.upload`
  const reader = input.body.getReader()
  const abortRead = () => { void reader.cancel('upload aborted').catch(() => undefined) }
  let handle: fs.FileHandle | undefined
  let size = 0

  try {
    input.signal?.addEventListener('abort', abortRead, { once: true })
    handle = await fs.open(tempPath, 'wx')
    while (true) {
      if (input.signal?.aborted) throw new RawMediaUploadError('upload_aborted', '上传已取消')
      const { done, value } = await reader.read()
      if (input.signal?.aborted) throw new RawMediaUploadError('upload_aborted', '上传已取消')
      if (done) break
      if (!value?.byteLength) continue
      if (size + value.byteLength > input.maxBytes) {
        throw new RawMediaUploadError('file_too_large', '上传文件超过大小限制')
      }
      let offset = 0
      while (offset < value.byteLength) {
        const { bytesWritten } = await handle.write(value.subarray(offset))
        offset += bytesWritten
      }
      size += value.byteLength
    }
    if (size === 0) throw new RawMediaUploadError('empty_file', '上传文件不能为空')
    if (input.expectedBytes !== undefined && size !== input.expectedBytes) {
      throw new RawMediaUploadError('size_mismatch', '上传内容长度与声明不一致')
    }
    await handle.close()
    handle = undefined
    await fs.rename(tempPath, input.targetPath)
    return size
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await fs.rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  } finally {
    input.signal?.removeEventListener('abort', abortRead)
    reader.releaseLock()
  }
}

export function decodeUploadHeader(value: string | null, field: string) {
  if (!value) throw new RawMediaUploadError('missing_body', `${field} 不能为空`)
  try {
    const decoded = decodeURIComponent(value)
    if (!decoded || decoded.length > 512 || /[\u0000-\u001f]/.test(decoded)) throw new Error('invalid header')
    return decoded
  } catch {
    throw new RawMediaUploadError('missing_body', `${field} 无效`)
  }
}

export function parseContentLength(request: Request) {
  const value = request.headers.get('content-length')
  if (value === null) return undefined
  if (!/^\d+$/.test(value)) throw new RawMediaUploadError('size_mismatch', 'Content-Length 无效')
  const size = Number(value)
  if (!Number.isSafeInteger(size)) throw new RawMediaUploadError('size_mismatch', 'Content-Length 无效')
  return size
}

export function streamFromBytes(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}
