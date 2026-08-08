import { describe, expect, it, vi } from 'vitest'
import {
  readDesktopBackendSmokeConfig,
  runDesktopBackendSmoke,
} from './desktop-local-backend-smoke.mjs'

describe('desktop local backend smoke script', () => {
  it('is skipped unless explicitly enabled', async () => {
    const logger = { log: vi.fn(), error: vi.fn() }

    await expect(runDesktopBackendSmoke({ env: {}, logger })).resolves.toEqual({
      status: 'skipped',
      reason: 'disabled',
    })
    expect(logger.log).toHaveBeenCalledWith(
      'Desktop local backend smoke skipped. Set RUN_DESKTOP_BACKEND_SMOKE=1 to enable.',
    )
  })

  it('requires a backend URL when enabled', async () => {
    const logger = { log: vi.fn(), error: vi.fn() }

    await expect(
      runDesktopBackendSmoke({
        env: {
          RUN_DESKTOP_BACKEND_SMOKE: '1',
        },
        logger,
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      error: {
        code: 'desktop_backend_missing',
      },
    })
  })

  it('checks the desktop-runtime health endpoint', async () => {
    const logger = { log: vi.fn(), error: vi.fn() }
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: 'available',
          source: 'desktop_runtime',
          runtimeStatus: 'dev_server',
          capabilities: ['script_agent', 'audio_agent', 'digital_human', 'post_production', 'publish_agent'],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )

    await expect(
      runDesktopBackendSmoke({
        env: {
          RUN_DESKTOP_BACKEND_SMOKE: '1',
          DESKTOP_LOCAL_BACKEND_URL: ' http://127.0.0.1:3100/ ',
          DESKTOP_SMOKE_PROJECT_ID: 'demo project',
        },
        fetcher,
        logger,
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      runtimeStatus: 'dev_server',
      capabilities: ['script_agent', 'audio_agent', 'digital_human', 'post_production', 'publish_agent'],
    })
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:3100/api/projects/demo%20project/desktop-runtime',
      {
        method: 'GET',
        signal: expect.any(AbortSignal),
      },
    )
  })

  it('requires all production pipeline capabilities from the backend', async () => {
    const logger = { log: vi.fn(), error: vi.fn() }
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: 'available',
          source: 'desktop_runtime',
          runtimeStatus: 'dev_server',
          capabilities: ['script_agent'],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )

    await expect(
      runDesktopBackendSmoke({
        env: {
          RUN_DESKTOP_BACKEND_SMOKE: '1',
          DESKTOP_LOCAL_BACKEND_URL: 'http://127.0.0.1:3100',
        },
        fetcher,
        logger,
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      error: {
        code: 'desktop_backend_capability_missing',
      },
    })
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('audio_agent'))
  })

  it('normalizes smoke config', () => {
    expect(
      readDesktopBackendSmokeConfig({
        RUN_DESKTOP_BACKEND_SMOKE: '1',
        NEXT_PUBLIC_DESKTOP_LOCAL_BACKEND_URL: ' http://127.0.0.1:3100/ ',
        DESKTOP_LOCAL_BACKEND_TIMEOUT_MS: '7000',
      }),
    ).toEqual({
      enabled: true,
      backendUrl: 'http://127.0.0.1:3100',
      projectId: 'desktop-smoke',
      timeoutMs: 7000,
    })
  })
})
