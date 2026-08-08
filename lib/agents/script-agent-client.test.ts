import { describe, expect, it, vi } from 'vitest'
import { emptyScript, type ScriptDraft } from '@/lib/workspace'
import {
  buildScriptAgentMessage,
  buildScriptClarificationMessage,
  buildScriptRevisionMessage,
  configurationNoticeFromScriptAgentResult,
  createScriptAgentClient,
  mapScriptClarificationResultToDraft,
  mapScriptAgentResultToDraft,
  scriptAgentEndpoint,
} from './script-agent-client'

const okResponse = {
  status: 'ok',
  source: 'script_agent',
  artifact: {
    artifactId: 'script-001',
    content: {
      title: 'Codex 入门第一课',
      hook: '如果你刚开始接触 Codex，先把目标说清楚。',
      body: '第一步，是告诉它你要做什么、项目在哪里、希望它先检查什么。',
      caption: '从一句清楚的目标开始，让 AI 帮你推进任务。',
      tags: ['#Codex', '#AI编程'],
      durationSeconds: 30,
      voiceNotes: '自然、清晰、稳定。',
      shotNotes: '正面半身数字人口播，字幕分句出现。',
      riskNotes: '',
    },
  },
}

function scriptWithBrief(): ScriptDraft {
  return {
    ...emptyScript(),
    topic: '做一条 Codex 入门 30 秒口播',
    chatStage: 'chatting',
    messages: [
      {
        id: 'user-1',
        role: 'user',
        text: '做一条 Codex 入门 30 秒口播',
      },
      {
        id: 'ai-1',
        role: 'ai',
        text: '这条视频想让谁看？',
      },
    ],
  }
}

describe('script agent client', () => {
  it('builds the project script-agent endpoint', () => {
    expect(scriptAgentEndpoint('project-001')).toBe('/api/projects/project-001/script-agent')
  })

  it('builds script-agent endpoint against configured desktop local backend', () => {
    vi.stubEnv('NEXT_PUBLIC_DESKTOP_LOCAL_BACKEND_URL', 'http://127.0.0.1:3100')

    expect(scriptAgentEndpoint('project-001')).toBe('http://127.0.0.1:3100/api/projects/project-001/script-agent')

    vi.unstubAllEnvs()
  })

  it('builds an agent message from topic and chat history', () => {
    expect(buildScriptAgentMessage(scriptWithBrief())).toContain('视频主题：做一条 Codex 入门 30 秒口播')
    expect(buildScriptAgentMessage(scriptWithBrief())).toContain('用户：做一条 Codex 入门 30 秒口播')
  })

  it('builds a clarification message that requests machine-readable readiness', () => {
    const message = buildScriptClarificationMessage(scriptWithBrief(), '想做给新手看的视频')

    expect(message).toContain('请作为数字人口播文本智能体')
    expect(message).toContain('请返回 JSON')
    expect(message).toContain('ready_to_generate')
    expect(message).toContain('用户本轮输入：想做给新手看的视频')
  })

  it('builds a revision message with current script fields and user instruction', () => {
    const script = {
      ...scriptWithBrief(),
      title: '旧标题',
      hook: '旧钩子',
      body: '旧正文',
      caption: '旧平台文案',
      tags: ['#旧标签'],
      generated: true,
      chatStage: 'generated' as const,
    }

    const message = buildScriptRevisionMessage(script, '改得更口语，保留 Codex 关键词')

    expect(message).toContain('修改要求：改得更口语，保留 Codex 关键词')
    expect(message).toContain('标题：旧标题')
    expect(message).toContain('口播正文：旧正文')
  })

  it('maps ok script-agent responses into ScriptDraft fields', () => {
    const mapped = mapScriptAgentResultToDraft(scriptWithBrief(), okResponse, {
      messageId: 'ai-generated',
    })

    expect(mapped).toMatchObject({
      chatStage: 'generated',
      generated: true,
      title: 'Codex 入门第一课',
      hook: '如果你刚开始接触 Codex，先把目标说清楚。',
      body: '第一步，是告诉它你要做什么、项目在哪里、希望它先检查什么。',
      caption: '从一句清楚的目标开始，让 AI 帮你推进任务。',
      tags: ['#Codex', '#AI编程'],
      duration: '30 秒',
      artifactId: 'script-001',
    })
    expect(mapped.messages.at(-1)).toEqual({
      id: 'ai-generated',
      role: 'ai',
      text: '我已生成左侧文案。你可以继续手动编辑，确认后进入下一步。',
    })
  })

  it('maps clarification responses into chat messages without generated artifact state', () => {
    const mapped = mapScriptClarificationResultToDraft(
      scriptWithBrief(),
      {
        status: 'ok',
        source: 'script_agent',
        turnType: 'clarify',
        reply: '这条视频主要给新手看，还是给已有经验的创作者看？',
        clarification: {
          readiness: 'needs_more_context',
          canGenerate: false,
        },
      },
      { messageId: 'ai-clarify' },
    )

    expect(mapped).toMatchObject({
      chatStage: 'chatting',
      generated: false,
    })
    expect(mapped.messages.at(-1)).toEqual({
      id: 'ai-clarify',
      role: 'ai',
      text: '这条视频主要给新手看，还是给已有经验的创作者看？',
    })
  })

  it('maps ready clarification responses into actionable chat messages', () => {
    const mapped = mapScriptClarificationResultToDraft(
      scriptWithBrief(),
      {
        status: 'ok',
        source: 'script_agent',
        turnType: 'clarify',
        reply: '信息已经够了，我可以开始写第一版文案。',
        clarification: {
          readiness: 'ready_to_generate',
          canGenerate: true,
        },
      },
      { messageId: 'ai-ready' },
    )

    expect(mapped.messages.at(-1)?.text).toContain('信息已经够了')
    expect(mapped.messages.at(-1)?.text).toContain('可以点击“生成文案”')
  })


  it('maps needs_configuration into an actionable chat message', () => {
    const mapped = mapScriptAgentResultToDraft(
      scriptWithBrief(),
      {
        status: 'needs_configuration',
        source: 'script_agent',
        error: {
          code: 'unsupported_node_version',
          message: '本地后端需要 Node >= 22.19.0',
        },
      },
      { messageId: 'ai-error' },
    )

    expect(mapped.chatStage).toBe('chatting')
    expect(mapped.generated).toBe(false)
    expect(mapped.messages.at(-1)?.text).toContain('需要先完成 AI 后端配置')
    expect(mapped.messages.at(-1)?.text).toContain('unsupported_node_version')
  })

  it('maps provider configuration errors into user-facing recovery notices', () => {
    expect(
      configurationNoticeFromScriptAgentResult({
        status: 'needs_configuration',
        source: 'script_agent',
        error: {
          code: 'missing_credentials',
          message: 'Provider「OpenAI API」需要 API Key。',
        },
      }),
    ).toMatchObject({
      title: '默认模型 Provider 缺少凭据',
      action: expect.stringContaining('顶部设置页'),
      errorCode: 'missing_credentials',
    })

    expect(
      configurationNoticeFromScriptAgentResult({
        status: 'needs_configuration',
        source: 'script_agent',
        error: {
          code: 'unsupported_node_version',
          message: '本地后端需要 Node >= 22.19.0，当前是 20.20.0',
        },
      }),
    ).toMatchObject({
      title: 'AI 后端需要先完成配置',
      action: expect.stringContaining('本地后端'),
      errorCode: 'unsupported_node_version',
    })
  })

  it('maps script_parse_error into a recoverable chat message', () => {
    const mapped = mapScriptAgentResultToDraft(
      scriptWithBrief(),
      {
        status: 'script_parse_error',
        source: 'script_agent',
        error: {
          code: 'script_parse_error',
          message: 'Pi 回复 JSON 格式无效',
        },
      },
      { messageId: 'ai-parse-error' },
    )

    expect(mapped.messages.at(-1)?.text).toContain('没有拿到可写入左侧的结构化文案')
  })

  it('posts to script-agent API with draft approval status', async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify(okResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const client = createScriptAgentClient(fetcher)

    await expect(
      client.generate({
        projectId: 'project-001',
        message: '做一条 Codex 入门 30 秒口播',
        turnType: 'clarify',
        approvalStatus: 'draft',
        artifactId: 'script-001',
      }),
    ).resolves.toEqual(okResponse)

    expect(fetcher).toHaveBeenCalledWith('/api/projects/project-001/script-agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: '做一条 Codex 入门 30 秒口播',
        turnType: 'clarify',
        promptName: 'script',
        approvalStatus: 'draft',
        artifactId: 'script-001',
      }),
    })
  })

  it('patches script-agent API to approve an existing artifact', async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({
        status: 'ok',
        source: 'script_agent',
        artifact: {
          artifactId: 'script-001',
          approvalStatus: 'approved',
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const client = createScriptAgentClient(fetcher)

    await expect(
      client.approve({
        projectId: 'project-001',
        artifactId: 'script-001',
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      artifact: {
        approvalStatus: 'approved',
      },
    })

    expect(fetcher).toHaveBeenCalledWith('/api/projects/project-001/script-agent', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        artifactId: 'script-001',
      }),
    })
  })

  it('returns desktop_backend_missing when script-agent API cannot be reached', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    const client = createScriptAgentClient(fetcher)

    await expect(
      client.generate({
        projectId: 'project-001',
        message: '做一条 Codex 入门 30 秒口播',
        approvalStatus: 'draft',
      }),
    ).resolves.toMatchObject({
      status: 'agent_error',
      source: 'desktop_runtime',
      error: {
        code: 'desktop_backend_missing',
      },
    })
  })
})
