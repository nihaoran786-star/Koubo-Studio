import { describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import {
  readDesktopReleaseSmokeConfig,
  runDesktopReleaseSmoke,
} from './desktop-release-smoke.mjs'

describe('desktop release smoke script', () => {
  it('is skipped unless explicitly enabled', async () => {
    const logger = { log: vi.fn(), error: vi.fn() }

    await expect(runDesktopReleaseSmoke({ env: {}, logger })).resolves.toEqual({
      status: 'skipped',
      reason: 'disabled',
    })
    expect(logger.log).toHaveBeenCalledWith(
      'Desktop release smoke skipped. Set RUN_DESKTOP_RELEASE_SMOKE=1 to enable.',
    )
  })

  it('requires a release exe when enabled', async () => {
    const logger = { log: vi.fn(), error: vi.fn() }

    await expect(
      runDesktopReleaseSmoke({
        env: {
          RUN_DESKTOP_RELEASE_SMOKE: '1',
          DESKTOP_RELEASE_EXE_PATH: 'C:/missing/koubo-agent.exe',
        },
        logger,
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      error: {
        code: 'desktop_release_exe_missing',
      },
    })
  })

  it('rejects an explicit desktop backend node path below Node 22.19', async () => {
    const logger = { log: vi.fn(), error: vi.fn() }
    const launcher = vi.fn()

    await expect(
      runDesktopReleaseSmoke({
        env: {
          RUN_DESKTOP_RELEASE_SMOKE: '1',
          DESKTOP_RELEASE_EXE_PATH: process.execPath,
          DESKTOP_BACKEND_NODE_PATH: process.execPath,
        },
        launcher,
        logger,
        getExecutableVersion: () => 'v20.20.0',
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      error: {
        code: 'desktop_backend_node_too_old',
      },
    })
    expect(launcher).not.toHaveBeenCalled()
  })

  it('launches release exe, checks runtime readiness, and cleans up process tree', async () => {
    const logger = { log: vi.fn(), error: vi.fn() }
    const launcher = vi.fn(() => ({ pid: 1234 }))
    const cleanup = vi.fn(async () => undefined)
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: 'available',
          source: 'desktop_runtime',
          runtimeStatus: 'local_backend_ready',
          capabilities: ['script_agent', 'audio_agent', 'digital_human', 'post_production', 'publish_agent'],
          requirements: [
            {
              id: 'node_runtime',
              capability: 'script_agent',
              status: 'ready',
              requiredVersion: '22.19.0',
              actualVersion: '24.14.0',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )

    await expect(
      runDesktopReleaseSmoke({
        env: {
          RUN_DESKTOP_RELEASE_SMOKE: '1',
          DESKTOP_RELEASE_EXE_PATH: process.execPath,
          DESKTOP_BACKEND_NODE_PATH: process.execPath,
          DESKTOP_RELEASE_BACKEND_URL: ' http://127.0.0.1:3100/ ',
          DESKTOP_RELEASE_SMOKE_PROJECT_ID: 'release demo',
        },
        fetcher,
        launcher,
        cleanup,
        getExecutableVersion: () => 'v24.14.0',
        logger,
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      runtimeStatus: 'local_backend_ready',
      nodeVersion: '24.14.0',
    })

    expect(launcher).toHaveBeenCalledWith(process.execPath, { backendPort: '3100' })
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:3100/api/projects/release%20demo/desktop-runtime',
      { method: 'GET' },
    )
    expect(cleanup).toHaveBeenCalledWith({ pid: 1234 })
  })

  it('fails release smoke when production pipeline capabilities are missing', async () => {
    const logger = { log: vi.fn(), error: vi.fn() }
    const launcher = vi.fn(() => ({ pid: 1234 }))
    const cleanup = vi.fn(async () => undefined)
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: 'available',
          source: 'desktop_runtime',
          runtimeStatus: 'local_backend_ready',
          capabilities: ['script_agent'],
          requirements: [
            {
              id: 'node_runtime',
              capability: 'script_agent',
              status: 'ready',
              requiredVersion: '22.19.0',
              actualVersion: '24.14.0',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )

    await expect(
      runDesktopReleaseSmoke({
        env: {
          RUN_DESKTOP_RELEASE_SMOKE: '1',
          DESKTOP_RELEASE_EXE_PATH: process.execPath,
          DESKTOP_BACKEND_NODE_PATH: process.execPath,
        },
        fetcher,
        launcher,
        cleanup,
        getExecutableVersion: () => 'v24.14.0',
        logger,
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      error: {
        code: 'desktop_release_capability_missing',
      },
    })
    expect(cleanup).toHaveBeenCalledWith({ pid: 1234 })
  })

  it('normalizes config', () => {
    expect(
      readDesktopReleaseSmokeConfig(
        {
          RUN_DESKTOP_RELEASE_SMOKE: '1',
          DESKTOP_RELEASE_EXE_PATH: ' C:/app/koubo-agent.exe ',
          DESKTOP_RELEASE_BACKEND_URL: ' http://127.0.0.1:3100/ ',
          DESKTOP_RELEASE_SMOKE_PROJECT_ID: 'demo',
          DESKTOP_RELEASE_SMOKE_TIMEOUT_MS: '1500',
          DESKTOP_RELEASE_SMOKE_INTERVAL_MS: '20',
        },
        'C:/repo',
      ),
    ).toEqual({
      enabled: true,
      exePath: 'C:/app/koubo-agent.exe',
      nodePath: '',
      backendUrl: 'http://127.0.0.1:3100',
      backendPort: '3100',
      projectId: 'demo',
      timeoutMs: 1500,
      intervalMs: 20,
    })
  })

  it('uses the configured Cargo .target release output by default', () => {
    expect(readDesktopReleaseSmokeConfig({ RUN_DESKTOP_RELEASE_SMOKE: '1' }, 'C:/repo').exePath)
      .toBe(path.join('C:/repo', 'src-tauri', '.target', 'release', 'koubo-agent.exe'))
  })
})
