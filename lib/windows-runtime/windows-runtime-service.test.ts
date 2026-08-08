import { describe, expect, it } from 'vitest'
import { inspectWindowsRuntime } from './windows-runtime-service'
import type { CommandResult, WindowsSystemProbe } from './windows-runtime-types'

const ok = (stdout = ''): CommandResult => ({ ok: true, exitCode: 0, stdout, stderr: '' })

function probe(overrides: Partial<WindowsSystemProbe> = {}): WindowsSystemProbe {
  return {
    platform: 'win32',
    windowsBuild: 26100,
    totalRamBytes: 32 * 1024 ** 3,
    virtualizationFirmwareEnabled: true,
    wslFeatureEnabled: true,
    virtualMachinePlatformEnabled: true,
    runtimePath: 'D:\\KouboRuntime',
    diskFreeBytes: 60 * 1024 ** 3,
    wslStatus: ok('Default Version: 2'),
    wslVersion: ok('WSL version: 2.4.13.0'),
    wslDistros: ok('Ubuntu\r\nKouboRuntime\r\n'),
    nvidiaSmi: ok('NVIDIA GeForce RTX 4070, 12288, 572.83'),
    ...overrides,
  }
}

describe('inspectWindowsRuntime', () => {
  it('reports a smooth, ready environment with KouboRuntime installed', async () => {
    const report = await inspectWindowsRuntime({
      probe: async () => probe(),
      now: () => new Date('2026-07-17T00:00:00.000Z'),
    })

    expect(report).toMatchObject({
      status: 'ready',
      source: 'windows_runtime_probe',
      error: null,
      suitability: 'smooth',
      checkedAt: '2026-07-17T00:00:00.000Z',
      checks: {
        wsl: { status: 'pass' },
        gpu: { status: 'pass', value: { memoryTotalGb: 12 } },
        kouboRuntime: { status: 'pass', value: true },
      },
    })
    expect(report.checks.wsl.message).toContain('2.4.13.0')
    expect(report.checks.gpu.message).toContain('RTX 4070')
    expect(report.checks.gpu.message).toContain('12 GB')
    expect(report.checks.ram.message).toContain('32 GB')
    expect(report.checks.disk.message).toContain('60 GB')
  })

  it('reports needs_install when the WSL feature is disabled', async () => {
    const report = await inspectWindowsRuntime({
      probe: async () => probe({ wslFeatureEnabled: false }),
    })

    expect(report.status).toBe('needs_install')
    expect(report.suitability).toBe('smooth')
    expect(report.checks.wsl.status).toBe('fail')
  })

  it('reports needs_restart separately from missing WSL', async () => {
    const report = await inspectWindowsRuntime({
      probe: async () => probe({
        wslStatus: { ok: false, exitCode: 1, stdout: '', stderr: '请重新启动 Windows 后完成安装。' },
      }),
    })

    expect(report.status).toBe('needs_restart')
    expect(report.checks.wsl.status).toBe('warning')
  })

  it('does not confuse the default distro version with KouboRuntime WSL 2 capability', async () => {
    const report = await inspectWindowsRuntime({
      probe: async () => probe({ wslStatus: ok('Default Version: 1') }),
    })

    expect(report.status).toBe('ready')
    expect(report.checks.wsl).toMatchObject({
      status: 'pass',
      value: { installed: true, defaultVersion: 1 },
    })
    expect(report.checks.wsl.message).toContain('KouboRuntime 明确安装为 WSL 2')
  })

  it('requires Virtual Machine Platform before treating WSL 2 as operational', async () => {
    const report = await inspectWindowsRuntime({
      probe: async () => probe({ virtualMachinePlatformEnabled: false }),
    })

    expect(report.status).toBe('failed')
    expect(report.checks.wsl.status).toBe('fail')
    expect(report.checks.wsl.message).toContain('虚拟机平台未启用')
  })

  it('trusts an operational WSL over an inaccurate firmware virtualization field', async () => {
    const report = await inspectWindowsRuntime({
      probe: async () => probe({
        virtualizationFirmwareEnabled: false,
        wslDistros: ok('Ubuntu\r\ndocker-desktop\r\n'),
      }),
    })

    expect(report.suitability).toBe('smooth')
    expect(report.checks.virtualization).toMatchObject({ status: 'pass', value: true })
    expect(report.checks.kouboRuntime).toMatchObject({ status: 'warning', value: false })
  })

  it('uses conservative minimum thresholds for usable hardware', async () => {
    const report = await inspectWindowsRuntime({
      probe: async () => probe({
        totalRamBytes: 16 * 1024 ** 3,
        diskFreeBytes: 40 * 1024 ** 3,
        nvidiaSmi: ok('NVIDIA GeForce RTX 4060, 8192, 572.83'),
      }),
    })

    expect(report.status).toBe('ready')
    expect(report.suitability).toBe('usable')
    expect(report.checks.ram.status).toBe('warning')
    expect(report.checks.gpu.status).toBe('warning')
    expect(report.checks.disk.status).toBe('warning')
  })

  it('reports unsuitable below any minimum hardware threshold', async () => {
    const report = await inspectWindowsRuntime({
      probe: async () => probe({ totalRamBytes: 15 * 1024 ** 3 }),
    })

    expect(report.suitability).toBe('unsuitable')
    expect(report.checks.ram.status).toBe('fail')
  })

  it('returns a stable failed response when probing throws', async () => {
    const report = await inspectWindowsRuntime({
      probe: async () => { throw new Error('boom') },
    })

    expect(report).toMatchObject({
      status: 'failed',
      source: 'windows_runtime_probe',
      error: { code: 'probe_failed' },
      suitability: 'unsuitable',
    })
  })

  it('does not guess that WSL is missing when the system feature probe is unknown', async () => {
    const report = await inspectWindowsRuntime({
      probe: async () => probe({ wslFeatureEnabled: null }),
    })

    expect(report.status).toBe('failed')
    expect(report.checks.wsl.status).toBe('unknown')
  })

  it('classifies a complete Windows system probe failure instead of blaming WSL', async () => {
    const report = await inspectWindowsRuntime({
      probe: async () => probe({
        windowsBuild: null,
        totalRamBytes: null,
        virtualizationFirmwareEnabled: null,
        wslFeatureEnabled: null,
        virtualMachinePlatformEnabled: null,
      }),
    })

    expect(report).toMatchObject({
      status: 'failed',
      error: { code: 'probe_failed' },
    })
  })

  it('keeps a failed distro listing unknown instead of claiming the runtime is absent', async () => {
    const report = await inspectWindowsRuntime({
      probe: async () => probe({
        wslDistros: { ok: false, exitCode: 1, stdout: '', stderr: 'access denied' },
      }),
    })

    expect(report.checks.kouboRuntime).toMatchObject({ status: 'unknown', value: null })
  })

  it('uses Windows build language instead of a memory-size unit', async () => {
    const report = await inspectWindowsRuntime({
      probe: async () => probe({ windowsBuild: 18363 }),
    })

    expect(report.checks.windowsBuild).toMatchObject({ status: 'fail', value: 18363 })
    expect(report.checks.windowsBuild.message).toContain('Build 19041')
    expect(report.checks.windowsBuild.message).not.toContain('GB')
  })
})
