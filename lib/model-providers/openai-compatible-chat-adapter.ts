import type { ResolvedModelProvider } from './model-provider-resolution'

export interface OpenAICompatibleChatInput {
  provider: ResolvedModelProvider
  system: string
  user: string
  fetcher?: typeof fetch
  timeoutMs?: number
  maxOutputTokens?: number
  maxCompletionTokens?: number
  temperature?: number
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high'
  thinkingMode?: 'enabled' | 'disabled'
  onUsage?: (usage: ModelChatUsage) => void
}

export interface ModelChatUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export class ModelChatError extends Error {
  constructor(
    public readonly code:
      | 'auth_error'
      | 'model_error'
      | 'quota_error'
      | 'timeout'
      | 'network_error'
      | 'invalid_response'
      | 'http_error',
    message: string,
  ) {
    super(message)
    this.name = 'ModelChatError'
  }
}

export async function requestOpenAICompatibleChat(input: OpenAICompatibleChatInput) {
  let endpoint: URL
  try {
    endpoint = new URL(`${input.provider.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`)
  } catch {
    throw new ModelChatError('http_error', '模型服务地址无效，请在设置页检查 Base URL。')
  }

  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(new Error('model_chat_timeout')),
    Math.max(1, input.timeoutMs ?? 60_000),
  )

  try {
    const response = await (input.fetcher ?? fetch)(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(input.provider.apiKey ? { authorization: `Bearer ${input.provider.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: input.provider.modelId,
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.user },
        ],
        stream: false,
        ...(input.maxOutputTokens === undefined
          ? {}
          : { max_tokens: Math.max(1, Math.floor(input.maxOutputTokens)) }),
        ...(input.maxCompletionTokens === undefined
          ? {}
          : { max_completion_tokens: Math.max(1, Math.floor(input.maxCompletionTokens)) }),
        ...(input.temperature === undefined
          ? {}
          : { temperature: Math.min(2, Math.max(0, input.temperature)) }),
        ...(input.reasoningEffort === undefined
          ? {}
          : { reasoning_effort: input.reasoningEffort }),
        ...(input.thinkingMode === undefined
          ? {}
          : { thinking: { type: input.thinkingMode } }),
      }),
    })

    if (response.status === 401 || response.status === 403) {
      throw new ModelChatError('auth_error', 'API Key 无效或没有调用权限。')
    }
    if (response.status === 404) {
      throw new ModelChatError('model_error', '模型或聊天接口不存在，请检查 Base URL 和模型名。')
    }
    if (response.status === 429) {
      throw new ModelChatError('quota_error', '模型服务配额不足或请求过于频繁。')
    }
    if (!response.ok) {
      throw new ModelChatError('http_error', `模型服务返回 HTTP ${response.status}。`)
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new ModelChatError('invalid_response', '模型服务返回了无法解析的数据。')
    }

    const content = readAssistantContent(payload)
    if (!content) {
      throw new ModelChatError('invalid_response', '模型服务没有返回有效文本。')
    }
    const usage = readUsage(payload)
    if (usage) input.onUsage?.(usage)
    return content
  } catch (error) {
    if (error instanceof ModelChatError) throw error
    if (controller.signal.aborted) {
      throw new ModelChatError('timeout', '模型响应超时，请稍后重试或切换更快的模型。')
    }
    throw new ModelChatError('network_error', '无法连接模型服务，请检查网络或本地模型是否已启动。')
  } finally {
    clearTimeout(timeout)
  }
}

function readUsage(payload: unknown): ModelChatUsage | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const usage = (payload as { usage?: unknown }).usage
  if (!usage || typeof usage !== 'object') return undefined
  const inputTokens = tokenCount((usage as { prompt_tokens?: unknown }).prompt_tokens)
  const outputTokens = tokenCount((usage as { completion_tokens?: unknown }).completion_tokens)
  const totalTokens = tokenCount((usage as { total_tokens?: unknown }).total_tokens)
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  }
}

function tokenCount(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}

function readAssistantContent(payload: unknown) {
  if (!payload || typeof payload !== 'object') return ''
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') return ''
  const message = (choices[0] as { message?: unknown }).message
  if (!message || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      const text = (part as { text?: unknown }).text
      return typeof text === 'string' ? text : ''
    })
    .join('')
    .trim()
}
