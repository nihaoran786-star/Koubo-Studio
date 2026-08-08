import { describe, expect, it } from 'vitest'
import { handleManagedRuntimeGet, mapManagedRuntimeReport } from './managed-runtime-route-handler'
import type { ManagedRuntimeReport } from './managed-runtime-types'

describe('managed runtime route contract', () => {
  it('maps an operational report to the explicit desktop DTO', () => {
    expect(mapManagedRuntimeReport(report())).toEqual({
      status: 'ok',
      source: 'managed_wsl',
      runtime: {
        phase: 'ready',
        installed: true,
        running: true,
        healthy: true,
        version: '1.0.0',
        apiUrl: 'http://127.0.0.1:8383',
        detail: 'KouboRuntime 1.0.0 已就绪。',
      },
      actions: { canImport: false, canStart: false, canStop: true, canUninstall: true },
      error: null,
    })
  })

  it('turns only an infrastructure probe failure into HTTP 500', async () => {
    const response = await handleManagedRuntimeGet({
      inspect: async () => report({
        status: 'failed',
        error: { code: 'probe_failed', message: '无法读取 WSL 发行版列表。' },
      }),
    })
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      status: 'error',
      source: 'managed_wsl',
      error: { code: 'probe_failed', message: '无法读取 WSL 发行版列表。' },
    })
  })
})

function report(overrides: Partial<ManagedRuntimeReport> = {}): ManagedRuntimeReport {
  return {
    status: 'ready',
    source: 'managed_runtime_probe',
    checkedAt: '2026-07-17T00:00:00.000Z',
    runtime: {
      name: 'KouboRuntime',
      installed: true,
      distroState: 'running',
      wslVersion: 2,
      version: '1.0.0',
      apiUrl: 'http://127.0.0.1:8383',
      health: 'healthy',
    },
    actions: { canImport: false, canStart: false, canStop: true, canUninstall: true },
    error: null,
    ...overrides,
  }
}

