import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPublishSnapshot, BrowserPublishTarget } from './browser'
import {
  handleBrowserPublishDelete,
  handleBrowserPublishPatch,
  handleBrowserPublishPost,
} from './browser-publish-route-handler'

const token = 'b'.repeat(32)

function desktopRequest(method: string, body?: unknown, tokenValue = token) {
  return new Request('http://127.0.0.1:3100/api/projects/project-1/browser-publish', {
    method,
    headers: {
      host: '127.0.0.1:3100',
      origin: 'http://127.0.0.1:3100',
      'sec-fetch-site': 'same-origin',
      'x-koubo-desktop-token': tokenValue,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function snapshot(status: BrowserPublishSnapshot['status']): BrowserPublishSnapshot {
  return { status, source: 'visible_browser', projectId: 'project-1', artifactId: 'publish-1', platformId: 'douyin', updatedAt: '2026-07-16T00:00:00.000Z' }
}

function service() {
  let current = snapshot('idle')
  return {
    getSnapshot: vi.fn(() => current),
    open: vi.fn(async (_target: BrowserPublishTarget) => (current = snapshot('login_required'))),
    refresh: vi.fn(async () => (current = snapshot('ready_to_fill'))),
    fill: vi.fn(async (_target?: BrowserPublishTarget) => (current = snapshot('awaiting_user_submit'))),
    close: vi.fn(async () => (current = snapshot('closed'))),
  }
}

describe('browser publish route handler', () => {
  beforeEach(() => {
    vi.stubEnv('KOUBO_DESKTOP_API_TOKEN', token)
    vi.stubEnv('KOUBO_BACKEND_PORT', '3100')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('opens a supervised browser session with a protected command', async () => {
    const fake = service()
    const response = await handleBrowserPublishPost(desktopRequest('POST', {
      artifactId: 'publish-1', platformId: 'douyin',
    }), 'project-1', fake)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ status: 'login_required' })
    expect(fake.open).toHaveBeenCalledWith({ projectId: 'project-1', artifactId: 'publish-1', platformId: 'douyin' })
  })

  it('has no final submit action', async () => {
    const response = await handleBrowserPublishPatch(desktopRequest('PATCH', { action: 'submit' }), 'project-1', service())
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_browser_action' } })
  })

  it('rejects a browser command without the random desktop token', async () => {
    const response = await handleBrowserPublishDelete(desktopRequest('DELETE', undefined, 'wrong'), 'project-1', service())
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_desktop_token' } })
  })
})
