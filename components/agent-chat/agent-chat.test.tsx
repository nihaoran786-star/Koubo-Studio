// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentChat, type AgentChatMessage } from './agent-chat'

const messages: AgentChatMessage[] = [
  { id: 'system-1', type: 'system', text: '数字人文案智能体已就绪' },
  { id: 'user-1', type: 'user', text: '做一条 Codex 入门视频' },
  { id: 'assistant-1', type: 'assistant', text: '这条视频想让谁看？' },
  {
    id: 'tool-1',
    type: 'tool',
    title: '读取项目上下文',
    text: 'CONTEXT.md',
    status: 'running',
  },
  {
    id: 'skill-1',
    type: 'skill',
    title: '精剪计划',
    text: '正在生成受控剪辑计划',
    status: 'done',
  },
]

afterEach(() => {
  cleanup()
})

describe('AgentChat', () => {
  it('renders one lightweight loading indicator without adding a call card', () => {
    render(
      <AgentChat
        messages={[]}
        input=""
        loading
        onInputChange={() => undefined}
        onSend={() => undefined}
      />,
    )

    expect(screen.getAllByRole('status', { name: 'AI 正在处理' })).toHaveLength(1)
    expect(screen.queryByText(/工具调用|Skill 调用|运行中|已完成/)).not.toBeInTheDocument()
  })

  it('renders messages and reduces a running tool call to a loading indicator', () => {
    render(
      <AgentChat
        messages={messages}
        input=""
        onInputChange={() => undefined}
        onSend={() => undefined}
      />,
    )

    expect(screen.getByText('数字人文案智能体已就绪')).toBeInTheDocument()
    expect(screen.getByText('做一条 Codex 入门视频')).toBeInTheDocument()
    expect(screen.getByText('这条视频想让谁看？')).toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'AI 正在处理' })).toBeInTheDocument()
    expect(screen.queryByText('读取项目上下文')).not.toBeInTheDocument()
    expect(screen.queryByText('运行中')).not.toBeInTheDocument()
    expect(screen.getByText('精剪计划')).toBeInTheDocument()
    expect(screen.getByText('已完成')).toBeInTheDocument()
  })

  it('removes completed tool calls from the conversation', () => {
    render(
      <AgentChat
        messages={[
          {
            id: 'tool-done',
            type: 'tool',
            title: '文案处理',
            text: '已完成澄清回合，结果已写回右侧对话。',
            status: 'done',
          },
        ]}
        input=""
        onInputChange={() => undefined}
        onSend={() => undefined}
      />,
    )

    expect(screen.queryByText('工具调用 · Pi script-agent')).not.toBeInTheDocument()
    expect(screen.queryByText('已完成澄清回合，结果已写回右侧对话。')).not.toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'AI 正在处理' })).not.toBeInTheDocument()
  })

  it('sends text from the input', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()

    render(
      <AgentChat
        messages={[]}
        input="补充目标用户"
        onInputChange={() => undefined}
        onSend={onSend}
      />,
    )

    await user.click(screen.getByRole('button', { name: '发送' }))

    expect(onSend).toHaveBeenCalledWith('补充目标用户')
  })

  it('disables input and send while the agent is busy', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    const onInputChange = vi.fn()

    render(
      <AgentChat
        messages={[]}
        input="补充目标用户"
        disabled
        onInputChange={onInputChange}
        onSend={onSend}
      />,
    )

    expect(screen.getByPlaceholderText('补充目标用户、语气或重点…')).toBeDisabled()
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: '发送' }))

    expect(onInputChange).not.toHaveBeenCalled()
    expect(onSend).not.toHaveBeenCalled()
  })
})
