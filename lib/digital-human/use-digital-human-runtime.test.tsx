// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDigitalHumanRuntime } from './use-digital-human-runtime'

const mocks = vi.hoisted(() => ({
  readinessGet: vi.fn(),
  managedGet: vi.fn(),
  startRuntime: vi.fn(),
}))

vi.mock('@/lib/runtime-readiness/runtime-readiness-client', () => ({
  createRuntimeReadinessClient: () => ({ get: mocks.readinessGet }),
}))

vi.mock('@/lib/managed-runtime/managed-runtime-client', () => ({
  createManagedRuntimeClient: () => ({ get: mocks.managedGet }),
}))

vi.mock('@/lib/managed-runtime/managed-runtime-import-client', () => ({
  createManagedRuntimeImportClient: () => ({ startRuntime: mocks.startRuntime }),
}))

beforeEach(() => {
  mocks.readinessGet.mockResolvedValue(readiness(false))
  mocks.managedGet.mockResolvedValue(managed('absent'))
  mocks.startRuntime.mockResolvedValue({
    status: 'ok',
    source: 'managed_wsl_action',
    message: '已启动。',
    version: '1.0.0',
    sha256: null,
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('useDigitalHumanRuntime', () => {
  it('mounts by inspecting only and never starts the managed runtime', async () => {
    const { result } = renderHook(() => useDigitalHumanRuntime())

    await waitFor(() => expect(result.current.message).toContain('尚未安装'))
    expect(mocks.readinessGet).toHaveBeenCalledTimes(1)
    expect(mocks.managedGet).toHaveBeenCalledTimes(1)
    expect(mocks.startRuntime).not.toHaveBeenCalled()
    expect(result.current.canGenerate).toBe(false)
    expect(result.current.action).toBe('open_settings')
  })

  it('accepts a ready configured HeyGem service even when KouboRuntime is absent', async () => {
    mocks.readinessGet.mockResolvedValue(readiness(true))
    const { result } = renderHook(() => useDigitalHumanRuntime())

    await waitFor(() => expect(result.current.canGenerate).toBe(true))
    await expect(act(() => result.current.ensureReady())).resolves.toEqual({ ready: true })
    expect(mocks.startRuntime).not.toHaveBeenCalled()
  })

  it('starts a stopped managed runtime once on demand and waits until ready', async () => {
    mocks.managedGet
      .mockResolvedValueOnce(managed('stopped'))
      .mockResolvedValueOnce(managed('stopped'))
      .mockResolvedValueOnce(managed('ready'))
    const { result } = renderHook(() =>
      useDigitalHumanRuntime({ pollIntervalMs: 0, maxPollAttempts: 3 }))

    await waitFor(() => expect(result.current.canGenerate).toBe(true))
    await expect(act(() => result.current.ensureReady())).resolves.toEqual({ ready: true })
    expect(mocks.startRuntime).toHaveBeenCalledTimes(1)
    expect(mocks.startRuntime).toHaveBeenCalledWith()
    await waitFor(() => expect(result.current.preparing).toBe(false))
  })

  it('only polls an already-running managed runtime without starting it', async () => {
    mocks.managedGet
      .mockResolvedValueOnce(managed('running'))
      .mockResolvedValueOnce(managed('running'))
      .mockResolvedValueOnce(managed('ready'))
    const { result } = renderHook(() =>
      useDigitalHumanRuntime({ pollIntervalMs: 0, maxPollAttempts: 3 }))

    await waitFor(() => expect(result.current.canGenerate).toBe(true))
    await expect(act(() => result.current.ensureReady())).resolves.toEqual({ ready: true })
    expect(mocks.startRuntime).not.toHaveBeenCalled()
  })

  it('shares repeated ensure calls and does not start twice', async () => {
    let releaseReady: (() => void) | undefined
    const readyLater = new Promise<void>((resolve) => { releaseReady = resolve })
    mocks.managedGet
      .mockResolvedValueOnce(managed('stopped'))
      .mockResolvedValueOnce(managed('stopped'))
      .mockImplementationOnce(async () => {
        await readyLater
        return managed('ready')
      })
    const { result } = renderHook(() =>
      useDigitalHumanRuntime({ pollIntervalMs: 0, maxPollAttempts: 3 }))
    await waitFor(() => expect(result.current.canGenerate).toBe(true))

    let first!: ReturnType<typeof result.current.ensureReady>
    let second!: ReturnType<typeof result.current.ensureReady>
    act(() => {
      first = result.current.ensureReady()
      second = result.current.ensureReady()
    })
    expect(first).toBe(second)
    releaseReady?.()
    await expect(first).resolves.toEqual({ ready: true })
    expect(mocks.startRuntime).toHaveBeenCalledTimes(1)
  })

  it('returns a stable settings action for absence, start failure and timeout', async () => {
    const absentHook = renderHook(() =>
      useDigitalHumanRuntime({ pollIntervalMs: 0, maxPollAttempts: 1 }))
    await waitFor(() => expect(absentHook.result.current.message).toContain('尚未安装'))
    await expect(act(() => absentHook.result.current.ensureReady())).resolves.toMatchObject({
      ready: false,
      action: 'open_settings',
    })
    absentHook.unmount()

    mocks.managedGet.mockReset()
    mocks.managedGet.mockResolvedValue(managed('stopped'))
    mocks.startRuntime.mockResolvedValue({
      status: 'error',
      source: 'managed_wsl_action',
      error: { code: 'runtime_start_failed', message: '启动失败，请检查 WSL。' },
    })
    const failedHook = renderHook(() =>
      useDigitalHumanRuntime({ pollIntervalMs: 0, maxPollAttempts: 1 }))
    await waitFor(() => expect(failedHook.result.current.canGenerate).toBe(true))
    await expect(act(() => failedHook.result.current.ensureReady())).resolves.toEqual({
      ready: false,
      message: '启动失败，请检查 WSL。',
      action: 'open_settings',
    })
    failedHook.unmount()

    mocks.managedGet.mockReset()
    mocks.managedGet.mockResolvedValue(managed('running'))
    const timeoutHook = renderHook(() =>
      useDigitalHumanRuntime({ pollIntervalMs: 0, maxPollAttempts: 2 }))
    await waitFor(() => expect(timeoutHook.result.current.canGenerate).toBe(true))
    await expect(act(() => timeoutHook.result.current.ensureReady())).resolves.toEqual({
      ready: false,
      message: '数字人运行环境启动超时，请到设置中检查服务状态。',
      action: 'open_settings',
    })
    timeoutHook.unmount()
  })

  it('ignores an old wait after unmount', async () => {
    mocks.managedGet.mockResolvedValue(managed('running'))
    const hook = renderHook(() =>
      useDigitalHumanRuntime({ pollIntervalMs: 0, maxPollAttempts: 3 }))
    await waitFor(() => expect(hook.result.current.canGenerate).toBe(true))

    const pending = hook.result.current.ensureReady()
    hook.unmount()

    await expect(pending).resolves.toEqual({
      ready: false,
      message: '数字人运行环境准备已取消。',
    })
    expect(mocks.startRuntime).not.toHaveBeenCalled()
  })

  it('does not accept a ready result from an inspect that finishes after unmount', async () => {
    let releaseReadiness: ((value: ReturnType<typeof readiness>) => void) | undefined
    let releaseManaged: ((value: ReturnType<typeof managed>) => void) | undefined
    const pendingReadiness = new Promise<ReturnType<typeof readiness>>((resolve) => {
      releaseReadiness = resolve
    })
    const pendingManaged = new Promise<ReturnType<typeof managed>>((resolve) => {
      releaseManaged = resolve
    })
    mocks.managedGet.mockResolvedValueOnce(managed('running')).mockReturnValueOnce(pendingManaged)
    mocks.readinessGet.mockResolvedValueOnce(readiness(false)).mockReturnValueOnce(pendingReadiness)
    const hook = renderHook(() => useDigitalHumanRuntime({ pollIntervalMs: 0, maxPollAttempts: 2 }))
    await waitFor(() => expect(hook.result.current.canGenerate).toBe(true))

    const pending = hook.result.current.ensureReady()
    hook.unmount()
    releaseReadiness?.(readiness(true))
    releaseManaged?.(managed('ready'))

    await expect(pending).resolves.toEqual({
      ready: false,
      message: '数字人运行环境准备已取消。',
    })
    expect(mocks.startRuntime).not.toHaveBeenCalled()
  })

  it('does not start a stopped runtime returned by an inspect after unmount', async () => {
    let releaseReadiness: ((value: ReturnType<typeof readiness>) => void) | undefined
    let releaseManaged: ((value: ReturnType<typeof managed>) => void) | undefined
    const pendingReadiness = new Promise<ReturnType<typeof readiness>>((resolve) => {
      releaseReadiness = resolve
    })
    const pendingManaged = new Promise<ReturnType<typeof managed>>((resolve) => {
      releaseManaged = resolve
    })
    mocks.managedGet.mockResolvedValueOnce(managed('running')).mockReturnValueOnce(pendingManaged)
    mocks.readinessGet.mockResolvedValueOnce(readiness(false)).mockReturnValueOnce(pendingReadiness)
    const hook = renderHook(() => useDigitalHumanRuntime({ pollIntervalMs: 0, maxPollAttempts: 2 }))
    await waitFor(() => expect(hook.result.current.canGenerate).toBe(true))

    const pending = hook.result.current.ensureReady()
    hook.unmount()
    releaseReadiness?.(readiness(false))
    releaseManaged?.(managed('stopped'))

    await expect(pending).resolves.toEqual({
      ready: false,
      message: '数字人运行环境准备已取消。',
    })
    expect(mocks.startRuntime).not.toHaveBeenCalled()
  })
})

function readiness(heyGemReady: boolean) {
  return {
    status: 'ready' as const,
    source: 'runtime_readiness' as const,
    profile: {
      id: 'base' as const,
      title: '基础版',
      description: '测试',
      requiredCheckIds: ['model_provider'],
    },
    updatedAt: '2026-07-17T00:00:00.000Z',
    summary: { ready: heyGemReady ? 1 : 0, missing: 0, warning: heyGemReady ? 0 : 1 },
    checks: [{
      id: 'heygem',
      title: 'Duix / HeyGem 数字人',
      status: heyGemReady ? 'ready' as const : 'warning' as const,
      requiredForCurrentProfile: false,
      optionalForCurrentProfile: true,
      gaps: heyGemReady ? [] : ['尚未连接数字人 runtime。'],
      nextStep: heyGemReady ? '已就绪。' : '打开设置。',
      provisioning: {
        priority: 1,
        stage: 'runtime 配置',
        required: ['数字人 runtime'],
        sensitiveEnvKeys: [],
        safeEvidence: '测试',
      },
      remediation: {
        envKeys: [],
        envTemplate: '',
        command: '',
        docPath: 'docs/CONTEXT.md',
      },
    }],
  }
}

function managed(phase: 'absent' | 'stopped' | 'running' | 'ready' | 'failed') {
  return {
    status: 'ok' as const,
    source: 'managed_wsl' as const,
    runtime: {
      phase,
      installed: phase !== 'absent',
      running: phase === 'running' || phase === 'ready',
      healthy: phase === 'ready',
      version: phase === 'ready' ? '1.0.0' : null,
      apiUrl: phase === 'ready' ? 'http://127.0.0.1:8383' : null,
      detail: phase === 'failed' ? '运行环境损坏。' : `runtime ${phase}`,
    },
    actions: {
      canImport: phase === 'absent',
      canStart: phase === 'stopped',
      canStop: phase === 'running' || phase === 'ready',
      canUninstall: phase !== 'absent',
    },
  }
}
