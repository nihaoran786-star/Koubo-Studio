// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenChatCutProfessionalEntry } from './openchatcut-professional-entry'

const mocks = vi.hoisted(() => ({
  getProject: vi.fn(),
  mutateProject: vi.fn(),
  mutateRuntime: vi.fn(),
}))

vi.mock('@/lib/openchatcut/client', () => ({
  getOpenChatCutProjectClient: mocks.getProject,
  mutateOpenChatCutProjectClient: mocks.mutateProject,
  mutateOpenChatCutRuntimeClient: mocks.mutateRuntime,
}))

const bridge = {
  phase: 'needs_user_import' as const,
  openChatCutProjectId: 'occ-project-1',
  editorUrl: 'http://127.0.0.1:5199/#/editor/occ-project-1',
  sourceVideoUrl: '/api/projects/demo/render-artifacts/render-1/file',
  sourceDurationSeconds: 12,
  sourceArtifactKind: 'render' as const,
  sourceArtifactId: 'render-1',
  scriptArtifactId: 'script-1',
  instructions: ['请导入视频。'],
}

describe('OpenChatCutProfessionalEntry', () => {
  beforeEach(() => {
    mocks.getProject.mockResolvedValue({ status: 'ok', source: 'openchatcut' })
    mocks.mutateRuntime.mockResolvedValue({
      status: 'ok',
      source: 'openchatcut',
      runtime: { mcpReady: true },
    })
    mocks.mutateProject.mockReset()
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('stops immediately when launching the app fails', async () => {
    mocks.mutateRuntime.mockResolvedValueOnce({
      status: 'error',
      source: 'openchatcut',
      error: { code: 'mcp_start_timeout', message: '启动超时' },
    })
    render(<OpenChatCutProfessionalEntry projectId="demo" videoReady />)
    await userEvent.click(screen.getByRole('button', { name: '进入专业精剪' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('启动超时'))
    expect(mocks.mutateProject).not.toHaveBeenCalled()
  })

  it('restores an imported bridge and sends one request that directly enters review', async () => {
    mocks.getProject.mockResolvedValueOnce({
      status: 'ok',
      source: 'openchatcut',
      bridge: { ...bridge, phase: 'ready_to_draft' },
    })
    mocks.mutateProject.mockResolvedValueOnce({
      status: 'ok',
      source: 'openchatcut',
      bridge: {
        ...bridge,
        phase: 'needs_review',
        editSessionId: 'edit-session-1',
        instructions: ['请审核草案。'],
      },
    })
    render(<OpenChatCutProfessionalEntry projectId="demo" videoReady />)
    expect(await screen.findByRole('link', { name: '打开剪辑台' })).toHaveAttribute('href', bridge.editorUrl)
    await userEvent.clear(screen.getByLabelText('精剪要求'))
    await userEvent.type(screen.getByLabelText('精剪要求'), '突出前三秒')
    await userEvent.click(screen.getByRole('button', { name: '生成 AI 草案' }))
    await waitFor(() => expect(screen.getByText('待审核')).toBeInTheDocument())
    expect(mocks.mutateProject).toHaveBeenCalledWith('demo', expect.objectContaining({
      action: 'begin',
      request: '突出前三秒',
    }))
    expect(screen.queryByRole('button', { name: '提交审核' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '刷新审核状态' })).toBeInTheDocument()
  })

  it('offers honest automatic and manual import paths', async () => {
    mocks.getProject.mockResolvedValueOnce({ status: 'ok', source: 'openchatcut', bridge })
    render(<OpenChatCutProfessionalEntry projectId="demo" videoReady />)
    expect(await screen.findByRole('button', { name: '自动导入当前视频' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '已手动导入，校验并生成草案' })).toBeInTheDocument()
    expect(screen.getByText(/不会伪装导入成功/)).toBeInTheDocument()
  })

  it('polls an exporting bridge with GET only and never starts a second export', async () => {
    mocks.getProject
      .mockResolvedValueOnce({
        status: 'ok',
        source: 'openchatcut',
        bridge: { ...bridge, phase: 'exporting', instructions: ['正在导出。'] },
      })
      .mockResolvedValueOnce({
        status: 'ok',
        source: 'openchatcut',
        bridge: {
          ...bridge,
          phase: 'exported',
          exportedArtifactId: 'openchatcut-export-1',
          exportedVideoUrl: '/api/openchatcut-export-1.mp4',
          instructions: ['导出完成。'],
        },
      })
    render(<OpenChatCutProfessionalEntry projectId="demo" videoReady />)
    expect(await screen.findByText('已导回项目')).toBeInTheDocument()
    expect(mocks.getProject).toHaveBeenCalledTimes(2)
    expect(mocks.mutateProject).not.toHaveBeenCalled()
    expect(screen.getByLabelText('OpenChatCut 导出成片预览')).toHaveAttribute(
      'src',
      '/api/openchatcut-export-1.mp4',
    )
  })
})
