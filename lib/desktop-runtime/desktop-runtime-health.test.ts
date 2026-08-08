import { describe, expect, it, vi } from 'vitest'
import {
  buildRuntimeRequirements,
  desktopRuntimeEndpoint,
  detectDesktopRuntimeHealth,
  readDesktopRuntimeConfig,
} from './desktop-runtime-health'

describe('desktop runtime health', () => {
  it('builds the project desktop-runtime endpoint', () => {
    expect(desktopRuntimeEndpoint('project-001')).toBe('/api/projects/project-001/desktop-runtime')
  })

  it('reports dev server as available when static export is not enabled', async () => {
    await expect(
      detectDesktopRuntimeHealth({
        projectId: 'project-001',
        env: {},
      }),
    ).resolves.toMatchObject({
      status: 'available',
      source: 'desktop_runtime',
      runtimeStatus: 'dev_server',
      capabilities: ['script_agent', 'audio_agent', 'digital_human', 'post_production', 'publish_agent'],
      requirements: [
        {
          id: 'node_runtime',
          capability: 'script_agent',
        },
      ],
    })
  })

  it('marks script agent requirement blocked when Node is below the backend minimum', async () => {
    await expect(
      detectDesktopRuntimeHealth({
        projectId: 'project-001',
        env: {},
        nodeVersion: '20.20.0',
      }),
    ).resolves.toMatchObject({
      status: 'available',
      runtimeStatus: 'dev_server',
      requirements: [
        {
          id: 'node_runtime',
          capability: 'script_agent',
          status: 'blocked',
          requiredVersion: '22.19.0',
          actualVersion: '20.20.0',
          error: {
            code: 'unsupported_node_version',
          },
        },
      ],
    })
  })

  it('marks script agent requirement ready when Node satisfies the backend minimum', () => {
    expect(buildRuntimeRequirements('22.19.0')).toEqual([
      {
        id: 'node_runtime',
        capability: 'script_agent',
        status: 'ready',
        requiredVersion: '22.19.0',
        actualVersion: '22.19.0',
      },
    ])
  })

  it('reports static export without local backend as desktop_backend_missing', async () => {
    await expect(
      detectDesktopRuntimeHealth({
        projectId: 'project-001',
        env: {
          NEXT_DESKTOP_EXPORT: '1',
        },
      }),
    ).resolves.toMatchObject({
      status: 'unavailable',
      source: 'desktop_runtime',
      runtimeStatus: 'static_only',
      error: {
        code: 'desktop_backend_missing',
      },
    })
  })

  it('reports packaged sidecar backend as local_backend_ready without recursive self-check', async () => {
    const fetcher = vi.fn()

    await expect(
      detectDesktopRuntimeHealth({
        projectId: 'project-001',
        env: {
          DESKTOP_BACKEND_MODE: 'sidecar',
        },
        fetcher,
      }),
    ).resolves.toMatchObject({
      status: 'available',
      source: 'desktop_runtime',
      runtimeStatus: 'local_backend_ready',
      capabilities: ['script_agent', 'audio_agent', 'digital_human', 'post_production', 'publish_agent'],
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('checks configured local backend health endpoint', async () => {
    vi.stubEnv('NEXT_PUBLIC_DESKTOP_LOCAL_BACKEND_URL', 'http://static-shell.invalid')
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: 'ok',
          version: '0.1.0',
          requirements: [
            {
              id: 'node_runtime',
              capability: 'script_agent',
              status: 'ready',
              requiredVersion: '22.19.0',
              actualVersion: '22.19.0',
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
      detectDesktopRuntimeHealth({
        projectId: 'project-001',
        env: {
          NEXT_DESKTOP_EXPORT: '1',
          DESKTOP_LOCAL_BACKEND_URL: ' http://127.0.0.1:3100 ',
        },
        fetcher,
      }),
    ).resolves.toMatchObject({
      status: 'available',
      source: 'desktop_runtime',
      runtimeStatus: 'local_backend_ready',
      backendUrl: 'http://127.0.0.1:3100',
      version: '0.1.0',
      requirements: [
        {
          id: 'node_runtime',
          status: 'ready',
          actualVersion: '22.19.0',
        },
      ],
    })
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:3100/api/projects/project-001/desktop-runtime', {
      method: 'GET',
      signal: expect.any(AbortSignal),
    })
    vi.unstubAllEnvs()
  })

  it('reports configured local backend failures with a stable error code', async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ status: 'unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    )

    await expect(
      detectDesktopRuntimeHealth({
        projectId: 'project-001',
        env: {
          NEXT_DESKTOP_EXPORT: '1',
          DESKTOP_LOCAL_BACKEND_URL: 'http://127.0.0.1:3100',
        },
        fetcher,
      }),
    ).resolves.toMatchObject({
      status: 'unavailable',
      source: 'desktop_runtime',
      runtimeStatus: 'local_backend_failed',
      error: {
        code: 'desktop_backend_unreachable',
      },
    })
  })

  it('normalizes local backend config from environment variables', () => {
    expect(
      readDesktopRuntimeConfig({
        NEXT_DESKTOP_EXPORT: '1',
        DESKTOP_LOCAL_BACKEND_URL: ' http://127.0.0.1:3100/ ',
        DESKTOP_LOCAL_BACKEND_TIMEOUT_MS: '5000',
        DESKTOP_BACKEND_MODE: 'sidecar',
      }),
    ).toEqual({
      desktopExport: true,
      backendUrl: 'http://127.0.0.1:3100',
      backendMode: 'sidecar',
      timeoutMs: 5000,
    })
  })
})
