import { describe, expect, it, vi } from 'vitest'
import { isAllowedOpenChatCutTool, OpenChatCutMcpClient, parseMcpResponse } from './mcp-client'

describe('OpenChatCut MCP client', () => {
  it('parses JSON and SSE messages', () => {
    expect(parseMcpResponse('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}').result).toEqual({ ok: true })
    expect(parseMcpResponse('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n').result).toEqual({ ok: true })
  })

  it('handshakes and reads structured tool results', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id?: number; method: string }
      if (request.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-03-26' } }), { headers: { 'mcp-session-id': 'session-1' } })
      }
      if (request.method === 'notifications/initialized') return new Response('', { status: 202 })
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { structuredContent: { connected: true } } }))
    })
    const client = new OpenChatCutMcpClient({ fetcher: fetcher as typeof fetch })
    await client.connect()
    await expect(client.callTool('openchatcut_status')).resolves.toEqual({ connected: true })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('reads only the exact durable external edit session status', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toContain(
        'key=external-proposal%3Aproject-1',
      )
      expect(init).toMatchObject({
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: 'Bearer configured-token',
        },
      })
      return new Response(JSON.stringify({
        value: {
          sessionId: 'edit-session-1',
          status: 'awaiting_review',
          proposal: { privateContent: 'must-not-return' },
        },
      }))
    })
    const client = new OpenChatCutMcpClient({
      fetcher: fetcher as typeof fetch,
      bearerToken: 'configured-token',
    })

    await expect(client.getDurableEditSessionStatus(
      'project-1',
      'edit-session-1',
      { timeoutMs: 8_000 },
    )).resolves.toEqual({
      editSessionId: 'edit-session-1',
      status: 'awaiting_review',
    })
  })

  it('fails closed when an error result claims an untrusted structured session code', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id?: number; method: string }
      if (request.method === 'initialize') {
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: { protocolVersion: '2025-03-26' },
        }), { headers: { 'mcp-session-id': 'session-1' } })
      }
      if (request.method === 'notifications/initialized') return new Response('', { status: 202 })
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          isError: true,
          structuredContent: { code: 'session_not_found', data: { terminal: true } },
          content: [{ type: 'text', text: 'untrusted tool failure' }],
        },
      }))
    })
    const client = new OpenChatCutMcpClient({ fetcher: fetcher as typeof fetch })
    await client.connect()

    await expect(client.callTool('get_edit_session', {
      editorProjectId: 'project-1',
      editSessionId: 'session-1',
    })).rejects.toMatchObject({ code: 'tool_error' })
  })

  it('rejects tools outside the fixed allowlist', async () => {
    expect(isAllowedOpenChatCutTool('create_project')).toBe(true)
    expect(isAllowedOpenChatCutTool('read_project')).toBe(true)
    expect(isAllowedOpenChatCutTool('manage_timelines')).toBe(true)
    expect(isAllowedOpenChatCutTool('edit_item')).toBe(true)
    expect(isAllowedOpenChatCutTool('edit_captions')).toBe(true)
    expect(isAllowedOpenChatCutTool('track_progress')).toBe(true)
    expect(isAllowedOpenChatCutTool('transcribe_track')).toBe(false)
    expect(isAllowedOpenChatCutTool('delete_project')).toBe(false)
  })

  it('re-handshakes once and retries a tool call after a 404 expired session', async () => {
    let initialized = 0
    let toolCalls = 0
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id?: number; method: string }
      if (request.method === 'initialize') {
        initialized += 1
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }), {
          headers: { 'mcp-session-id': `session-${initialized}` },
        })
      }
      if (request.method === 'notifications/initialized') return new Response('', { status: 202 })
      toolCalls += 1
      if (toolCalls === 1) return new Response('expired', { status: 404 })
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: { structuredContent: { ok: true } },
      }))
    })
    const client = new OpenChatCutMcpClient({ fetcher: fetcher as typeof fetch })
    await client.connect()
    await expect(client.callTool('read_project')).resolves.toEqual({ ok: true })
    expect(initialized).toBe(2)
    expect(toolCalls).toBe(2)
  })

  it.each([
    ['missing session', async () => new Response('{"jsonrpc":"2.0","id":1,"result":{}}'), 'session_missing'],
    ['unauthorized', async () => new Response('denied', { status: 401 }), 'auth_error'],
    ['network', async () => { throw new Error('offline') }, 'network_error'],
    ['fetch timeout', async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    }, 'mcp_timeout'],
    ['rpc error', async (_url: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id: number }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { message: 'bad rpc' } }), {
        headers: { 'mcp-session-id': 'session-1' },
      })
    }, 'rpc_error'],
    ['wrong id', async () => new Response('{"jsonrpc":"2.0","id":99,"result":{}}', {
      headers: { 'mcp-session-id': 'session-1' },
    }), 'invalid_response'],
  ])('classifies %s during handshake', async (_label, fetcher, code) => {
    const client = new OpenChatCutMcpClient({ fetcher: fetcher as typeof fetch })
    await expect(client.connect()).rejects.toMatchObject({ code })
  })

  it('normalizes an aborted response body as a stable MCP timeout', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'mcp-session-id': 'session-1' }),
      text: async () => {
        throw new DOMException('The operation was aborted', 'AbortError')
      },
    }))
    const client = new OpenChatCutMcpClient({ fetcher: fetcher as unknown as typeof fetch })

    await expect(client.connect()).rejects.toMatchObject({
      code: 'mcp_timeout',
      message: '专业剪辑器响应超时。',
    })
  })

  it('keeps the default transport timeout at eight seconds', async () => {
    const controller = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    try {
      const fetcher = vi.fn(async () => {
        throw new Error('offline')
      })
      const client = new OpenChatCutMcpClient({ fetcher: fetcher as typeof fetch })

      await expect(client.connect()).rejects.toMatchObject({ code: 'network_error' })
      expect(timeout).toHaveBeenCalledWith(8_000)
    } finally {
      timeout.mockRestore()
    }
  })

  it('shares one per-call timeout across an expired-session handshake and retry', async () => {
    const signals: AbortSignal[] = []
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController()
      signals.push(controller.signal)
      expect(milliseconds).toBe(8_000)
      return controller.signal
    })
    let initialized = 0
    let toolCalls = 0
    const requestSignals: Array<AbortSignal | null | undefined> = []
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      requestSignals.push(init?.signal)
      const request = JSON.parse(String(init?.body)) as { id?: number; method: string }
      if (request.method === 'initialize') {
        initialized += 1
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {},
        }), { headers: { 'mcp-session-id': `session-${initialized}` } })
      }
      if (request.method === 'notifications/initialized') {
        return new Response('', { status: 202 })
      }
      toolCalls += 1
      if (toolCalls === 1) return new Response('expired', { status: 404 })
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: { structuredContent: { ok: true } },
      }))
    })
    try {
      const client = new OpenChatCutMcpClient({
        fetcher: fetcher as typeof fetch,
        timeoutMs: 95_000,
      })
      await client.connect({ timeoutMs: 8_000 })
      await expect(
        client.callTool('manage_timelines', {}, { timeoutMs: 8_000 }),
      ).resolves.toEqual({ ok: true })
      expect(initialized).toBe(2)
      expect(toolCalls).toBe(2)
      expect(signals).toHaveLength(2)
      expect(requestSignals.slice(0, 2)).toEqual([signals[0], signals[0]])
      expect(requestSignals.slice(2)).toEqual([
        signals[1],
        signals[1],
        signals[1],
        signals[1],
      ])
    } finally {
      timeout.mockRestore()
    }
  })
})
