// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WindowsRuntimePanel } from './windows-runtime-panel'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
})

describe('WindowsRuntimePanel', () => {
  it('shows a compact smooth assessment and expands detailed checks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      ...runtimeFixture,
      assessment: { grade: 'smooth', label: '流畅运行', summary: '显卡与 WSL 环境满足流畅生成要求。' },
    })))

    render(<WindowsRuntimePanel />)

    expect(await screen.findByText('流畅运行')).toBeInTheDocument()
    expect(screen.getByText('显卡与 WSL 环境满足流畅生成要求。')).toBeInTheDocument()
    expect(screen.getByText('WSL 2')).not.toBeVisible()

    await userEvent.click(screen.getByText('查看 2 项检查结果'))
    expect(screen.getByText('WSL 2')).toBeVisible()
    expect(screen.getByText('NVIDIA GPU')).toBeInTheDocument()
  })

  it('offers one-click WSL installation and keeps browsers shell-free', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      ...runtimeFixture,
      assessment: { grade: 'unsuitable', label: '需要安装 WSL', summary: '缺少 WSL，暂时不能运行本地数字人。' },
      install: {
        wslInstalled: false,
        restartRequired: false,
        kouboRuntimeInstalled: false,
        canInstallWsl: true,
      },
    })))
    const user = userEvent.setup()

    render(<WindowsRuntimePanel />)

    await user.click(await screen.findByRole('button', { name: '安装 WSL' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('需要在口播智能体桌面端中执行')
    expect(screen.getByText(/Windows 会弹出管理员授权/)).toBeInTheDocument()
  })

  it('shows an explicit restart boundary reported by the health check', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      ...runtimeFixture,
      assessment: { grade: 'unsuitable', label: '需要重启', summary: '重启后继续配置。' },
      install: {
        wslInstalled: true,
        restartRequired: true,
        kouboRuntimeInstalled: false,
        canInstallWsl: false,
      },
    })))

    render(<WindowsRuntimePanel />)

    expect(await screen.findByText(/重启 Windows 后才能继续安装数字人运行环境/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '安装 WSL' })).not.toBeInTheDocument()
  })

  it('keeps restart-required installation authoritative when the refreshed health result is stale', async () => {
    const staleHealth = {
      ...runtimeFixture,
      assessment: { grade: 'unsuitable' as const, label: '需要安装 WSL', summary: '缺少 WSL。' },
      checks: runtimeFixture.checks.map((check) => check.id === 'wsl'
        ? { ...check, status: 'missing' as const, detail: 'WSL 尚未安装。', action: '点击安装 WSL。' }
        : check),
      install: {
        wslInstalled: false,
        restartRequired: false,
        kouboRuntimeInstalled: false,
        canInstallWsl: true,
      },
    }
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(staleHealth)))
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
    let finishInstall: ((value: unknown) => void) | undefined
    mocks.invoke.mockImplementation(() => new Promise((resolve) => { finishInstall = resolve }))
    const user = userEvent.setup()

    render(<WindowsRuntimePanel />)
    const installButton = await screen.findByRole('button', { name: '安装 WSL' })
    await user.click(installButton)

    expect(screen.getByRole('region', { name: 'Windows 环境体检' })).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: '等待管理员授权并安装，请勿关闭' })).toHaveAttribute('aria-busy', 'true')

    finishInstall?.({
      status: 'ok',
      source: 'tauri_wsl_installer',
      restartRequired: true,
      message: 'WSL 安装已提交，需要重启 Windows 后继续。',
    })

    expect(await screen.findByText(/重启 Windows 后才能继续安装数字人运行环境/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '安装 WSL' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Windows 环境体检' })).toHaveAttribute('aria-busy', 'false')
  })

  it('shows a manual repair boundary when WSL is not ready and automatic installation is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      ...runtimeFixture,
      assessment: { grade: 'unsuitable', label: '环境待修复', summary: 'WSL 2 当前无法正常运行。' },
      checks: runtimeFixture.checks.map((check) => check.id === 'wsl'
        ? { ...check, status: 'missing', detail: '默认版本不是 WSL 2。', action: '切换到 WSL 2 后重新检查。' }
        : check),
      install: {
        wslInstalled: true,
        restartRequired: false,
        kouboRuntimeInstalled: false,
        canInstallWsl: false,
      },
    })))

    render(<WindowsRuntimePanel />)

    expect(await screen.findByText(/需手动修复，请展开检查项查看下一步/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '安装 WSL' })).not.toBeInTheDocument()
  })

  it('refreshes the assessment without leaking health logic into settings page', async () => {
    const fetcher = vi.fn(async () => jsonResponse(runtimeFixture))
    vi.stubGlobal('fetch', fetcher)
    const user = userEvent.setup()

    render(<WindowsRuntimePanel />)
    await screen.findByText('可以使用')
    await user.click(screen.getByRole('button', { name: '刷新 Windows 环境体检' }))

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
  })
})

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const runtimeFixture = {
  status: 'ok' as const,
  source: 'windows_runtime' as const,
  assessment: {
    grade: 'usable' as const,
    label: '可以使用',
    summary: '可以生成数字人，较高分辨率可能需要等待。',
  },
  checks: [
    {
      id: 'wsl',
      title: 'WSL 2',
      status: 'ready' as const,
      detail: '已启用，版本可用。',
    },
    {
      id: 'gpu',
      title: 'NVIDIA GPU',
      status: 'warning' as const,
      detail: '显存 6 GB。',
      action: '降低输出分辨率可减少等待。',
    },
  ],
  install: {
    wslInstalled: true,
    restartRequired: false,
    kouboRuntimeInstalled: false,
    canInstallWsl: false,
  },
}
