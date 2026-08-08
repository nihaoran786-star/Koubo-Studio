// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyScript, type ScriptDraft } from '@/lib/workspace'
import { IdeaChamber } from './idea-chamber'

const mocks = vi.hoisted(() => ({
  clarifyDraft: vi.fn(),
  generateDraft: vi.fn(),
  reviseDraft: vi.fn(),
  approveDraft: vi.fn(),
  providerSettings: {
    defaultProviderId: 'deepseek',
    telemetryEnabled: false,
    providers: [{
      id: 'deepseek', kind: 'deepseek', name: 'DeepSeek API', enabled: true,
      baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', status: 'connected',
      hasApiKey: true, apiKeyPreview: '', authMode: 'api_key', requiresApiKey: true,
      dataLocation: 'cloud_provider', note: '', apiKeyInput: '',
    }],
  },
}))

vi.mock('@/lib/agents/use-script-agent', () => ({
  useScriptAgent: () => ({
    status: 'idle',
    lastResult: undefined,
    clarifyDraft: mocks.clarifyDraft,
    generateDraft: mocks.generateDraft,
    reviseDraft: mocks.reviseDraft,
    approveDraft: mocks.approveDraft,
  }),
}))

vi.mock('@/lib/model-providers/use-model-provider-settings', () => ({
  useModelProviderSettings: () => ({
    status: 'ready', busy: false, settings: mocks.providerSettings, error: null,
    updateProviderDraft: vi.fn(), saveProvider: vi.fn(), runProviderTest: vi.fn(),
  }),
}))

beforeEach(() => {
  window.scrollTo = vi.fn()
  mocks.providerSettings = {
    defaultProviderId: 'deepseek', telemetryEnabled: false,
    providers: [{
      id: 'deepseek', kind: 'deepseek', name: 'DeepSeek API', enabled: true,
      baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', status: 'connected',
      hasApiKey: true, apiKeyPreview: '', authMode: 'api_key', requiresApiKey: true,
      dataLocation: 'cloud_provider', note: '', apiKeyInput: '',
    }],
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('IdeaChamber', () => {
  it('uses the current non-DeepSeek default provider name in the missing-key dialog', async () => {
    mocks.providerSettings = {
      defaultProviderId: 'openai', telemetryEnabled: false,
      providers: [{
        id: 'openai', kind: 'openai', name: 'OpenAI API', enabled: true,
        baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', status: 'missing_credentials',
        hasApiKey: false, apiKeyPreview: '', authMode: 'api_key', requiresApiKey: true,
        dataLocation: 'cloud_provider', note: '', apiKeyInput: '',
      }],
    }
    render(<IdeaChamber projectId="demo" script={emptyScript()} onChange={() => undefined} onNext={() => undefined} />)
    expect(await screen.findByRole('dialog')).toHaveTextContent('当前默认使用 OpenAI API')
    expect(screen.getByLabelText('OpenAI API API Key')).toBeInTheDocument()
    expect(screen.queryByText('默认使用 DeepSeek')).not.toBeInTheDocument()
  })

  it('sends the first brief directly without requesting or displaying slash skills', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const script = emptyScript()
    mocks.clarifyDraft.mockImplementation(async (draft: ScriptDraft) => ({
      draft: {
        ...draft,
        messages: [
          ...draft.messages,
          {
            id: 'ai-clarify-001',
            role: 'ai',
            text: '这条视频想让谁看？',
          },
        ],
      },
      result: {
        status: 'ok',
        source: 'script_agent',
        turnType: 'clarify',
        reply: '这条视频想让谁看？',
        clarification: {
          readiness: 'needs_more_context',
          canGenerate: false,
        },
      },
    }))

    render(
      <IdeaChamber
        projectId="demo"
        script={script}
        onChange={onChange}
        onNext={() => undefined}
      />,
    )

    const input = screen.getByPlaceholderText('例如：做一条介绍 Codex 入门的 30 秒口播视频')
    await user.type(input, '/')
    expect(screen.queryByRole('button', { name: /mixed-language-probe/ })).not.toBeInTheDocument()
    await user.clear(input)
    await user.type(input, '做一条 Codex API 入门视频')
    await user.click(screen.getByRole('button', { name: '发送' }))

    await waitFor(() => expect(mocks.clarifyDraft).toHaveBeenCalled())
    expect(mocks.clarifyDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: '做一条 Codex API 入门视频',
        chatStage: 'chatting',
        messages: [
          expect.objectContaining({
            role: 'user',
            text: '做一条 Codex API 入门视频',
          }),
        ],
      }),
      '做一条 Codex API 入门视频',
    )
    expect(screen.queryByText('Skill 调用 · mixed-language-probe')).not.toBeInTheDocument()
    expect(screen.queryByText('工具调用 · Pi script-agent')).not.toBeInTheDocument()
    expect(screen.queryByText('已完成')).not.toBeInTheDocument()
  })

  it('shows configuration guidance without exposing tool or skill call cards', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const onOpenSettings = vi.fn()
    const script = emptyScript()
    mocks.clarifyDraft.mockImplementation(async (draft: ScriptDraft) => ({
      draft: {
        ...draft,
        chatStage: 'chatting',
        messages: [
          ...draft.messages,
          {
            id: 'ai-error-001',
            role: 'ai',
            text: '需要先完成 AI 后端配置（no_default_provider）：还没有默认模型 Provider',
          },
        ],
      },
      result: {
        status: 'needs_configuration',
        source: 'script_agent',
        error: {
          code: 'no_default_provider',
          message: '还没有默认模型 Provider',
        },
      },
    }))

    render(
      <IdeaChamber
        projectId="demo"
        script={script}
        onChange={onChange}
        onNext={() => undefined}
        onOpenSettings={onOpenSettings}
      />,
    )

    const input = screen.getByPlaceholderText('例如：做一条介绍 Codex 入门的 30 秒口播视频')
    await user.type(input, '做一条 Codex API 入门视频')
    await user.click(screen.getByRole('button', { name: '发送' }))

    await waitFor(() => expect(mocks.clarifyDraft).toHaveBeenCalled())
    expect(screen.queryByText('Skill 调用 · mixed-language-probe')).not.toBeInTheDocument()
    expect(screen.queryByText('工具调用 · Pi script-agent')).not.toBeInTheDocument()
    expect(screen.queryByText('失败')).not.toBeInTheDocument()
    expect(screen.getAllByText('还没有默认模型 Provider').length).toBeGreaterThanOrEqual(1)
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('offers an inline generate action when the clarification turn is ready', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const script = emptyScript()
    mocks.clarifyDraft.mockImplementation(async (draft: ScriptDraft) => ({
      draft: {
        ...draft,
        chatStage: 'chatting',
        messages: [
          ...draft.messages,
          {
            id: 'ai-ready-001',
            role: 'ai',
            text: '信息够了，可以生成第一版文案。',
          },
        ],
      },
      result: {
        status: 'ok',
        source: 'script_agent',
        turnType: 'clarify',
        reply: '信息够了，可以生成第一版文案。',
        clarification: {
          readiness: 'ready_to_generate',
          canGenerate: true,
        },
      },
    }))
    mocks.generateDraft.mockImplementation(async (draft: ScriptDraft) => ({
      draft: {
        ...draft,
        chatStage: 'generated',
        generated: true,
        title: 'Codex API 入门',
        hook: '先说结论。',
        body: '这是正文。',
        caption: '这是平台文案。',
        tags: ['Codex'],
      },
      result: {
        status: 'ok',
        source: 'script_agent',
        turnType: 'generate_artifact',
        artifact: {
          artifactId: 'script-001',
          content: {
            title: 'Codex API 入门',
            hook: '先说结论。',
            body: '这是正文。',
            caption: '这是平台文案。',
            tags: ['Codex'],
            durationSeconds: 30,
            voiceNotes: '',
            shotNotes: '',
            riskNotes: '',
          },
        },
      },
    }))

    render(
      <IdeaChamber
        projectId="demo"
        script={script}
        onChange={onChange}
        onNext={() => undefined}
      />,
    )

    const input = screen.getByPlaceholderText('例如：做一条介绍 Codex 入门的 30 秒口播视频')
    await user.type(input, '做一条 Codex API 入门视频')
    await user.click(screen.getByRole('button', { name: '发送' }))

    await waitFor(() => expect(screen.getByRole('button', { name: '生成左侧文案' })).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: '生成左侧文案' }))

    await waitFor(() => expect(mocks.generateDraft).toHaveBeenCalled())
    expect(mocks.generateDraft).toHaveBeenCalledWith(expect.objectContaining({
      topic: '做一条 Codex API 入门视频',
      chatStage: 'chatting',
    }))
  })
})
