'use client'

import { desktopCommandHeaders, DesktopCommandClientError } from '@/lib/api/desktop-command-client'
import type { PublishPlatformId } from '@/lib/artifacts/publish-package-artifact'
import type { BrowserPublishSnapshot } from './browser'

export function browserPublishEndpoint(projectId: string) {
  return `/api/projects/${encodeURIComponent(projectId)}/browser-publish`
}

export function createBrowserPublishClient(fetcher: typeof fetch = fetch) {
  async function request(projectId: string, init: RequestInit = {}) {
    try {
      const json = Boolean(init.body)
      const response = await fetcher(browserPublishEndpoint(projectId), {
        ...init,
        headers: { ...(await desktopCommandHeaders(fetcher, json)), ...init.headers },
      })
      const body = await response.json() as BrowserPublishSnapshot | { error?: { code?: string; message?: string } }
      if (!response.ok || !('status' in body)) {
        return failedSnapshot(body.error?.code || 'browser_command_failed', body.error?.message || '浏览器发布操作失败。')
      }
      return body
    } catch (error) {
      const code = error instanceof DesktopCommandClientError ? error.code : 'desktop_backend_missing'
      return failedSnapshot(code, error instanceof Error ? error.message : '无法连接桌面浏览器控制。')
    }
  }

  return {
    get: (projectId: string) => request(projectId),
    open: (input: { projectId: string; artifactId: string; platformId: PublishPlatformId }) => request(input.projectId, {
      method: 'POST', body: JSON.stringify({ artifactId: input.artifactId, platformId: input.platformId }),
    }),
    refresh: (projectId: string) => request(projectId, { method: 'PATCH', body: JSON.stringify({ action: 'refresh' }) }),
    fill: (input: { projectId: string; artifactId: string; platformId: PublishPlatformId }) => request(input.projectId, {
      method: 'PATCH', body: JSON.stringify({ action: 'fill', artifactId: input.artifactId, platformId: input.platformId }),
    }),
    close: (projectId: string) => request(projectId, { method: 'DELETE' }),
  }
}

function failedSnapshot(code: string, message: string): BrowserPublishSnapshot {
  return { status: 'failed', source: 'visible_browser', error: { code, message }, updatedAt: new Date().toISOString() }
}
