import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  readProductionStandaloneUploadSmokeConfig,
  runProductionStandaloneUploadSmoke,
  sha256File,
  uploadAndVerify,
} from './production-standalone-upload-smoke.mjs'

describe('production standalone upload smoke', () => {
  it('defaults to a 12 MiB payload and requires a production standalone artifact', async () => {
    const root = path.join('C:', 'koubo')
    expect(readProductionStandaloneUploadSmokeConfig({}, root)).toMatchObject({
      root,
      sizeMiB: 12,
      sizeBytes: 12 * 1024 * 1024,
      serverPath: path.join(root, '.next', 'standalone', 'server.js'),
    })
    expect(() => readProductionStandaloneUploadSmokeConfig({ STANDALONE_UPLOAD_SMOKE_MIB: '10' }, root))
      .toThrow(/10 MiB/)
  })

  it.each([
    ['content-length', true],
    ['chunked', false],
  ])('streams and verifies %s uploads', async (mode, hasContentLength) => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'koubo-upload-unit-'))
    try {
      const sourcePath = path.join(tempRoot, 'source.mp4')
      const savedPath = path.join(tempRoot, 'saved.mp4')
      const bytes = Buffer.from('stream-integrity-check')
      await fs.writeFile(sourcePath, bytes)
      await fs.writeFile(savedPath, bytes)
      const expectedSha256 = await sha256File(sourcePath)
      const fetcher = vi.fn(async (_endpoint, init) => {
        await new Response(init.body).arrayBuffer()
        expect(init.headers['content-length']).toBe(hasContentLength ? String(bytes.length) : undefined)
        return Response.json({
          status: 'ok',
          asset: {
            assetId: `asset-${mode}`,
            path: savedPath,
            size: bytes.length,
          },
        })
      })

      await expect(uploadAndVerify({
        endpoint: 'http://127.0.0.1:3133/api/upload',
        filePath: sourcePath,
        expectedBytes: bytes.length,
        expectedSha256,
        mode,
        fetcher,
      })).resolves.toMatchObject({
        mode,
        status: 'ok',
        bytes: bytes.length,
        sha256: expectedSha256,
      })
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('rejects a truncated asset even when the API reports success', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'koubo-upload-unit-'))
    try {
      const sourcePath = path.join(tempRoot, 'source.mp4')
      const savedPath = path.join(tempRoot, 'saved.mp4')
      await fs.writeFile(sourcePath, 'complete-source')
      await fs.writeFile(savedPath, 'truncated')
      const expectedSha256 = await sha256File(sourcePath)

      await expect(uploadAndVerify({
        endpoint: 'http://127.0.0.1:3133/api/upload',
        filePath: sourcePath,
        expectedBytes: 15,
        expectedSha256,
        mode: 'chunked',
        fetcher: async (_endpoint, init) => {
          await new Response(init.body).arrayBuffer()
          return Response.json({
            status: 'ok',
            asset: { assetId: 'truncated', path: savedPath, size: 9 },
          })
        },
      })).rejects.toThrow(/asset\.size/)
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('always stops the server and removes isolated AppData on failure', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'koubo-upload-root-'))
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'koubo-upload-appdata-'))
    const serverPath = path.join(root, '.next', 'standalone', 'server.js')
    await fs.mkdir(path.dirname(serverPath), { recursive: true })
    await fs.writeFile(serverPath, '// fixture')
    const stopServer = vi.fn(async () => undefined)
    const removeTempRoot = vi.fn(async () => undefined)
    const logger = { log: vi.fn(), error: vi.fn() }

    try {
      const result = await runProductionStandaloneUploadSmoke({
        root,
        logger,
        createTempRoot: async () => tempRoot,
        removeTempRoot,
        reservePort: async () => 3133,
        launchServer: () => ({
          child: { exitCode: 1 },
          getOutput: () => 'fixture startup failed',
        }),
        stopServer,
      })

      expect(result).toMatchObject({
        status: 'failed',
        error: { code: 'standalone_upload_smoke_failed' },
      })
      expect(result.error.message).toContain('fixture startup failed')
      expect(stopServer).toHaveBeenCalledTimes(1)
      expect(removeTempRoot).toHaveBeenCalledWith(tempRoot)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('fails when strict cleanup cannot remove isolated AppData', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'koubo-upload-root-'))
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'koubo-upload-appdata-'))
    const serverPath = path.join(root, '.next', 'standalone', 'server.js')
    await fs.mkdir(path.dirname(serverPath), { recursive: true })
    await fs.writeFile(serverPath, '// fixture')

    try {
      const result = await runProductionStandaloneUploadSmoke({
        root,
        logger: { log: vi.fn(), error: vi.fn() },
        createTempRoot: async () => tempRoot,
        removeTempRoot: async () => { throw new Error('directory locked') },
        reservePort: async () => 3133,
        launchServer: () => ({ child: { exitCode: 1 } }),
        stopServer: async () => undefined,
      })

      expect(result).toMatchObject({
        status: 'failed',
        error: { code: 'standalone_upload_cleanup_failed' },
      })
      expect(result.error.message).toContain('directory locked')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })
})
