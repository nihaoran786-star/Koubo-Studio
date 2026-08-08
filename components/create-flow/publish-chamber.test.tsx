// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScriptDraft } from '@/lib/workspace'
import { PublishChamber } from './publish-chamber'

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(async () => ({ status: 'ready', artifact: { artifactId: 'publish-001' } })),
  checkHealth: vi.fn(async () => ({ status: 'manual_required' })),
  load: vi.fn(async () => ({ status: 'ready', artifact: { artifactId: 'publish-001' } })),
  browserLoad: vi.fn(),
}))

vi.mock('@/lib/publish/use-publish-agent', () => ({
  usePublishAgent: () => ({
    status: 'idle',
    lastResult: undefined,
    health: { status: 'manual_required' },
    prepare: mocks.prepare,
    checkHealth: mocks.checkHealth,
    load: mocks.load,
  }),
}))

vi.mock('@/lib/publish/use-browser-publish', () => ({
  useBrowserPublish: () => ({
    snapshot: { status: 'idle', source: 'visible_browser', updatedAt: '2026-07-16T00:00:00.000Z' },
    busy: false,
    load: mocks.browserLoad,
    open: vi.fn(),
    refresh: vi.fn(),
    fill: vi.fn(),
    close: vi.fn(),
  }),
}))

afterEach(() => {
  cleanup()
  mocks.prepare.mockClear()
  mocks.checkHealth.mockClear()
  mocks.load.mockClear()
  mocks.browserLoad.mockClear()
})

const script: ScriptDraft = {
  artifactId: 'script-001',
  approvalStatus: 'approved',
  topic: '测试主题',
  platforms: ['抖音', '小红书'],
  duration: '30 秒',
  tone: '自然',
  chatStage: 'generated',
  messages: [],
  title: '测试标题',
  hook: '开头',
  body: '正文',
  caption: '发布正文',
  tags: ['#口播'],
  generated: true,
  updatedAt: '2026-07-15T00:00:00.000Z',
}

describe('PublishChamber', () => {
  it('shows only douyin and xiaohongshu local package preparation', () => {
    render(<PublishChamber projectId="project-001" postProductionArtifactId="post-001" script={script} onPrev={vi.fn()} />)

    expect(screen.getByRole('button', { name: /抖音/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /小红书/ })).toBeTruthy()
    expect(screen.getByText('先生成本地发布包，再打开可见浏览器自动填写。登录、验证码和最终发布由你监督并确认。')).toBeTruthy()
    expect(screen.queryByText(/发布成功/)).toBeNull()
  })

  it('submits a local package request for the two supported platforms', async () => {
    const user = userEvent.setup()
    render(<PublishChamber projectId="project-001" postProductionArtifactId="post-001" script={script} onPrev={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '准备发布包' }))
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        platforms: ['douyin', 'xiaohongshu'],
      }),
    }))
  })

  it('reloads the selected publish package when returning to the page', () => {
    render(
      <PublishChamber
        projectId="project-001"
        postProductionArtifactId="post-001"
        selectedPublishPackageArtifactId="publish-001"
        script={script}
        onPrev={vi.fn()}
      />,
    )

    expect(mocks.load).toHaveBeenCalledWith('publish-001')
  })
})
