// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AvatarChamber } from './avatar-chamber'

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  upload: vi.fn(),
  listAssets: vi.fn(),
  deleteAsset: vi.fn(),
  ensureRuntimeReady: vi.fn(),
  runtimeGateState: {
    canGenerate: true,
    preparing: false,
    message: undefined as string | undefined,
    action: undefined as 'open_settings' | undefined,
  },
  heygemState: {
    status: 'idle',
    task: undefined as unknown,
    artifact: undefined as unknown,
    project: undefined as unknown,
    lastResult: undefined as unknown,
  },
}))

vi.mock('@/lib/digital-human/avatar-asset-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/digital-human/avatar-asset-client')>()),
  listAvatarAssetsClient: mocks.listAssets,
  deleteAvatarAssetClient: mocks.deleteAsset,
}))

vi.mock('@/lib/digital-human/use-heygem', () => ({
  useHeyGem: () => ({ ...mocks.heygemState, generate: mocks.generate }),
}))

vi.mock('@/lib/digital-human/use-avatar-asset-upload', () => ({
  useAvatarAssetUpload: () => ({ status: 'idle', lastResult: undefined, upload: mocks.upload }),
}))

vi.mock('@/lib/digital-human/use-digital-human-runtime', () => ({
  useDigitalHumanRuntime: () => ({
    ...mocks.runtimeGateState,
    ensureReady: mocks.ensureRuntimeReady,
    refresh: vi.fn(),
  }),
}))

const avatarAsset = {
  assetId: 'avatar-asset-001',
  assetType: 'avatar' as const,
  projectId: 'demo',
  featureType: 'digital-human' as const,
  originalFilename: 'avatar.mp4',
  contentType: 'video/mp4',
  relativePath: 'files/avatars/avatar.mp4',
  path: 'C:/workspace/files/avatars/avatar.mp4',
  size: 1024,
  status: 'ready' as const,
  createdAt: '2026-06-11T00:00:00.000Z',
  updatedAt: '2026-06-11T00:00:00.000Z',
}

beforeEach(() => {
  window.scrollTo = vi.fn()
  mocks.listAssets.mockResolvedValue({ status: 'ok', source: 'avatar_asset', assets: [] })
  mocks.deleteAsset.mockResolvedValue({ status: 'ok', source: 'avatar_asset', assetId: avatarAsset.assetId })
  mocks.ensureRuntimeReady.mockResolvedValue({ ready: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.heygemState.status = 'idle'
  mocks.heygemState.task = undefined
  mocks.heygemState.artifact = undefined
  mocks.heygemState.project = undefined
  mocks.heygemState.lastResult = undefined
  mocks.runtimeGateState.canGenerate = true
  mocks.runtimeGateState.preparing = false
  mocks.runtimeGateState.message = undefined
  mocks.runtimeGateState.action = undefined
})

describe('AvatarChamber', () => {
  it('requires a real local avatar asset before generation', async () => {
    render(<AvatarChamber projectId="demo" scriptArtifactId="script-001" audioArtifactId="audio-001" onNext={() => undefined} onPrev={() => undefined} />)
    await screen.findByText('请导入一段正脸视频作为数字人形象。')
    expect(screen.getByRole('button', { name: '生成' })).toBeDisabled()
    expect(screen.queryByText('林夕')).not.toBeInTheDocument()
  })

  it('lists, previews and submits a real avatar asset, then waits for verified recovery', async () => {
    mocks.listAssets.mockResolvedValue({ status: 'ok', source: 'avatar_asset', assets: [avatarAsset] })
    mocks.generate.mockResolvedValue({
      status: 'ok', source: 'heygem_service',
      artifact: { artifactId: 'render-001', outputPath: 'C:/workspace/render-001.mp4', createdAt: '2026-06-11T00:00:00.000Z' },
    })
    const user = userEvent.setup()
    const view = render(<AvatarChamber projectId="demo" scriptArtifactId="script-001" audioArtifactId="audio-001" onNext={() => undefined} onPrev={() => undefined} />)

    expect(await screen.findByLabelText('形象预览 avatar.mp4')).toHaveAttribute('src', '/api/projects/demo/avatar-assets/avatar-asset-001/file')
    await user.click(screen.getByRole('button', { name: '生成' }))
    await waitFor(() => expect(mocks.ensureRuntimeReady).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mocks.generate).toHaveBeenCalledWith({
      sessionId: 'avatar-session',
      input: { avatarAssetId: 'avatar-asset-001', mode: 'standard' },
    }))
    expect(screen.queryByLabelText('数字人生成视频预览')).not.toBeInTheDocument()
    setReadyRender('render-001')
    view.rerender(<AvatarChamber projectId="demo" scriptArtifactId="script-001" audioArtifactId="audio-001" onNext={() => undefined} onPrev={() => undefined} />)
    const preview = await screen.findByLabelText('数字人生成视频预览')
    expect(preview).toHaveAttribute('src', '/api/projects/demo/render-artifacts/render-001/file')
    expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled()
    fireEvent.loadedMetadata(preview)
    expect(screen.getByRole('button', { name: '下一步' })).toBeEnabled()
  })

  it('uploads and refreshes the avatar library', async () => {
    mocks.upload.mockImplementation(async () => {
      mocks.listAssets.mockResolvedValue({ status: 'ok', source: 'avatar_asset', assets: [avatarAsset] })
      return { status: 'ok', source: 'avatar_asset', asset: avatarAsset }
    })
    const user = userEvent.setup()
    render(<AvatarChamber projectId="demo" scriptArtifactId="script-001" audioArtifactId="audio-001" onNext={() => undefined} onPrev={() => undefined} />)
    await user.upload(screen.getByLabelText('上传数字人形象视频'), new File(['avatar'], 'avatar.mp4', { type: 'video/mp4' }))
    expect(await screen.findByLabelText('形象预览 avatar.mp4')).toBeInTheDocument()
    expect(mocks.listAssets).toHaveBeenCalledTimes(2)
  })

  it('deletes a real avatar and refreshes the library', async () => {
    mocks.listAssets.mockResolvedValueOnce({ status: 'ok', source: 'avatar_asset', assets: [avatarAsset] }).mockResolvedValue({ status: 'ok', source: 'avatar_asset', assets: [] })
    const user = userEvent.setup()
    render(<AvatarChamber projectId="demo" scriptArtifactId="script-001" audioArtifactId="audio-001" onNext={() => undefined} onPrev={() => undefined} />)
    await user.click(await screen.findByRole('button', { name: '删除形象 avatar.mp4' }))
    expect(mocks.deleteAsset).toHaveBeenCalledWith('demo', 'avatar-asset-001')
    expect(await screen.findByText('请导入一段正脸视频作为数字人形象。')).toBeInTheDocument()
  })

  it('restores a ready render preview after refresh', async () => {
    setReadyRender('render-restored')
    render(<AvatarChamber projectId="demo" scriptArtifactId="script-001" audioArtifactId="audio-001" onNext={() => undefined} onPrev={() => undefined} />)
    const preview = await screen.findByLabelText('数字人生成视频预览')
    expect(preview).toHaveAttribute('src', '/api/projects/demo/render-artifacts/render-restored/file')
    expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled()
    fireEvent.loadedMetadata(preview)
    expect(screen.getByRole('button', { name: '下一步' })).toBeEnabled()
  })

  it('allows replacing a recovered ready avatar without restoring the old preview', async () => {
    mocks.listAssets.mockResolvedValue({ status: 'ok', source: 'avatar_asset', assets: [avatarAsset] })
    setReadyRender('render-restored')
    const user = userEvent.setup()
    render(<AvatarChamber projectId="demo" scriptArtifactId="script-001" audioArtifactId="audio-001" onNext={() => undefined} onPrev={() => undefined} />)

    await user.click(await screen.findByRole('button', { name: '更换形象' }))

    expect(screen.queryByLabelText('数字人生成视频预览')).not.toBeInTheDocument()
    expect(await screen.findByLabelText('形象预览 avatar.mp4')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled()
  })

  it('shows the persisted runtime error after refresh', () => {
    mocks.heygemState.status = 'adapter_error'
    mocks.heygemState.lastResult = { status: 'adapter_error', source: 'heygem_task', error: { code: 'runtime_timeout', message: '数字人生成超时，请检查 Duix 服务。' } }
    render(<AvatarChamber projectId="demo" scriptArtifactId="script-001" audioArtifactId="audio-001" onNext={() => undefined} onPrev={() => undefined} />)
    expect(screen.getByText('数字人生成超时，请检查 Duix 服务。')).toBeInTheDocument()
  })

  it.each(['recovering', 'running'] as const)('locks avatar mutations while the runtime is %s', async (status) => {
    mocks.listAssets.mockResolvedValue({ status: 'ok', source: 'avatar_asset', assets: [avatarAsset] })
    mocks.heygemState.status = status
    const user = userEvent.setup()
    render(<AvatarChamber projectId="demo" scriptArtifactId="script-001" audioArtifactId="audio-001" onNext={() => undefined} onPrev={() => undefined} />)

    expect(await screen.findByRole('button', { name: '生成' })).toBeDisabled()
    expect(screen.getByLabelText('更换数字人形象视频')).toBeDisabled()
    expect(screen.getByRole('button', { name: '删除形象 avatar.mp4' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'avatar.mp4' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '生成' }))
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(screen.getByText(status === 'recovering' ? '正在恢复并核验上次数字人任务…' : '正在驱动口型与表情，请稍候…')).toBeInTheDocument()
  })

  it('revokes completion when the verified video cannot be loaded', async () => {
    mocks.listAssets.mockResolvedValue({ status: 'ok', source: 'avatar_asset', assets: [avatarAsset] })
    setReadyRender('render-broken')
    render(<AvatarChamber projectId="demo" scriptArtifactId="script-001" audioArtifactId="audio-001" onNext={() => undefined} onPrev={() => undefined} />)

    const preview = await screen.findByLabelText('数字人生成视频预览')
    fireEvent.error(preview)

    expect(screen.queryByRole('button', { name: '下一步' })).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('当前无法读取')
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled()
  })

  it('calls next only after the verified video metadata loads', async () => {
    const onNext = vi.fn()
    setReadyRender('render-ready')
    const user = userEvent.setup()
    render(<AvatarChamber projectId="demo" scriptArtifactId="script-001" audioArtifactId="audio-001" onNext={onNext} onPrev={() => undefined} />)

    const preview = await screen.findByLabelText('数字人生成视频预览')
    await user.click(screen.getByRole('button', { name: '下一步' }))
    expect(onNext).not.toHaveBeenCalled()
    fireEvent.loadedMetadata(preview)
    await user.click(screen.getByRole('button', { name: '下一步' }))
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('does not let a stale avatar list from the previous project overwrite the current project', async () => {
    let resolveOld: ((value: unknown) => void) | undefined
    const oldRequest = new Promise((resolve) => { resolveOld = resolve })
    const currentAsset = { ...avatarAsset, assetId: 'avatar-current', projectId: 'project-b', originalFilename: 'current.mp4' }
    mocks.listAssets.mockImplementation((projectId: string) => projectId === 'project-a'
      ? oldRequest
      : Promise.resolve({ status: 'ok', source: 'avatar_asset', assets: [currentAsset] }))
    const view = render(<AvatarChamber projectId="project-a" scriptArtifactId="script-001" audioArtifactId="audio-001" onNext={() => undefined} onPrev={() => undefined} />)

    view.rerender(<AvatarChamber projectId="project-b" scriptArtifactId="script-001" audioArtifactId="audio-001" onNext={() => undefined} onPrev={() => undefined} />)
    expect(await screen.findByLabelText('形象预览 current.mp4')).toBeInTheDocument()

    resolveOld?.({ status: 'ok', source: 'avatar_asset', assets: [avatarAsset] })
    await waitFor(() => expect(screen.queryByText('avatar.mp4')).not.toBeInTheDocument())
    expect(screen.getAllByText('current.mp4').length).toBeGreaterThan(0)
  })

  it('blocks generation when the selected avatar video cannot be read', async () => {
    mocks.listAssets.mockResolvedValue({ status: 'ok', source: 'avatar_asset', assets: [avatarAsset] })
    render(<AvatarChamber projectId="demo" scriptArtifactId="script-001" audioArtifactId="audio-001" onNext={() => undefined} onPrev={() => undefined} />)

    fireEvent.error(await screen.findByLabelText('形象预览 avatar.mp4'))

    expect(screen.getByRole('button', { name: '生成' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('形象视频无法读取')
  })

  it('does not submit HeyGem until the runtime gate is ready', async () => {
    mocks.listAssets.mockResolvedValue({ status: 'ok', source: 'avatar_asset', assets: [avatarAsset] })
    mocks.ensureRuntimeReady.mockResolvedValue({
      ready: false,
      message: '数字人运行环境启动失败。',
      action: 'open_settings',
    })
    const user = userEvent.setup()
    render(<AvatarChamber projectId="demo" scriptArtifactId="script-001" audioArtifactId="audio-001" onNext={() => undefined} onPrev={() => undefined} />)

    await user.click(await screen.findByRole('button', { name: '生成' }))

    expect(mocks.ensureRuntimeReady).toHaveBeenCalledTimes(1)
    expect(mocks.generate).not.toHaveBeenCalled()
  })

  it('locks all avatar mutations while the runtime is preparing and opens settings from a blocked gate', async () => {
    mocks.listAssets.mockResolvedValue({ status: 'ok', source: 'avatar_asset', assets: [avatarAsset] })
    mocks.runtimeGateState.canGenerate = false
    mocks.runtimeGateState.preparing = true
    mocks.runtimeGateState.message = '正在准备数字人运行环境…'
    const view = render(<AvatarChamber projectId="demo" scriptArtifactId="script-001" audioArtifactId="audio-001" onNext={() => undefined} onPrev={() => undefined} />)

    expect(await screen.findByRole('button', { name: '生成' })).toBeDisabled()
    expect(screen.getByLabelText('更换数字人形象视频')).toBeDisabled()
    expect(screen.getByRole('button', { name: '删除形象 avatar.mp4' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'avatar.mp4' })).toBeDisabled()

    const onOpenSettings = vi.fn()
    mocks.runtimeGateState.preparing = false
    mocks.runtimeGateState.message = '尚未安装数字人运行环境。'
    mocks.runtimeGateState.action = 'open_settings'
    view.rerender(<AvatarChamber projectId="demo" scriptArtifactId="script-001" audioArtifactId="audio-001" onNext={() => undefined} onPrev={() => undefined} onOpenSettings={onOpenSettings} />)
    await userEvent.click(screen.getByRole('button', { name: '打开运行环境设置' }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })
})

function setReadyRender(artifactId: string) {
  mocks.heygemState.status = 'done'
  mocks.heygemState.task = { status: 'ready', artifactId }
  mocks.heygemState.artifact = {
    artifactId,
    projectId: 'demo',
    sessionId: 'avatar-session',
    status: 'ready',
    source: 'heygem',
  }
}
