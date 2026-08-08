import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertOfficialReleaseUrl,
  cleanupVersionTemporaryFiles,
  downloadOpenChatCutInstaller,
  inspectOpenChatCutRuntime,
  launchOpenChatCut,
  OPENCHATCUT_INSTALLER_NAME,
  OPENCHATCUT_INSTALLER_SHA256,
  OPENCHATCUT_INSTALLER_URL,
} from './runtime-adapter'
import { readOpenChatCutSettings, writeOpenChatCutSettings } from './settings-store'

describe('OpenChatCut runtime adapter', () => {
  let root = ''

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchatcut-runtime-'))
    vi.stubEnv('KOUBO_APP_DATA_ROOT', root)
    vi.stubEnv('NODE_ENV', 'test')
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('accepts only the pinned official release files', () => {
    expect(() => assertOfficialReleaseUrl(OPENCHATCUT_INSTALLER_URL)).not.toThrow()
    expect(() => assertOfficialReleaseUrl('https://evil.example/OpenChatCut.exe')).toThrow()
    expect(() => assertOfficialReleaseUrl('https://github.com/0xsline/OpenChatCut/releases/download/v0.1.6/other.exe')).toThrow()
  })

  it('removes the temporary installer when the pinned digest does not match', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('not-the-official-installer'))
    await expect(downloadOpenChatCutInstaller(fetcher as typeof fetch)).resolves.toMatchObject({
      status: 'error',
      error: { code: 'checksum_mismatch' },
    })
    const downloadRoot = path.join(root, 'runtimes', 'openchatcut', 'v0.1.6')
    await expect(fs.readdir(downloadRoot)).resolves.toEqual([])
  })

  it('cleans leftovers for the current version before reuse', async () => {
    const downloadRoot = path.join(root, 'runtimes', 'openchatcut', 'v0.1.6')
    await fs.mkdir(downloadRoot, { recursive: true })
    await fs.writeFile(path.join(downloadRoot, `.${OPENCHATCUT_INSTALLER_NAME}.old.tmp`), 'partial')
    await fs.writeFile(path.join(downloadRoot, 'keep.txt'), 'keep')
    await cleanupVersionTemporaryFiles(downloadRoot)
    await expect(fs.readdir(downloadRoot)).resolves.toEqual(['keep.txt'])
  })

  it('re-hashes the installer immediately before launch', async () => {
    const downloadRoot = path.join(root, 'runtimes', 'openchatcut', 'v0.1.6')
    await fs.mkdir(downloadRoot, { recursive: true })
    const installer = path.join(downloadRoot, OPENCHATCUT_INSTALLER_NAME)
    await fs.writeFile(installer, 'tampered installer')
    await expect(launchOpenChatCut('installer')).resolves.toMatchObject({
      status: 'error',
      error: { code: 'checksum_mismatch' },
    })
    await expect(fs.stat(installer)).rejects.toThrow()
  })

  it('aborts a download with a stable error when no bytes arrive', async () => {
    vi.useFakeTimers()
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      markStarted?.()
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    })
    const result = downloadOpenChatCutInstaller(fetcher as typeof fetch)
    await started
    await vi.advanceTimersByTimeAsync(15_001)
    await expect(result).resolves.toMatchObject({
      status: 'error',
      error: { code: 'download_stalled' },
    })
  })

  it('shows an active re-download before an incomplete install and then preserves the real download error', async () => {
    const executable = await createInstalledFixture(root, { complete: false })
    vi.stubEnv('KOUBO_OPENCHATCUT_EXE', executable)
    let resolveDownload!: (response: Response) => void
    const downloadFetcher = vi.fn(() => new Promise<Response>((resolve) => {
      resolveDownload = resolve
    }))
    const offlineProbe = vi.fn(async () => new Response('offline', { status: 503 })) as typeof fetch

    const download = downloadOpenChatCutInstaller(downloadFetcher as typeof fetch)
    await vi.waitFor(() => expect(downloadFetcher).toHaveBeenCalledTimes(1))
    const downloading = await inspectOpenChatCutRuntime(offlineProbe)
    expect(downloading).toMatchObject({ phase: 'downloading' })
    expect(downloading).not.toHaveProperty('error')

    resolveDownload(new Response('upstream failed', { status: 503 }))
    await expect(download).resolves.toMatchObject({
      status: 'error',
      error: { code: 'installer_download_failed' },
    })
    await expect(inspectOpenChatCutRuntime(offlineProbe)).resolves.toMatchObject({
      phase: 'failed',
      error: { code: 'installer_download_failed' },
    })
  })

  it('isolates download failures by runtime data root', async () => {
    const firstExecutable = await createInstalledFixture(root, { complete: false })
    vi.stubEnv('KOUBO_OPENCHATCUT_EXE', firstExecutable)
    await expect(downloadOpenChatCutInstaller(
      vi.fn(async () => new Response('upstream failed', { status: 503 })) as typeof fetch,
    )).resolves.toMatchObject({
      status: 'error',
      error: { code: 'installer_download_failed' },
    })

    const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openchatcut-runtime-other-'))
    try {
      const secondExecutable = await createInstalledFixture(secondRoot, { complete: false })
      vi.stubEnv('KOUBO_APP_DATA_ROOT', secondRoot)
      vi.stubEnv('KOUBO_OPENCHATCUT_EXE', secondExecutable)
      await expect(inspectOpenChatCutRuntime(
        vi.fn(async () => new Response('offline', { status: 503 })) as typeof fetch,
      )).resolves.toMatchObject({
        phase: 'failed',
        error: { code: 'install_incomplete' },
      })
    } finally {
      await fs.rm(secondRoot, { recursive: true, force: true })
    }
  })

  it('uses the configured token for MCP inspection and classifies 401', async () => {
    await writeOpenChatCutSettings({ version: 2, bearerToken: 'configured-token' })
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer configured-token')
      return new Response('denied', { status: 401 })
    })
    await expect(inspectOpenChatCutRuntime(fetcher as typeof fetch)).resolves.toMatchObject({
      phase: 'failed',
      error: { code: 'auth_error' },
    })
  })

  it('reports an inactive incomplete installation as repairable failure and refuses to launch it', async () => {
    const executable = await createInstalledFixture(root, { complete: false })
    vi.stubEnv('KOUBO_OPENCHATCUT_EXE', executable)
    const fetcher = vi.fn(async () => new Response('offline', { status: 503 }))

    await expect(inspectOpenChatCutRuntime(fetcher as typeof fetch)).resolves.toMatchObject({
      phase: 'failed',
      installed: false,
      mcpReady: false,
      error: { code: 'install_incomplete' },
    })
    await expect(launchOpenChatCut('app')).resolves.toMatchObject({
      status: 'error',
      error: { code: 'install_incomplete' },
    })
  })

  it('reports installing until the visible installer exits', async () => {
    const downloadRoot = path.join(root, 'runtimes', 'openchatcut', 'v0.1.6')
    await fs.mkdir(downloadRoot, { recursive: true })
    await fs.writeFile(path.join(downloadRoot, OPENCHATCUT_INSTALLER_NAME), 'fixture')
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit('spawn'))
      return child
    }) as unknown as typeof spawn

    await expect(launchOpenChatCut('installer', {
      spawnProcess,
      hash: async () => OPENCHATCUT_INSTALLER_SHA256,
    })).resolves.toMatchObject({ status: 'ok' })
    await expect(inspectOpenChatCutRuntime(vi.fn(async () =>
      new Response('offline', { status: 503 })) as typeof fetch)).resolves.toMatchObject({
      phase: 'installing',
    })
    child.emit('exit', 0)
  })

  it('offers the verified cached installer when an inactive installation is incomplete', async () => {
    const executable = await createInstalledFixture(root, { complete: false })
    vi.stubEnv('KOUBO_OPENCHATCUT_EXE', executable)
    const downloadRoot = path.join(root, 'runtimes', 'openchatcut', 'v0.1.6')
    await fs.mkdir(downloadRoot, { recursive: true })
    await fs.writeFile(path.join(downloadRoot, OPENCHATCUT_INSTALLER_NAME), 'fixture')

    await expect(inspectOpenChatCutRuntime(
      vi.fn(async () => new Response('offline', { status: 503 })) as typeof fetch,
      { hash: async () => OPENCHATCUT_INSTALLER_SHA256 },
    )).resolves.toMatchObject({
      phase: 'failed',
      installerReady: true,
      error: { code: 'install_incomplete' },
    })
  })

  it('does not re-hash an unchanged installer during repeated inspection', async () => {
    const downloadRoot = path.join(root, 'runtimes', 'openchatcut', 'v0.1.6')
    await fs.mkdir(downloadRoot, { recursive: true })
    const installer = path.join(downloadRoot, OPENCHATCUT_INSTALLER_NAME)
    await fs.writeFile(installer, 'fixture')
    const hash = vi.fn(async () => OPENCHATCUT_INSTALLER_SHA256)
    const fetcher = vi.fn(async () => new Response('offline', { status: 503 })) as typeof fetch

    await inspectOpenChatCutRuntime(fetcher, { hash })
    await inspectOpenChatCutRuntime(fetcher, { hash })
    expect(hash).toHaveBeenCalledTimes(1)

    await fs.appendFile(installer, '-changed')
    await inspectOpenChatCutRuntime(fetcher, { hash })
    expect(hash).toHaveBeenCalledTimes(2)
  })

  it('single-flights concurrent installer digest checks for the same file identity', async () => {
    const downloadRoot = path.join(root, 'runtimes', 'openchatcut', 'v0.1.6')
    await fs.mkdir(downloadRoot, { recursive: true })
    await fs.writeFile(path.join(downloadRoot, OPENCHATCUT_INSTALLER_NAME), 'fixture')
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const hash = vi.fn(async () => {
      await blocked
      return OPENCHATCUT_INSTALLER_SHA256
    })
    const fetcher = vi.fn(async () => new Response('offline', { status: 503 })) as typeof fetch

    const first = inspectOpenChatCutRuntime(fetcher, { hash })
    const second = inspectOpenChatCutRuntime(fetcher, { hash })
    await vi.waitFor(() => expect(hash).toHaveBeenCalledTimes(1))
    release()
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(hash).toHaveBeenCalledTimes(1)
  })

  it('waits for installer spawn confirmation and classifies asynchronous launch errors', async () => {
    const downloadRoot = path.join(root, 'runtimes', 'openchatcut', 'v0.1.6')
    await fs.mkdir(downloadRoot, { recursive: true })
    await fs.writeFile(path.join(downloadRoot, OPENCHATCUT_INSTALLER_NAME), 'fixture')
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit('error', new Error('spawn failed')))
      return child
    }) as unknown as typeof spawn

    await expect(launchOpenChatCut('installer', {
      spawnProcess,
      hash: async () => OPENCHATCUT_INSTALLER_SHA256,
    })).resolves.toMatchObject({
      status: 'error',
      error: { code: 'launch_failed' },
    })
    await expect(inspectOpenChatCutRuntime(
      vi.fn(async () => new Response('offline', { status: 503 })) as typeof fetch,
      { hash: async () => OPENCHATCUT_INSTALLER_SHA256 },
    )).resolves.not.toMatchObject({ phase: 'installing' })
  })

  it('confirms app spawn before success and consumes late process errors until close', async () => {
    const executable = await createInstalledFixture(root, { complete: true })
    vi.stubEnv('KOUBO_OPENCHATCUT_EXE', executable)
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn

    const launching = launchOpenChatCut('app', { spawnProcess })
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1))
    expect(child.unref).not.toHaveBeenCalled()

    child.emit('spawn')
    await expect(launching).resolves.toMatchObject({ status: 'ok' })
    expect(child.unref).toHaveBeenCalledTimes(1)
    expect(child.listenerCount('error')).toBe(1)
    expect(() => child.emit('error', new Error('late process error'))).not.toThrow()
    expect(child.listenerCount('error')).toBe(1)

    child.emit('close', 0)
    expect(child.listenerCount('error')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
  })

  it('creates, persists, and injects a secret token when launching without one', async () => {
    const executable = await createInstalledFixture(root, { complete: true })
    vi.stubEnv('KOUBO_OPENCHATCUT_EXE', executable)
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    let spawnedEnv: NodeJS.ProcessEnv | undefined
    const spawnSpy = vi.fn((_command: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      spawnedEnv = options.env
      queueMicrotask(() => child.emit('spawn'))
      return child
    })

    const result = await launchOpenChatCut('app', { spawnProcess: spawnSpy as unknown as typeof spawn })
    const persisted = await readOpenChatCutSettings()
    const injected = spawnedEnv?.OPENCHATCUT_MCP_TOKEN

    expect(result).toEqual({ status: 'ok', source: 'openchatcut' })
    expect(persisted.bearerToken).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(injected).toBe(persisted.bearerToken)
    expect(JSON.stringify(result)).not.toContain(persisted.bearerToken)
  })

  it('reuses the persisted secret token when launching again', async () => {
    const executable = await createInstalledFixture(root, { complete: true })
    vi.stubEnv('KOUBO_OPENCHATCUT_EXE', executable)
    await writeOpenChatCutSettings({ version: 2, bearerToken: 'persisted-secret-token' })
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    let spawnedEnv: NodeJS.ProcessEnv | undefined
    const spawnSpy = vi.fn((_command: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      spawnedEnv = options.env
      queueMicrotask(() => child.emit('spawn'))
      return child
    })

    const result = await launchOpenChatCut('app', { spawnProcess: spawnSpy as unknown as typeof spawn })
    const persisted = await readOpenChatCutSettings()
    const injected = spawnedEnv?.OPENCHATCUT_MCP_TOKEN

    expect(result).toEqual({ status: 'ok', source: 'openchatcut' })
    expect(persisted.bearerToken).toBe('persisted-secret-token')
    expect(injected).toBe('persisted-secret-token')
    expect(JSON.stringify(result)).not.toContain('persisted-secret-token')
  })

  it('classifies an asynchronous app spawn error and cleans its guard on close', async () => {
    const executable = await createInstalledFixture(root, { complete: true })
    vi.stubEnv('KOUBO_OPENCHATCUT_EXE', executable)
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit('error', new Error('spawn failed')))
      return child
    }) as unknown as typeof spawn

    await expect(launchOpenChatCut('app', { spawnProcess })).resolves.toMatchObject({
      status: 'error',
      error: { code: 'launch_failed' },
    })
    expect(child.unref).not.toHaveBeenCalled()
    expect(child.listenerCount('error')).toBe(1)
    child.emit('close', 1)
    expect(child.listenerCount('error')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
  })

  it('classifies an MCP process without the persisted managed CDP page as an external instance', async () => {
    const executable = await createInstalledFixture(root, { complete: true })
    vi.stubEnv('KOUBO_OPENCHATCUT_EXE', executable)
    await writeOpenChatCutSettings({ version: 2, cdpPort: 43111 })
    const fetcher = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request)
      if (url.endsWith('/api/external-mcp/mcp')) {
        return new Response('{}', { status: 200, headers: { 'mcp-session-id': 'session' } })
      }
      if (url.endsWith('/json/version')) {
        return Response.json({ webSocketDebuggerUrl: 'ws://127.0.0.1:43111/devtools/browser/id' })
      }
      return Response.json([])
    })

    await expect(inspectOpenChatCutRuntime(fetcher as typeof fetch)).resolves.toMatchObject({
      phase: 'external_instance',
      installed: true,
      mcpReady: false,
      error: { code: 'external_instance' },
    })
  })

  it('reports ready only when MCP and the persisted loopback OpenChatCut page belong to the managed instance', async () => {
    const executable = await createInstalledFixture(root, { complete: true })
    vi.stubEnv('KOUBO_OPENCHATCUT_EXE', executable)
    await writeOpenChatCutSettings({ version: 2, cdpPort: 43112 })
    const fetcher = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request)
      if (url.endsWith('/api/external-mcp/mcp')) {
        return new Response('{}', { status: 200, headers: { 'mcp-session-id': 'session' } })
      }
      if (url.endsWith('/json/version')) {
        return Response.json({ webSocketDebuggerUrl: 'ws://127.0.0.1:43112/devtools/browser/id' })
      }
      return Response.json([{
        type: 'page',
        title: 'OpenChatCut',
        url: 'http://127.0.0.1:54892/',
        webSocketDebuggerUrl: 'ws://127.0.0.1:43112/devtools/page/id',
      }])
    })

    await expect(inspectOpenChatCutRuntime(fetcher as typeof fetch)).resolves.toMatchObject({
      phase: 'mcp_ready',
      installed: true,
      mcpReady: true,
    })
  })

  it('reports launching when the persisted managed page exists before MCP is ready', async () => {
    const executable = await createInstalledFixture(root, { complete: true })
    vi.stubEnv('KOUBO_OPENCHATCUT_EXE', executable)
    await writeOpenChatCutSettings({ version: 2, cdpPort: 43114 })
    const fetcher = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request)
      if (url.endsWith('/api/external-mcp/mcp')) return new Response('offline', { status: 503 })
      if (url.endsWith('/json/version')) {
        return Response.json({ webSocketDebuggerUrl: 'ws://127.0.0.1:43114/devtools/browser/id' })
      }
      return Response.json([{
        type: 'page',
        title: 'OpenChatCut',
        url: 'http://127.0.0.1:54892/',
        webSocketDebuggerUrl: 'ws://127.0.0.1:43114/devtools/page/id',
      }])
    })

    await expect(inspectOpenChatCutRuntime(fetcher as typeof fetch)).resolves.toMatchObject({
      phase: 'launching',
      installed: true,
      mcpReady: false,
    })
  })

  it('rejects an OpenChatCut page websocket using a different CDP port', async () => {
    const executable = await createInstalledFixture(root, { complete: true })
    vi.stubEnv('KOUBO_OPENCHATCUT_EXE', executable)
    await writeOpenChatCutSettings({ version: 2, cdpPort: 43115 })
    const fetcher = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request)
      if (url.endsWith('/api/external-mcp/mcp')) {
        return new Response('{}', { status: 200, headers: { 'mcp-session-id': 'session' } })
      }
      if (url.endsWith('/json/version')) {
        return Response.json({ webSocketDebuggerUrl: 'ws://127.0.0.1:43115/devtools/browser/id' })
      }
      return Response.json([{
        type: 'page',
        title: 'OpenChatCut',
        url: 'http://127.0.0.1:54892/',
        webSocketDebuggerUrl: 'ws://127.0.0.1:43116/devtools/page/id',
      }])
    })

    await expect(inspectOpenChatCutRuntime(fetcher as typeof fetch)).resolves.toMatchObject({
      phase: 'external_instance',
      mcpReady: false,
    })
  })

  it('rejects a non-loopback DevTools websocket even when the requested CDP port responds', async () => {
    const executable = await createInstalledFixture(root, { complete: true })
    vi.stubEnv('KOUBO_OPENCHATCUT_EXE', executable)
    await writeOpenChatCutSettings({ version: 2, cdpPort: 43113 })
    const fetcher = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request)
      if (url.endsWith('/api/external-mcp/mcp')) {
        return new Response('{}', { status: 200, headers: { 'mcp-session-id': 'session' } })
      }
      if (url.endsWith('/json/version')) {
        return Response.json({ webSocketDebuggerUrl: 'ws://evil.example:43113/devtools/browser/id' })
      }
      return Response.json([{
        type: 'page',
        title: 'OpenChatCut',
        url: 'http://127.0.0.1:54892/',
      }])
    })

    await expect(inspectOpenChatCutRuntime(fetcher as typeof fetch)).resolves.toMatchObject({
      phase: 'external_instance',
      mcpReady: false,
    })
  })
})

async function createInstalledFixture(root: string, options: { complete: boolean }) {
  const installationRoot = path.join(root, 'OpenChatCut')
  const executable = path.join(installationRoot, 'OpenChatCut.exe')
  await fs.mkdir(installationRoot, { recursive: true })
  await fs.writeFile(executable, 'exe')
  if (options.complete) {
    const required = [
      'resources/app/package.json',
      'resources/app/desktop-dist/main.mjs',
      'resources/app/node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-compat.js',
      'resources/app/node_modules/zod/v3/index.js',
      'resources/app/node_modules/zod/v4-mini/index.js',
    ]
    await Promise.all(required.map(async (relative) => {
      const target = path.join(installationRoot, ...relative.split('/'))
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, relative.endsWith('package.json') ? '{"name":"openchatcut"}' : 'export {}')
    }))
  }
  return executable
}
