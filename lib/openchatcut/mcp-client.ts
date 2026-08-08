import type { OpenChatCutError } from './types'

const ENDPOINT = 'http://127.0.0.1:5199/api/external-mcp/mcp'
const PROJECT_STORE_ENDPOINT = 'http://127.0.0.1:5199/api/project-store/entry'
const ALLOWED_TOOLS = new Set([
  'openchatcut_status', 'list_projects', 'create_project', 'target_project', 'get_editor_url',
  'begin_edit_session', 'get_edit_session', 'review_edit_session', 'discard_edit_session',
  'read_project', 'manage_timelines', 'edit_item', 'edit_captions',
  'track_progress',
])

export class OpenChatCutMcpError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'OpenChatCutMcpError'
  }
}

export class OpenChatCutMcpClient {
  private sessionId?: string
  private nextId = 1

  constructor(
    private options: { fetcher?: typeof fetch; bearerToken?: string; timeoutMs?: number } = {},
  ) {}

  async connect(options: { timeoutMs?: number } = {}) {
    return await this.connectWithSignal(this.transportSignal(options.timeoutMs))
  }

  private async connectWithSignal(signal: AbortSignal) {
    const result = await this.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'koubo-agent', version: '1.0.0' },
    }, false, signal)
    if (!this.sessionId) throw new OpenChatCutMcpError('session_missing', '专业剪辑器未返回有效会话。')
    await this.notify('notifications/initialized', signal)
    return result
  }

  async listTools() {
    this.assertConnected()
    const result = await this.request('tools/list', {}, true, this.transportSignal())
    const tools = asRecord(result).tools
    if (!Array.isArray(tools)) throw new OpenChatCutMcpError('invalid_response', '专业剪辑器工具列表格式无效。')
    return tools
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ) {
    this.assertConnected()
    if (!ALLOWED_TOOLS.has(name)) throw new OpenChatCutMcpError('tool_not_allowed', '该专业剪辑操作不在安全允许列表中。')
    const signal = this.transportSignal(options.timeoutMs)
    let raw: unknown
    try {
      raw = await this.request('tools/call', { name, arguments: args }, true, signal)
    } catch (error) {
      if (!(error instanceof OpenChatCutMcpError) || error.code !== 'mcp_session_expired') throw error
      this.sessionId = undefined
      await this.connectWithSignal(signal)
      raw = await this.request('tools/call', { name, arguments: args }, true, signal)
    }
    const result = asRecord(raw)
    if (result.isError === true) {
      const message = contentText(result.content) || '专业剪辑器执行失败。'
      throw new OpenChatCutMcpError('tool_error', message)
    }
    if (result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent as Record<string, unknown>
    const text = contentText(result.content)
    if (!text) return {}
    try { return asRecord(JSON.parse(text)) } catch { return { result: text } }
  }

  async getDurableEditSessionStatus(
    editorProjectId: string,
    editSessionId: string,
    options: { timeoutMs?: number } = {},
  ): Promise<{ editSessionId: string; status: string } | undefined> {
    const key = encodeURIComponent(`external-proposal:${editorProjectId}`)
    const headers: Record<string, string> = { accept: 'application/json' }
    if (this.options.bearerToken) headers.authorization = `Bearer ${this.options.bearerToken}`
    let response: Response
    try {
      response = await (this.options.fetcher ?? fetch)(
        `${PROJECT_STORE_ENDPOINT}?key=${key}`,
        {
          method: 'GET',
          headers,
          signal: this.transportSignal(options.timeoutMs),
        },
      )
    } catch (error) {
      throw normalizeTransportError(error)
    }
    if (response.status === 404) return undefined
    if (response.status === 401) {
      throw new OpenChatCutMcpError('auth_error', '专业剪辑器访问令牌不匹配。')
    }
    if (!response.ok) {
      throw new OpenChatCutMcpError('http_error', `专业剪辑器返回 HTTP ${response.status}。`)
    }
    let envelope: Record<string, unknown>
    try {
      envelope = asRecord(JSON.parse(await response.text()))
    } catch (error) {
      if (error instanceof OpenChatCutMcpError) throw error
      throw new OpenChatCutMcpError('invalid_response', '专业剪辑器持久会话状态格式无效。')
    }
    let value = envelope.value
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value)
      } catch {
        return undefined
      }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const durable = value as Record<string, unknown>
    const durableSessionId = typeof durable.sessionId === 'string' ? durable.sessionId : ''
    const status = typeof durable.status === 'string' ? durable.status : ''
    if (durableSessionId !== editSessionId || !status) return undefined
    return { editSessionId: durableSessionId, status }
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    requireSession = true,
    signal = this.transportSignal(),
  ) {
    if (requireSession) this.assertConnected()
    const id = this.nextId++
    const response = await this.send(
      { jsonrpc: '2.0', id, method, params },
      requireSession,
      signal,
    )
    let responseText: string
    try {
      responseText = await response.text()
    } catch (error) {
      throw normalizeTransportError(error)
    }
    const message = parseMcpResponse(responseText)
    if (message.error) throw new OpenChatCutMcpError('rpc_error', rpcMessage(message.error))
    if (message.id !== id) throw new OpenChatCutMcpError('invalid_response', '专业剪辑器响应标识不匹配。')
    return message.result
  }

  private async notify(method: string, signal: AbortSignal) {
    await this.send({ jsonrpc: '2.0', method }, true, signal)
  }

  private async send(payload: object, requireSession: boolean, signal: AbortSignal) {
    const headers: Record<string, string> = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    }
    if (requireSession && this.sessionId) headers['mcp-session-id'] = this.sessionId
    if (this.options.bearerToken) headers.authorization = `Bearer ${this.options.bearerToken}`
    let response: Response
    try {
      response = await (this.options.fetcher ?? fetch)(ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal,
      })
    } catch (error) {
      throw normalizeTransportError(error)
    }
    if (!response.ok) {
      if (response.status === 401) throw new OpenChatCutMcpError('auth_error', '专业剪辑器访问令牌不匹配。')
      if (response.status === 404 && requireSession) {
        throw new OpenChatCutMcpError('mcp_session_expired', '专业剪辑器会话已过期。')
      }
      throw new OpenChatCutMcpError('http_error', `专业剪辑器返回 HTTP ${response.status}。`)
    }
    const session = response.headers.get('mcp-session-id')
    if (!requireSession) {
      if (!session) throw new OpenChatCutMcpError('session_missing', '专业剪辑器握手失败。')
      this.sessionId = session
    }
    return response
  }

  private transportSignal(timeoutMs?: number) {
    return AbortSignal.timeout(timeoutMs ?? this.options.timeoutMs ?? 8_000)
  }

  private assertConnected() {
    if (!this.sessionId) throw new OpenChatCutMcpError('not_connected', '尚未连接专业剪辑器。')
  }
}

function normalizeTransportError(error: unknown) {
  if (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  ) {
    return new OpenChatCutMcpError('mcp_timeout', '专业剪辑器响应超时。')
  }
  return new OpenChatCutMcpError('network_error', '无法连接专业剪辑器，请先启动它。')
}

export function parseMcpResponse(text: string): Record<string, unknown> {
  const trimmed = text.trim()
  if (!trimmed) return {}
  if (trimmed.startsWith('{')) return asRecord(JSON.parse(trimmed))
  const data = trimmed.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter(Boolean)
  if (!data.length) throw new OpenChatCutMcpError('invalid_response', '专业剪辑器返回了无法识别的数据。')
  return asRecord(JSON.parse(data.at(-1)!))
}

export function isAllowedOpenChatCutTool(name: string) { return ALLOWED_TOOLS.has(name) }
function asRecord(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OpenChatCutMcpError('invalid_response', '专业剪辑器响应格式无效。')
  return value as Record<string, any>
}
function contentText(value: unknown) {
  if (!Array.isArray(value)) return ''
  return value.filter((item): item is { type: string; text: string } => Boolean(item && item.type === 'text' && typeof item.text === 'string')).map((item) => item.text).join('\n')
}
function rpcMessage(value: unknown) { return value && typeof value === 'object' && 'message' in value && typeof value.message === 'string' ? value.message : '专业剪辑器协议错误。' }
export function toOpenChatCutError(error: unknown): OpenChatCutError {
  return error instanceof OpenChatCutMcpError ? { code: error.code, message: error.message } : { code: 'unexpected_error', message: error instanceof Error ? error.message : '专业剪辑器发生未知错误。' }
}
