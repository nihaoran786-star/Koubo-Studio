import {
  desktopRuntimeEndpoint,
  type DesktopRuntimeHealthResult,
} from './desktop-runtime-health'

type Fetcher = typeof fetch

export function createDesktopRuntimeClient(fetcher: Fetcher = fetch) {
  return {
    health: async (input: { projectId: string }): Promise<DesktopRuntimeHealthResult> => {
      try {
        const response = await fetcher(desktopRuntimeEndpoint(input.projectId), {
          method: 'GET',
        })
        return (await response.json()) as DesktopRuntimeHealthResult
      } catch {
        return {
          status: 'unavailable',
          source: 'desktop_runtime',
          runtimeStatus: 'local_backend_missing',
          capabilities: [],
          requirements: [],
          error: {
            code: 'desktop_backend_missing',
            message: '当前页面无法连接项目后端。桌面端生产包需要 local backend 或 sidecar 承载 API。',
          },
        }
      }
    },
  }
}
