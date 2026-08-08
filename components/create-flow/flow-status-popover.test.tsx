// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FlowStatusPopover } from './flow-status-popover'

const refresh = vi.fn()
const timelineState = {
  loading: false,
  result: {
    status: 'ok' as const,
    source: 'agent_session_timeline' as const,
    items: [],
  },
  refresh,
}

vi.mock('@/lib/agents/use-agent-session-timeline', () => ({
  useAgentSessionTimeline: () => timelineState,
}))

describe('FlowStatusPopover', () => {
  afterEach(cleanup)

  beforeEach(() => {
    refresh.mockReset()
    timelineState.loading = false
    timelineState.result = {
      status: 'ok',
      source: 'agent_session_timeline',
      items: [],
    }
  })

  it('keeps details out of layout until the compact status icon is opened', () => {
    renderStatus()

    expect(screen.queryByRole('dialog', { name: '创作状态详情' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '创作状态：有环境提示' }))

    expect(screen.getByRole('dialog', { name: '创作状态详情' })).toBeInTheDocument()
    expect(screen.getByText('生产链路')).toBeInTheDocument()
    expect(screen.getByText('环境检查')).toBeInTheDocument()
    expect(screen.getByText('AI 文案服务暂不可用')).toBeInTheDocument()
  })

  it('opens settings from the overlay and closes without occupying page space', async () => {
    const onOpenSettings = vi.fn()
    renderStatus(onOpenSettings)
    fireEvent.click(screen.getByRole('button', { name: '创作状态：有环境提示' }))
    fireEvent.click(screen.getByRole('button', { name: '打开设置' }))

    expect(onOpenSettings).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '创作状态详情' })).not.toBeInTheDocument())
  })

  it('closes on Escape and refreshes the production chain on demand', async () => {
    renderStatus()
    fireEvent.click(screen.getByRole('button', { name: '创作状态：有环境提示' }))
    fireEvent.click(screen.getByRole('button', { name: '刷新创作状态' }))
    expect(refresh).toHaveBeenCalledWith('project-1')

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '创作状态详情' })).not.toBeInTheDocument())
  })
})

function renderStatus(onOpenSettings = vi.fn()) {
  return render(
    <FlowStatusPopover
      projectId="project-1"
      runtimeNotices={[
        {
          id: 'desktop',
          title: '桌面后端提示',
          message: '请检查本地后端。',
          tone: 'warning',
        },
      ]}
      activeRuntimeNotice={{
        id: 'provider',
        title: 'AI 文案服务暂不可用',
        message: '尚未配置 Provider。',
        action: '到设置页测试连接。',
        actionLabel: '打开设置',
        tone: 'warning',
      }}
      isDesktopShell
      onOpenSettings={onOpenSettings}
    />,
  )
}
