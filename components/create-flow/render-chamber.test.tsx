// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RenderChamber } from './render-chamber'

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  state: {
    status: 'idle' as string,
    task: undefined as unknown,
    artifact: undefined as unknown,
    project: undefined as unknown,
  },
}))

vi.mock('next/image', () => ({
  default: ({ alt, src }: { alt: string; src: string }) => <img alt={alt} src={src} />,
}))

vi.mock('@/lib/post-production/use-post-production-agent', () => ({
  usePostProductionAgent: () => ({
    ...mocks.state,
    lastResult: undefined,
    run: mocks.run,
  }),
}))

beforeEach(() => {
  window.scrollTo = vi.fn()
  mocks.state.status = 'idle'
  mocks.state.task = undefined
  mocks.state.artifact = undefined
  mocks.state.project = undefined
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('RenderChamber', () => {
  it('submits one controlled EditPlan and previews the real output video', async () => {
    mocks.run.mockResolvedValue({
      status: 'ok',
      source: 'post_production_agent',
      artifact: {
        artifactId: 'post-001',
      },
      skillCall: {
        skillId: 'project:digital-human:post-production-cut-review',
        skillName: 'post-production-cut-review',
      },
    })
    const user = userEvent.setup()

    const view = render(
      <RenderChamber
        projectId="demo"
        renderArtifactId="render-001"
        onNext={() => undefined}
        onPrev={() => undefined}
      />,
    )

    const input = screen.getByPlaceholderText('告诉后期智能体要怎么剪，比如：加字幕并整理成片…')
    await user.type(input, '加字幕并整理成片')
    await user.click(screen.getByRole('button', { name: '发送' }))

    await waitFor(() => expect(mocks.run).toHaveBeenCalled())
    expect(mocks.run).toHaveBeenCalledWith({
      sessionId: 'post-session',
      input: expect.objectContaining({
        renderArtifactId: 'render-001',
        request: '加字幕并整理成片',
        mode: 'ai',
        plan: expect.objectContaining({
          version: 1,
          ratio: '9:16',
          subtitles: expect.objectContaining({ enabled: true, style: 'clean' }),
          audio: { voiceVolume: 1 },
          backgroundMusic: expect.objectContaining({ enabled: false }),
          cover: { timestampSeconds: 0 },
        }),
      }),
    })
    expect(screen.getByText('已生成后期成片 artifact：post-001')).toBeInTheDocument()
    expect(screen.queryByLabelText('最终成片预览')).not.toBeInTheDocument()
    mocks.state.status = 'done'
    mocks.state.artifact = { artifactId: 'post-001', status: 'ready' }
    view.rerender(
      <RenderChamber projectId="demo" renderArtifactId="render-001" onNext={() => undefined} onPrev={() => undefined} />,
    )
    expect(screen.getByLabelText('最终成片预览')).toHaveAttribute(
      'src',
      '/api/projects/demo/post-production-artifacts/post-001/file',
    )
    expect(screen.queryByRole('button', { name: '下一步' })).not.toBeInTheDocument()
    fireEvent.loadedMetadata(screen.getByLabelText('最终成片预览'))
    expect(screen.getByRole('button', { name: '下一步' })).toBeInTheDocument()
  })

  it('uses manual mode for the footer export button', async () => {
    mocks.run.mockResolvedValue({
      status: 'ok',
      source: 'post_production_agent',
      artifact: { artifactId: 'post-manual' },
      skillCall: { skillId: 'builtin', skillName: 'post-production-cut-review' },
    })
    const user = userEvent.setup()
    render(
      <RenderChamber
        projectId="demo"
        renderArtifactId="render-001"
        onNext={() => undefined}
        onPrev={() => undefined}
      />,
    )

    await user.click(screen.getByRole('button', { name: '手动导出' }))
    await waitFor(() => expect(mocks.run).toHaveBeenCalled())
    expect(mocks.run).toHaveBeenCalledWith({
      sessionId: 'post-session',
      input: expect.objectContaining({ mode: 'manual', request: '加字幕并整理成片' }),
    })
  })

  it('does not trust a prop-only artifact and restores only the verified hook artifact', () => {
    const view = render(
      <RenderChamber
        projectId="demo"
        renderArtifactId="render-001"
        postProductionArtifactId="post-existing"
        onNext={() => undefined}
        onPrev={() => undefined}
      />,
    )

    expect(screen.queryByLabelText('最终成片预览')).not.toBeInTheDocument()
    mocks.state.status = 'done'
    mocks.state.artifact = { artifactId: 'post-existing', status: 'ready' }
    view.rerender(
      <RenderChamber projectId="demo" renderArtifactId="render-001" postProductionArtifactId="post-existing" onNext={() => undefined} onPrev={() => undefined} />,
    )
    expect(screen.getByLabelText('最终成片预览')).toHaveAttribute(
      'src',
      '/api/projects/demo/post-production-artifacts/post-existing/file',
    )
  })
})
