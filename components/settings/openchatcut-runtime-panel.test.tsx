// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenChatCutRuntimePanel } from './openchatcut-runtime-panel'

const mocks = vi.hoisted(() => ({
  getRuntime: vi.fn(),
  mutateRuntime: vi.fn(),
}))

vi.mock('@/lib/openchatcut/client', () => ({
  getOpenChatCutRuntimeClient: mocks.getRuntime,
  mutateOpenChatCutRuntimeClient: mocks.mutateRuntime,
}))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('OpenChatCutRuntimePanel', () => {
  it('shows received, total and percent while polling a background download', async () => {
    mocks.getRuntime.mockResolvedValue({
      status: 'ok',
      source: 'openchatcut',
      runtime: {
        phase: 'downloading',
        installed: false,
        installerReady: false,
        mcpReady: false,
        detail: '下载中',
        version: '0.1.6',
        download: { received: 5 * 1024 * 1024, total: 10 * 1024 * 1024, percent: 50, stalled: false },
      },
    })
    render(<OpenChatCutRuntimePanel />)
    await waitFor(() => expect(screen.getByText(/5\.0 MiB \/ 10\.0 MiB（50%）/)).toBeInTheDocument())
  })

  it('shows one consistent loading indicator and polls while the managed app is launching', async () => {
    vi.useFakeTimers()
    mocks.getRuntime.mockResolvedValue({
      status: 'ok',
      source: 'openchatcut',
      runtime: {
        phase: 'launching',
        installed: true,
        installerReady: false,
        mcpReady: false,
        detail: '正在启动受管 OpenChatCut',
        version: '0.1.6',
      },
    })
    render(<OpenChatCutRuntimePanel />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('启动中')).toBeInTheDocument()
    expect(screen.getByLabelText('OpenChatCut 正在处理')).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(751) })
    expect(mocks.getRuntime).toHaveBeenCalledTimes(2)
  })

  it('explains an external instance conflict without offering another launch', async () => {
    mocks.getRuntime.mockResolvedValue({
      status: 'ok',
      source: 'openchatcut',
      runtime: {
        phase: 'external_instance',
        installed: true,
        installerReady: false,
        mcpReady: false,
        detail: '检测到另一个 OpenChatCut 实例；请关闭它，再从口播智能体启动。',
        version: '0.1.6',
        error: { code: 'external_instance', message: 'external' },
      },
    })
    render(<OpenChatCutRuntimePanel />)
    await waitFor(() => expect(screen.getByText('实例冲突')).toBeInTheDocument())
    expect(screen.getByText(/请关闭它，再从口播智能体启动/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /启动/ })).not.toBeInTheDocument()
  })

  it('offers repair install for an incomplete installation with a verified installer', async () => {
    const runtime = {
      phase: 'failed' as const,
      installed: false,
      installerReady: true,
      mcpReady: false,
      detail: '安装不完整',
      version: '0.1.6',
      error: { code: 'install_incomplete', message: '安装不完整' },
    }
    mocks.getRuntime.mockResolvedValue({ status: 'ok', source: 'openchatcut', runtime })
    mocks.mutateRuntime.mockResolvedValue({
      status: 'ok',
      source: 'openchatcut',
      runtime: { ...runtime, phase: 'installing', detail: '安装器运行中' },
    })

    render(<OpenChatCutRuntimePanel />)
    const repair = await screen.findByRole('button', { name: /修复安装/ })
    fireEvent.click(repair)

    await waitFor(() => expect(mocks.mutateRuntime).toHaveBeenCalledWith({
      action: 'launch',
      target: 'installer',
    }))
  })

  it('never overlaps transient polling requests when one inspection is slow', async () => {
    vi.useFakeTimers()
    const launching = {
      status: 'ok' as const,
      source: 'openchatcut' as const,
      runtime: {
        phase: 'launching' as const,
        installed: true,
        installerReady: false,
        mcpReady: false,
        detail: '正在连接 MCP',
        version: '0.1.6',
      },
    }
    let resolveSlow!: (value: typeof launching) => void
    mocks.getRuntime
      .mockResolvedValueOnce(launching)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSlow = resolve }))
      .mockResolvedValue(launching)

    render(<OpenChatCutRuntimePanel />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    await act(async () => { await vi.advanceTimersByTimeAsync(751) })
    expect(mocks.getRuntime).toHaveBeenCalledTimes(2)

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(mocks.getRuntime).toHaveBeenCalledTimes(2)

    await act(async () => {
      resolveSlow(launching)
      await Promise.resolve()
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(751) })
    expect(mocks.getRuntime).toHaveBeenCalledTimes(3)
  })

  it('ignores an old refresh response after a repair mutation starts', async () => {
    const incomplete = {
      phase: 'failed' as const,
      installed: false,
      installerReady: true,
      mcpReady: false,
      detail: '安装不完整',
      version: '0.1.6',
      error: { code: 'install_incomplete', message: '安装不完整' },
    }
    let resolveOld!: (value: {
      status: 'ok'
      source: 'openchatcut'
      runtime: typeof incomplete
    }) => void
    mocks.getRuntime
      .mockResolvedValueOnce({ status: 'ok', source: 'openchatcut', runtime: incomplete })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
    mocks.mutateRuntime.mockResolvedValue({
      status: 'ok',
      source: 'openchatcut',
      runtime: {
        ...incomplete,
        phase: 'installing',
        detail: '安装器运行中',
        error: undefined,
      },
    })

    render(<OpenChatCutRuntimePanel />)
    const repair = await screen.findByRole('button', { name: /修复安装/ })
    fireEvent.click(screen.getByRole('button', { name: '刷新专业剪辑器' }))
    fireEvent.click(repair)
    await waitFor(() => expect(screen.getByText('安装中')).toBeInTheDocument())

    await act(async () => {
      resolveOld({ status: 'ok', source: 'openchatcut', runtime: incomplete })
      await Promise.resolve()
    })
    expect(screen.getByText('安装中')).toBeInTheDocument()
  })
})
