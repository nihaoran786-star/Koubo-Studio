import { describe, expect, it, vi } from 'vitest'
import { createBrowserPublishClient } from './browser-publish-client'

describe('browser publish client', () => {
  it('bootstraps the in-memory desktop token and sends only supervised actions', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/desktop/command-token') {
        return Response.json({ status: 'ready', source: 'desktop_command_auth', token: 'token-123' })
      }
      expect(new Headers(init?.headers).get('x-koubo-desktop-token')).toBe('token-123')
      return Response.json({ status: 'login_required', source: 'visible_browser', updatedAt: '2026-07-16T00:00:00.000Z' })
    }) as typeof fetch
    const client = createBrowserPublishClient(fetcher)
    await expect(client.open({ projectId: 'project-1', artifactId: 'publish-1', platformId: 'douyin' }))
      .resolves.toMatchObject({ status: 'login_required' })
    expect(fetcher).toHaveBeenLastCalledWith('/api/projects/project-1/browser-publish', expect.objectContaining({ method: 'POST' }))
  })
})
