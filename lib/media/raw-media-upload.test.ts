import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RawMediaUploadError, writeRawMediaUpload } from './raw-media-upload'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('writeRawMediaUpload', () => {
  it('writes chunks through a temp file and atomically completes the target', async () => {
    const root = await createRoot()
    const targetPath = path.join(root, 'asset.bin')
    const size = await writeRawMediaUpload({
      body: chunkStream([new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])]),
      targetPath,
      maxBytes: 10,
      expectedBytes: 5,
    })

    expect(size).toBe(5)
    await expect(fs.readFile(targetPath)).resolves.toEqual(Buffer.from([1, 2, 3, 4, 5]))
    expect((await fs.readdir(root)).filter((name) => name.endsWith('.upload'))).toEqual([])
  })

  it('enforces the streaming limit and removes partial files', async () => {
    const root = await createRoot()
    const targetPath = path.join(root, 'asset.bin')
    await expect(writeRawMediaUpload({
      body: chunkStream([new Uint8Array([1, 2]), new Uint8Array([3, 4])]),
      targetPath,
      maxBytes: 3,
    })).rejects.toMatchObject({ code: 'file_too_large' } satisfies Partial<RawMediaUploadError>)

    await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readdir(root)).toEqual([])
  })

  it('cleans the temporary file when the request is aborted', async () => {
    const root = await createRoot()
    const targetPath = path.join(root, 'asset.bin')
    const controller = new AbortController()
    controller.abort()

    await expect(writeRawMediaUpload({
      body: chunkStream([new Uint8Array([1])]),
      targetPath,
      maxBytes: 3,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'upload_aborted' } satisfies Partial<RawMediaUploadError>)
    expect(await fs.readdir(root)).toEqual([])
  })

  it('rejects truncated bodies and removes the temporary file', async () => {
    const root = await createRoot()
    await expect(writeRawMediaUpload({
      body: chunkStream([new Uint8Array([1, 2])]),
      targetPath: path.join(root, 'asset.bin'),
      maxBytes: 10,
      expectedBytes: 3,
    })).rejects.toMatchObject({ code: 'size_mismatch' } satisfies Partial<RawMediaUploadError>)
    expect(await fs.readdir(root)).toEqual([])
  })
})

async function createRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'koubo-upload-'))
  roots.push(root)
  return root
}

function chunkStream(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}
