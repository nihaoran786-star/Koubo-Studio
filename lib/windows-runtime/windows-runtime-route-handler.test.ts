import { describe, expect, it } from 'vitest'
import { handleWindowsRuntimeGet, mapWindowsRuntimeReport } from './windows-runtime-route-handler'
import { WINDOWS_RUNTIME_THRESHOLDS } from './windows-runtime-service'
import type { WindowsRuntimeReport } from './windows-runtime-types'

function report(overrides: Partial<WindowsRuntimeReport> = {}): WindowsRuntimeReport {
  return {
    status: 'ready',
    source: 'windows_runtime_probe',
    error: null,
    suitability: 'smooth',
    checkedAt: '2026-07-17T00:00:00.000Z',
    thresholds: WINDOWS_RUNTIME_THRESHOLDS,
    checks: {
      windowsBuild: { status: 'pass', value: 26100, message: 'Windows build 满足流畅运行要求。' },
      wsl: {
        status: 'pass',
        value: { installed: true, version: '2.6.1.0', defaultVersion: 2, featureEnabled: true, virtualMachinePlatformEnabled: true },
        message: 'WSL 已就绪。',
      },
      virtualization: { status: 'pass', value: true, message: 'WSL 已实际运行。' },
      gpu: { status: 'pass', value: { name: 'RTX 4090 Laptop', memoryTotalGb: 16, driverVersion: '572.83' }, message: 'GPU 显存满足流畅运行要求。' },
      ram: { status: 'pass', value: 64, message: '内存满足流畅运行要求。' },
      disk: { status: 'pass', value: { path: 'D:\\runtime', freeGb: 100 }, message: '磁盘空间满足流畅运行要求。' },
      kouboRuntime: { status: 'warning', value: false, message: 'KouboRuntime 尚未安装。' },
    },
    ...overrides,
  }
}

describe('windows runtime route DTO', () => {
  it('maps the internal report to the UI contract', () => {
    expect(mapWindowsRuntimeReport(report())).toMatchObject({
      status: 'ok',
      source: 'windows_runtime',
      assessment: { grade: 'smooth', label: '硬件已通过' },
      install: {
        wslInstalled: true,
        restartRequired: false,
        kouboRuntimeInstalled: false,
        canInstallWsl: false,
      },
      checks: expect.arrayContaining([
        expect.objectContaining({ id: 'windows_build', status: 'ready' }),
        expect.objectContaining({ id: 'wsl', status: 'ready' }),
        expect.objectContaining({
          id: 'koubo_runtime',
          status: 'warning',
          action: '在下方导入并安装 KouboRuntime 运行包。',
        }),
      ]),
    })
  })

  it('exposes WSL installation and restart states without turning them into transport errors', () => {
    const dto = mapWindowsRuntimeReport(report({
      status: 'needs_install',
      suitability: 'smooth',
      checks: {
        ...report().checks,
        wsl: {
          status: 'fail',
          value: { installed: false, version: null, defaultVersion: null, featureEnabled: false, virtualMachinePlatformEnabled: false },
          message: 'WSL 尚未安装。',
        },
      },
    }))

    expect(dto).toMatchObject({
      status: 'ok',
      assessment: { grade: 'smooth', label: '需要安装 WSL' },
      install: { wslInstalled: false, canInstallWsl: true },
    })
  })

  it('returns the strict error contract when probing itself fails', async () => {
    const response = await handleWindowsRuntimeGet({
      inspect: async () => report({
        status: 'failed',
        error: { code: 'probe_failed', message: '无法读取 Windows 环境信息。' },
        suitability: 'unsuitable',
      }),
    })

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      status: 'error',
      source: 'windows_runtime',
      error: { code: 'probe_failed', message: '无法读取 Windows 环境信息。' },
    })
  })

  it('does not offer the install button when an installed WSL needs manual repair', () => {
    const dto = mapWindowsRuntimeReport(report({
      status: 'failed',
      error: { code: 'wsl_unavailable', message: 'WSL 2 尚未就绪。' },
      checks: {
        ...report().checks,
        wsl: {
          status: 'fail',
          value: { installed: false, version: null, defaultVersion: null, featureEnabled: true, virtualMachinePlatformEnabled: true },
          message: 'WSL 功能已启用，但系统 WSL 程序不可用。',
        },
      },
    }))

    expect(dto).toMatchObject({
      status: 'ok',
      install: { wslInstalled: false, canInstallWsl: false },
      checks: expect.arrayContaining([
        expect.objectContaining({ id: 'wsl', action: '修复或更新 Windows WSL 系统组件后重新检查。' }),
      ]),
    })
  })

  it('does not offer installation when the WSL feature probe is unknown', () => {
    const dto = mapWindowsRuntimeReport(report({
      status: 'failed',
      checks: {
        ...report().checks,
        wsl: {
          status: 'unknown',
          value: { installed: false, version: null, defaultVersion: null, featureEnabled: null, virtualMachinePlatformEnabled: null },
          message: '无法确认 WSL 状态。',
        },
      },
    }))

    expect(dto).toMatchObject({
      status: 'ok',
      install: { wslInstalled: false, canInstallWsl: false },
      checks: expect.arrayContaining([
        expect.objectContaining({
          id: 'wsl',
          status: 'unknown',
          action: expect.stringContaining('重新检查'),
        }),
      ]),
    })
  })

  it('never calls insufficient hardware passed just because the runtime is absent', () => {
    const dto = mapWindowsRuntimeReport(report({
      suitability: 'unsuitable',
      checks: {
        ...report().checks,
        gpu: { status: 'fail', value: null, message: '未检测到可用 GPU。' },
        kouboRuntime: { status: 'warning', value: false, message: 'KouboRuntime 尚未安装。' },
      },
    }))

    expect(dto).toMatchObject({ assessment: { grade: 'unsuitable', label: '配置不足' } })
  })
})
