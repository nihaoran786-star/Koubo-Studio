import type { PublishPackageArtifact } from '@/lib/artifacts/publish-package-artifact'
import { buildProjectApiEndpoint } from '@/lib/api/api-endpoint'
import { requestJson } from '@/lib/api/api-fetch'
import type { BrowserPublishReadiness } from './browser-publish-adapter'
import type { PublishAgentInput } from './publish-agent-service'

export type PublishAgentClientStatus = 'idle' | 'running' | 'ready' | 'invalid_request' | 'publish_error'

export type PublishAgentClientResult =
  | {
      status: 'ready'
      source: 'local_publish_package'
      artifact: PublishPackageArtifact
      nextStep: 'manual_browser_required'
    }
  | {
      status: 'invalid_request' | 'publish_error'
      source: string
      error: { code: string; message: string }
    }

type Fetcher = typeof fetch

export function publishAgentEndpoint(projectId: string) {
  return buildProjectApiEndpoint(projectId, '/publish-agent')
}

export function publishPackageEndpoint(projectId: string, artifactId: string) {
  return buildProjectApiEndpoint(projectId, `/publish-packages/${encodeURIComponent(artifactId)}`)
}

export function createPublishAgentClient(fetcher: Fetcher = fetch) {
  return {
    load: async (input: { projectId: string; artifactId: string }): Promise<PublishAgentClientResult> =>
      requestJson<PublishAgentClientResult>(publishPackageEndpoint(input.projectId, input.artifactId), {
        fetcher,
        fallback: (error) => ({ status: 'publish_error', source: 'desktop_runtime', error }),
      }),
    health: async (input: { projectId: string }): Promise<BrowserPublishReadiness> =>
      requestJson<BrowserPublishReadiness>(publishAgentEndpoint(input.projectId), {
        fetcher,
        init: { method: 'GET' },
        fallback: () => ({
          status: 'manual_required',
          source: 'visible_browser',
          supportedPlatforms: ['douyin', 'xiaohongshu'],
          message: '浏览器连接状态暂不可用；仍可先准备本地发布包。',
        }),
      }),
    prepare: async (input: {
      projectId: string
      sessionId: string
      input: PublishAgentInput
    }): Promise<PublishAgentClientResult> =>
      requestJson<PublishAgentClientResult>(publishAgentEndpoint(input.projectId), {
        fetcher,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: input.sessionId, input: input.input }),
        },
        fallback: (error) => ({ status: 'publish_error', source: 'desktop_runtime', error }),
      }),
  }
}

export function statusFromPublishAgentResult(result: PublishAgentClientResult | undefined): PublishAgentClientStatus {
  if (!result) return 'idle'
  return result.status
}
