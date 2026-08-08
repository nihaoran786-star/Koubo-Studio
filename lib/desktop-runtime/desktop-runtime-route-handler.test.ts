import { describe, expect, it } from 'vitest'
import { handleDesktopRuntimeGet } from './desktop-runtime-route-handler'

describe('handleDesktopRuntimeGet', () => {
  it('returns health result with 200 when backend is available', async () => {
    const response = await handleDesktopRuntimeGet({
      projectId: 'project-001',
      runHealthCheck: async () => ({
        status: 'available',
        source: 'desktop_runtime',
        runtimeStatus: 'dev_server',
        capabilities: ['script_agent'],
        requirements: [],
      }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'available',
      source: 'desktop_runtime',
      runtimeStatus: 'dev_server',
    })
  })

  it('returns 503 when backend is missing', async () => {
    const response = await handleDesktopRuntimeGet({
      projectId: 'project-001',
      runHealthCheck: async () => ({
        status: 'unavailable',
        source: 'desktop_runtime',
        runtimeStatus: 'static_only',
        capabilities: [],
        requirements: [],
        error: {
          code: 'desktop_backend_missing',
          message: '桌面端生产包缺少本地后端。',
        },
      }),
    })

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      status: 'unavailable',
      error: {
        code: 'desktop_backend_missing',
      },
    })
  })
})
