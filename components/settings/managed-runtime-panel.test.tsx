// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManagedRuntimePanel } from './managed-runtime-panel'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
})

describe('ManagedRuntimePanel', () => {
  it('offers a local authorized package import without exposing a browser file upload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(absentFixture)))
    const user = userEvent.setup()

    render(<ManagedRuntimePanel />)

    await user.click(await screen.findByRole('button', { name: '选择本地运行包' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('需要在口播智能体桌面端中执行')
    expect(screen.getByText(/文件不会上传，也不会安装 Docker/)).toBeInTheDocument()
    expect(screen.getByText(/同一目录必须有 X\.tar\.sha256/)).toBeInTheDocument()
    expect(screen.getByText(/不代表数字签名或分发授权/)).toBeInTheDocument()
    expect(document.querySelector('input[type="file"]')).not.toBeInTheDocument()
  })

  it('shows a short verified digest after a successful desktop import', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(absentFixture)))
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
    const sha256 = '0123456789abcdef'.repeat(4)
    mocks.invoke.mockResolvedValue({
      status: 'ok',
      source: 'tauri_koubo_runtime_importer',
      version: '2026.07.0',
      sha256,
      message: 'KouboRuntime 已安全导入。',
    })

    render(<ManagedRuntimePanel />)
    await userEvent.click(await screen.findByRole('button', { name: '选择本地运行包' }))

    expect(await screen.findByRole('status')).toHaveTextContent('KouboRuntime 已安全导入。')
    expect(screen.getByText('SHA-256 01234567…89abcdef')).toBeInTheDocument()
  })

  it('shows an installed healthy runtime without an import action', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      ...absentFixture,
      runtime: {
        phase: 'ready', installed: true, running: true, healthy: true,
        version: '1.0.0', apiUrl: 'http://127.0.0.1:8383', detail: 'KouboRuntime 1.0.0 已就绪。',
      },
      actions: { canImport: false, canStart: false, canStop: true, canUninstall: true },
    })))

    render(<ManagedRuntimePanel />)

    expect(await screen.findByText('可用')).toBeInTheDocument()
    expect(screen.getByText('KouboRuntime 1.0.0 已就绪。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '选择本地运行包' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '停止运行环境' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '移除运行环境' })).toBeInTheDocument()
    expect(screen.getByText(/不会删除创作项目、素材或其他 WSL 发行版/)).toBeInTheDocument()
  })

  it('offers an explicit desktop-only start action for a stopped runtime', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      ...absentFixture,
      runtime: {
        phase: 'stopped', installed: true, running: false, healthy: false,
        version: null, apiUrl: null, detail: 'KouboRuntime 已安装，当前未启动。',
      },
      actions: { canImport: false, canStart: true, canStop: false, canUninstall: true },
    })))
    const user = userEvent.setup()

    render(<ManagedRuntimePanel />)
    await user.click(await screen.findByRole('button', { name: '启动运行环境' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('需要在口播智能体桌面端中执行')
  })

  it('keeps a cancelled native uninstall from appearing successful', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      ...absentFixture,
      runtime: {
        phase: 'failed', installed: true, running: false, healthy: false,
        version: null, apiUrl: null, detail: '运行包需要修复。',
      },
      actions: { canImport: false, canStart: false, canStop: false, canUninstall: true },
    })))
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
    mocks.invoke.mockResolvedValue({ status: 'cancelled', message: '已取消移除。' })

    render(<ManagedRuntimePanel />)
    await userEvent.click(await screen.findByRole('button', { name: '移除运行环境' }))

    expect(mocks.invoke).toHaveBeenCalledWith('uninstall_koubo_runtime')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

function response(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

const absentFixture = {
  status: 'ok' as const,
  source: 'managed_wsl' as const,
  runtime: {
    phase: 'absent' as const,
    installed: false,
    running: false,
    healthy: false,
    version: null,
    apiUrl: null,
    detail: '尚未安装 KouboRuntime。',
  },
  actions: { canImport: true, canStart: false, canStop: false, canUninstall: false },
}
