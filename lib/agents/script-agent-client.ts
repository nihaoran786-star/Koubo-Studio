import type { ScriptDraft } from '@/lib/workspace'
import type { ScriptApprovalStatus, ScriptArtifactContent } from '@/lib/artifacts/script-artifact'
import { buildProjectApiEndpoint } from '@/lib/api/api-endpoint'
import { requestJson } from '@/lib/api/api-fetch'

export type ScriptAgentClientStatus =
  | 'idle'
  | 'running'
  | 'approving'
  | 'done'
  | 'needs_configuration'
  | 'script_parse_error'
  | 'agent_error'

export type ScriptAgentClientResult =
  | {
      status: 'ok'
      source: 'script_agent'
      turnType?: 'generate_artifact'
      artifact: {
        artifactId: string
        content: ScriptArtifactContent
      }
      error?: never
    }
  | {
      status: 'ok'
      source: 'script_agent'
      turnType: 'clarify'
      reply: string
      clarification: ScriptClarificationState
      artifact?: never
      error?: never
    }
  | {
      status: 'needs_configuration' | 'script_parse_error' | 'agent_error' | 'invalid_request'
      source: string
      artifact?: never
      error?: {
        code: string
        message: string
      }
    }

export type ScriptApprovalClientResult =
  | {
      status: 'ok'
      source: 'script_agent'
      artifact: {
        artifactId: string
        approvalStatus: 'approved'
      }
      error?: never
    }
  | {
      status: 'invalid_request' | 'artifact_error'
      source: string
      artifact?: never
      error: {
        code: string
        message: string
      }
    }

export interface ScriptAgentConfigurationNotice {
  title: string
  detail: string
  action: string
  errorCode: string
}

export interface ScriptAgentClientInput {
  projectId: string
  message: string
  turnType?: 'clarify' | 'generate_artifact'
  approvalStatus: ScriptApprovalStatus
  promptName?: string
  artifactId?: string
}

export interface ScriptClarificationState {
  readiness: 'needs_more_context' | 'ready_to_generate' | 'unknown'
  canGenerate: boolean
}

type Fetcher = typeof fetch

export function scriptAgentEndpoint(projectId: string) {
  return buildProjectApiEndpoint(projectId, '/script-agent')
}

export function createScriptAgentClient(fetcher: Fetcher = fetch) {
  return {
    generate: async function requestScriptAgent(input: ScriptAgentClientInput): Promise<ScriptAgentClientResult> {
      return requestJson<ScriptAgentClientResult>(scriptAgentEndpoint(input.projectId), {
        fetcher,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            message: input.message,
            turnType: input.turnType ?? 'generate_artifact',
            promptName: input.promptName ?? 'script',
            approvalStatus: input.approvalStatus,
            artifactId: input.artifactId,
          }),
        },
        fallback: (error) => ({
          status: 'agent_error',
          source: 'desktop_runtime',
          error,
        }),
      })
    },
    approve: async function approveScript(input: {
      projectId: string
      artifactId: string
    }): Promise<ScriptApprovalClientResult> {
      return requestJson<ScriptApprovalClientResult>(scriptAgentEndpoint(input.projectId), {
        fetcher,
        init: {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            artifactId: input.artifactId,
          }),
        },
        fallback: (error) => ({
          status: 'artifact_error',
          source: 'desktop_runtime',
          error,
        }),
      })
    },
  }
}

export function buildScriptAgentMessage(script: ScriptDraft) {
  const lines = [
    `视频主题：${script.topic || '未提供'}`,
    `目标平台：${script.platforms.join('、')}`,
    `时长：${script.duration}`,
    `语气：${script.tone}`,
    '',
    '聊天记录：',
    ...script.messages.map((message) => `${message.role === 'user' ? '用户' : 'AI'}：${message.text}`),
  ]
  return lines.join('\n')
}

export function buildScriptClarificationMessage(script: ScriptDraft, userMessage: string) {
  const lines = [
    '请作为数字人口播文本智能体，继续澄清用户要做的视频。',
    '目标：通过一到两个关键问题确认受众、语气、卖点、平台限制或下一步是否可以生成文案。',
    '请返回 JSON，格式为 {"reply":"右侧聊天框显示给用户的自然语言","readiness":"needs_more_context 或 ready_to_generate"}。',
    '如果信息已经足够生成第一版文案，readiness 必须是 ready_to_generate；否则是 needs_more_context。',
    '',
    `用户本轮输入：${userMessage}`,
    '',
    '当前项目状态：',
    `视频主题：${script.topic || userMessage || '未提供'}`,
    `目标平台：${script.platforms.join('、')}`,
    `时长：${script.duration}`,
    `语气：${script.tone}`,
    '',
    '聊天记录：',
    ...script.messages.map((message) => `${message.role === 'user' ? '用户' : 'AI'}：${message.text}`),
  ]
  return lines.join('\n')
}

export function buildScriptRevisionMessage(script: ScriptDraft, instruction: string) {
  const lines = [
    '请根据用户新的修改要求，改写当前数字人口播文案。',
    '',
    `修改要求：${instruction}`,
    '',
    '当前文案：',
    `标题：${script.title || '未生成'}`,
    `开头钩子：${script.hook || '未生成'}`,
    `口播正文：${script.body || '未生成'}`,
    `平台文案：${script.caption || '未生成'}`,
    `标签：${script.tags.join('、') || '无'}`,
    `时长：${script.duration}`,
    `语气：${script.tone}`,
    '',
    '聊天记录：',
    ...script.messages.map((message) => `${message.role === 'user' ? '用户' : 'AI'}：${message.text}`),
  ]
  return lines.join('\n')
}

export function mapScriptClarificationResultToDraft(
  script: ScriptDraft,
  result: ScriptAgentClientResult | Record<string, unknown>,
  options: { messageId: string },
): ScriptDraft {
  if (isClarifyResult(result)) {
    return {
      ...script,
      chatStage: 'chatting',
      generated: false,
      messages: [
        ...script.messages,
        {
          id: options.messageId,
          role: 'ai',
          text: result.clarification.canGenerate
            ? `${result.reply}\n\n信息已经够了，可以点击“生成文案”写入左侧。`
            : result.reply,
        },
      ],
    }
  }

  const status = typeof result.status === 'string' ? result.status : 'agent_error'
  const code = readErrorCode(result)
  const message = readErrorMessage(result)
  return {
    ...script,
    chatStage: 'chatting',
    generated: false,
    messages: [
      ...script.messages,
      {
        id: options.messageId,
        role: 'ai',
        text: errorText(status, code, message),
      },
    ],
  }
}

export function mapScriptAgentResultToDraft(
  script: ScriptDraft,
  result: ScriptAgentClientResult | Record<string, unknown>,
  options: { messageId: string; successText?: string },
): ScriptDraft {
  if (isOkResult(result)) {
    const content = result.artifact.content
    return {
      ...script,
      chatStage: 'generated',
      generated: true,
      artifactId: result.artifact.artifactId,
      title: content.title,
      hook: content.hook,
      body: content.body,
      caption: content.caption,
      tags: content.tags,
      duration: `${content.durationSeconds} 秒`,
      messages: [
        ...script.messages,
        {
          id: options.messageId,
          role: 'ai',
          text: options.successText ?? '我已生成左侧文案。你可以继续手动编辑，确认后进入下一步。',
        },
      ],
    }
  }

  const status = typeof result.status === 'string' ? result.status : 'agent_error'
  const code = readErrorCode(result)
  const message = readErrorMessage(result)

  return {
    ...script,
    chatStage: 'chatting',
    generated: false,
    messages: [
      ...script.messages,
      {
        id: options.messageId,
        role: 'ai',
        text: errorText(status, code, message),
      },
    ],
  }
}

export function statusFromScriptAgentResult(result: ScriptAgentClientResult | undefined): ScriptAgentClientStatus {
  if (!result) return 'idle'
  if (result.status === 'ok') return 'done'
  if (result.status === 'needs_configuration') return 'needs_configuration'
  if (result.status === 'script_parse_error') return 'script_parse_error'
  return 'agent_error'
}

export function configurationNoticeFromScriptAgentResult(
  result: ScriptAgentClientResult | undefined,
): ScriptAgentConfigurationNotice | undefined {
  if (!result || result.status !== 'needs_configuration') return undefined

  const code = readErrorCode(result)
  const message = readErrorMessage(result)
  const fallback = {
    title: 'AI 后端需要先完成配置',
    detail: message,
    action: '请检查顶部设置页的模型 Provider，并确认本地后端可以运行。',
    errorCode: code,
  }

  if (code === 'no_default_provider') {
    return {
      title: '还没有默认模型 Provider',
      detail: message,
      action: '请到顶部设置页选择 OpenAI、DeepSeek 或本地 OpenAI-compatible 作为默认 Provider。',
      errorCode: code,
    }
  }

  if (code === 'provider_disabled') {
    return {
      title: '默认模型 Provider 已停用',
      detail: message,
      action: '请到顶部设置页启用默认 Provider，或切换到另一个可用 Provider。',
      errorCode: code,
    }
  }

  if (code === 'missing_credentials') {
    return {
      title: '默认模型 Provider 缺少凭据',
      detail: message,
      action: '请到顶部设置页补齐 API Key、Base URL 和模型名，再测试连接。',
      errorCode: code,
    }
  }

  if (code === 'unsupported_provider') {
    return {
      title: '当前 Provider 类型暂不支持',
      detail: message,
      action: '请切换到 OpenAI、DeepSeek、本地或自定义 OpenAI-compatible Provider。',
      errorCode: code,
    }
  }

  if (code === 'runtime_error') {
    return {
      title: '模型配置读取失败',
      detail: message,
      action: '请检查本地设置文件和桌面后端日志，然后重新打开应用。',
      errorCode: code,
    }
  }

  return fallback
}

function isOkResult(
  result: ScriptAgentClientResult | Record<string, unknown>,
): result is Extract<ScriptAgentClientResult, { artifact: { artifactId: string; content: ScriptArtifactContent } }> {
  return result.status === 'ok' && typeof result.artifact === 'object' && result.artifact !== null
}

function isClarifyResult(result: ScriptAgentClientResult | Record<string, unknown>): result is Extract<ScriptAgentClientResult, { turnType: 'clarify' }> {
  return result.status === 'ok' && result.turnType === 'clarify' && typeof result.reply === 'string'
}

function readErrorCode(result: Record<string, unknown>) {
  const error = result.error
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return 'unknown'
}

function readErrorMessage(result: Record<string, unknown>) {
  const error = result.error
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    return error.message
  }
  return '请稍后重试，或检查模型和后端配置。'
}

function errorText(status: string, code: string, message: string) {
  if (status === 'needs_configuration') {
    return `需要先完成 AI 后端配置（${code}）：${message}`
  }
  if (status === 'script_parse_error') {
    return `没有拿到可写入左侧的结构化文案（${code}）：${message}。你可以再点一次生成，或补充更明确的要求。`
  }
  return `这次生成失败（${code}）：${message}`
}
