// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Dashboard } from './dashboard'

describe('Dashboard workspace recovery', () => {
  it('shows a recoverable error instead of the empty-project state', () => {
    const retry = vi.fn()
    render(
      <Dashboard
        projects={[]}
        ready
        workspaceStatus="error"
        workspaceError={{ code: 'project_read_failed', message: '本地项目读取失败。' }}
        onRetry={retry}
        onCreate={vi.fn()}
      />,
    )

    expect(screen.getByText('项目列表读取失败')).toBeTruthy()
    expect(screen.queryByText('还没有口播项目')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重新读取' }))
    expect(retry).toHaveBeenCalledOnce()
  })

  it('warns about a degraded list without hiding valid projects', () => {
    render(
      <Dashboard
        projects={[{
          id: 'project-valid', title: '可用项目', cover: '', status: 'editing', duration: '00:30',
          updatedAt: '刚刚', platforms: ['抖音'], step: 1,
        }]}
        ready
        workspaceStatus="degraded"
        workspaceError={{ code: 'invalid_project_state', message: '项目数据已损坏，暂时无法打开。' }}
        onRetry={vi.fn()}
        onCreate={vi.fn()}
      />,
    )

    expect(screen.getByText('部分项目未能读取')).toBeTruthy()
    expect(screen.getByText('可用项目')).toBeTruthy()
    expect(screen.getByAltText('可用项目').getAttribute('src')).toContain('project-cover-placeholder.svg')
  })
})
